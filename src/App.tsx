// ─────────────────────────────────────────────────────────────────────────────
// App.tsx — Phase 3 Shell
//
// After the Phase 3 refactor App.tsx is a thin orchestration layer:
//   • Hosts global state that is ABOVE individual tabs
//     (showNewDocDialog, local pdfDoc for LeftSidePanel thumbnails).
//   • Owns file-IO callbacks that write to the Zustand store so the active
//     DocumentViewer can react via its pdfBytes useEffect.
//   • Renders the layout chrome (TopCommandCenter, TabBar, LeftSidePanel,
//     RightSidePanel, MarkupLedger) + the Ghost-Tab DocumentViewer stack.
//
// All PDF rendering and Konva logic has moved to DocumentViewer.tsx.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { invoke }      from '@tauri-apps/api/core';
import { listen }      from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

import { TopCommandCenter } from './components/TopCommandCenter';
import { TabBar }           from './components/TabBar';
import { LeftSidePanel }    from './components/LeftSidePanel';
import { RightSidePanel }   from './components/RightSidePanel';
import { MarkupLedger }     from './components/MarkupLedger';
import { CaptureOverlay }   from './components/CaptureOverlay';
import { NewDocumentDialog } from './components/NewDocumentDialog';
import { DocumentViewer }   from './components/DocumentViewer';
import { MasterPageEditor } from './components/MasterPageEditor';

import { useStore } from './store/useStore';
import { useShallow } from 'zustand/react/shallow';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { acquirePdfDoc, releasePdfDoc, destroyAllPdfDocs } from './utils/pdfDocumentManager';

// Worker URL is also set inside DocumentViewer; setting it here is idempotent
// and ensures it's ready before any App-level PDF loading (LeftSidePanel thumbnails).
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Root router ─────────────────────────────────────────────────────────────

export default function Root() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('capture') === 'true') return <CaptureOverlay />;
  return <App />;
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function PageNavigator({ pageNum, numPages, setPageNum }: { pageNum: number, numPages: number, setPageNum: (p: number) => void }) {
  const [val, setVal] = useState(pageNum.toString());
  useEffect(() => { setVal(pageNum.toString()); }, [pageNum]);

  const commit = () => {
    let p = parseInt(val);
    if (isNaN(p)) { setVal(pageNum.toString()); return; }
    if (p < 1) p = 1; if (p > numPages) p = numPages;
    setPageNum(p);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <button onClick={() => setPageNum(Math.max(1, pageNum - 1))} disabled={pageNum <= 1}
        style={{ background: 'transparent', border: 'none', color: pageNum <= 1 ? '#555' : '#ccc', cursor: pageNum <= 1 ? 'not-allowed' : 'pointer', fontSize: 18, padding: '0 6px', display: 'flex', alignItems: 'center' }}>‹</button>
      <input type="number" value={val} onChange={e => setVal(e.target.value)}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        style={{ width: 44, textAlign: 'center', background: '#0e0f11', border: '1px solid #333', color: '#e0e0e0', borderRadius: 4, padding: '4px 0', fontSize: 12, fontVariantNumeric: 'tabular-nums' }} />
      <span style={{ fontSize: 12, color: '#888', fontVariantNumeric: 'tabular-nums' }}>/ {numPages}</span>
      <button onClick={() => setPageNum(Math.min(numPages, pageNum + 1))} disabled={pageNum >= numPages}
        style={{ background: 'transparent', border: 'none', color: pageNum >= numPages ? '#555' : '#ccc', cursor: pageNum >= numPages ? 'not-allowed' : 'pointer', fontSize: 18, padding: '0 6px', display: 'flex', alignItems: 'center' }}>›</button>
    </div>
  );
}

/** Spread navigator: prev/next spread + active page indicator */
function SpreadNavigator({ spreadIndex, numSpreads, leftPage, rightPage, activeSide, onNav }: {
  spreadIndex: number; numSpreads: number;
  leftPage: number; rightPage: number | null; activeSide: 1 | 2;
  onNav: (idx: number) => void;
}) {
  const canPrev = spreadIndex > 0;
  const canNext = spreadIndex < numSpreads - 1;
  const isSolo = rightPage === null; // cover page or last odd page
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button onClick={() => canPrev && onNav(spreadIndex - 1)} disabled={!canPrev}
        style={{ background: 'transparent', border: 'none', color: canPrev ? '#ccc' : '#555', cursor: canPrev ? 'pointer' : 'not-allowed', fontSize: 18, padding: '0 6px', display: 'flex', alignItems: 'center' }}>{'<'}</button>
      {/* Left page pill */}
      <div style={{
        padding: '2px 8px', borderRadius: 4, fontSize: 11, fontVariantNumeric: 'tabular-nums',
        background: (isSolo || activeSide === 1) ? 'rgba(77,166,255,0.18)' : '#1a1b1f',
        color: (isSolo || activeSide === 1) ? '#4da6ff' : '#888',
        border: (isSolo || activeSide === 1) ? '1px solid #4da6ff' : '1px solid #2a2a2e',
        transition: 'all 0.15s',
      }}>p{leftPage}</div>
      {/* Spine + right page — only when it's a real spread */}
      {!isSolo && <>
        <div style={{ width: 3, height: 16, background: '#444', borderRadius: 1 }} />
        <div style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 11, fontVariantNumeric: 'tabular-nums',
          background: activeSide === 2 ? 'rgba(77,166,255,0.18)' : '#1a1b1f',
          color: activeSide === 2 ? '#4da6ff' : '#888',
          border: activeSide === 2 ? '1px solid #4da6ff' : '1px solid #2a2a2e',
          transition: 'all 0.15s',
        }}>p{rightPage}</div>
      </>}
      <span style={{ fontSize: 10, color: '#555' }}>({spreadIndex + 1}/{numSpreads})</span>
      <button onClick={() => canNext && onNav(spreadIndex + 1)} disabled={!canNext}
        style={{ background: 'transparent', border: 'none', color: canNext ? '#ccc' : '#555', cursor: canNext ? 'pointer' : 'not-allowed', fontSize: 18, padding: '0 6px', display: 'flex', alignItems: 'center' }}>{'>'}</button>
    </div>
  );
}

// ─── App shell ───────────────────────────────────────────────────────────────

function App() {
  const [showNewDocDialog, setShowNewDocDialog] = useState(false);


  // ── Store selectors ─────────────────────────────────────────────────────
  const {
    tabMetas, activeTabId,
    openTab,
    setPageNum,
    snapEnabled, showGuides,
    selectedGuideId, guideSelectionEnabled, snapSensitivity,
    editorMode, setEditorMode, masterPages, activeMasterPageId,
    vectorSnapEnabled, centerSnapEnabled,
    savingStatus,
  } = useStore(
    useShallow((s) => ({
      tabMetas: s.tabMetas,
      activeTabId: s.activeTabId,
      openTab: s.openTab,
      setPageNum: s.setPageNum,
      snapEnabled: s.snapEnabled,
      showGuides: s.showGuides,
      selectedGuideId: s.selectedGuideId,
      guideSelectionEnabled: s.guideSelectionEnabled,
      snapSensitivity: s.snapSensitivity,
      editorMode: s.editorMode,
      setEditorMode: s.setEditorMode,
      masterPages: s.masterPages,
      activeMasterPageId: s.activeMasterPageId,
      vectorSnapEnabled: s.vectorSnapEnabled,
      centerSnapEnabled: s.centerSnapEnabled,
      savingStatus: s.savingStatus,
    }))
  );

  const doc = useStore((s) => (s.activeTabId ? s.documents[s.activeTabId] : null));
  const guides = doc?.guides || [];

  const pdfBytes = doc?.pdfBytes;
  const pageNum = doc?.pageNum || 1;
  const numPages = doc?.numPages || 0;
  const isSpread = doc?.isSpread || false;
  const hasFrontCover = doc?.hasFrontCover || false;
  const hasBackCover = doc?.hasBackCover || false;
  const activeSpreadIndex = doc?.activeSpreadIndex || 0;
  const activeSide = doc?.activeSide || 1;

  // Spread page pairing logic
  const numSpreads = isSpread
    ? (hasFrontCover ? 1 + Math.ceil((numPages - 1) / 2) : Math.ceil(numPages / 2))
    : 0;
  const spreadLeftPage = isSpread
    ? (hasFrontCover ? (activeSpreadIndex === 0 ? 1 : activeSpreadIndex * 2) : activeSpreadIndex * 2 + 1)
    : pageNum;
  const spreadRightPage = isSpread
    ? (hasFrontCover ? (activeSpreadIndex === 0 ? -1 : activeSpreadIndex * 2 + 1) : spreadLeftPage + 1)
    : -1;
  const spreadHasRight = spreadRightPage > 0 && spreadRightPage <= numPages;

  // ── Guide location input state ──────────────────────────────────────────────────────────────
  const [guideLocInput, setGuideLocInput] = useState('');
  const [guideLocFocused, setGuideLocFocused] = useState(false);

  const selectedGuide = guides.find(g => g.id === selectedGuideId) ?? null;

  // Sync the input field with the currently selected guide's position (inches)
  useEffect(() => {
    if (selectedGuide && !guideLocFocused) {
      const W = doc?.pageWidth || 612;
      const H = doc?.pageHeight || 792;
      const origin = selectedGuide.origin || (selectedGuide.orientation === 'vertical' ? 'left' : 'top');
      const P = selectedGuide.position;

      let displayPosPoints = P;
      if (selectedGuide.orientation === 'vertical') {
        if (origin === 'left') {
          displayPosPoints = (isSpread && spreadHasRight && P >= W) ? P - W : P;
        } else if (origin === 'right') {
          displayPosPoints = (isSpread && spreadHasRight && P >= W) ? (W * 2) - P : W - P;
        } else if (origin === 'left-spread') {
          displayPosPoints = P;
        } else if (origin === 'right-spread') {
          displayPosPoints = (isSpread && spreadHasRight) ? (W * 2) - P : W - P;
        }
      } else {
        if (origin === 'bottom') {
          displayPosPoints = H - P;
        } else {
          displayPosPoints = P;
        }
      }

      setGuideLocInput((displayPosPoints / 72).toFixed(3));
    } else if (!selectedGuide) {
      setGuideLocInput('');
    }
  }, [
    selectedGuide?.id,
    selectedGuide?.position,
    selectedGuide?.origin,
    guideLocFocused,
    doc?.pageWidth,
    doc?.pageHeight,
    isSpread,
    spreadHasRight
  ]);

  /** Parse and apply a guide position from user input. Supports in (default) and mm. */
  const applyGuideLocation = (raw: string) => {
    if (!selectedGuide || !doc) return;
    const s = raw.trim();
    let inches: number | null = null;
    const mmMatch = s.match(/^([\.\d-]+)\s*mm$/i);
    if (mmMatch) {
      inches = parseFloat(mmMatch[1]) / 25.4;
    } else {
      const numMatch = s.match(/^([\.\d-]+)/);
      if (numMatch) inches = parseFloat(numMatch[1]);
    }
    if (inches === null || isNaN(inches)) return;
    const valPoints = inches * 72;

    const W = doc.pageWidth || 612;
    const H = doc.pageHeight || 792;
    const origin = selectedGuide.origin || (selectedGuide.orientation === 'vertical' ? 'left' : 'top');
    const P_current = selectedGuide.position;

    let P = valPoints;
    if (selectedGuide.orientation === 'vertical') {
      if (origin === 'left') {
        P = (isSpread && spreadHasRight && P_current >= W) ? valPoints + W : valPoints;
      } else if (origin === 'right') {
        P = (isSpread && spreadHasRight && P_current >= W) ? (W * 2) - valPoints : W - valPoints;
      } else if (origin === 'left-spread') {
        P = valPoints;
      } else if (origin === 'right-spread') {
        P = (isSpread && spreadHasRight) ? (W * 2) - valPoints : W - valPoints;
      }
    } else {
      if (origin === 'bottom') {
        P = H - valPoints;
      } else {
        P = valPoints;
      }
    }

    useStore.getState().updateGuide(selectedGuide.id, P);
  };

  // ── Shared helper: place an image data-URL onto the active canvas ────────────
  const placeImageOnCanvas = (dataUrl: string, naturalW: number, naturalH: number) => {
    const state = useStore.getState();
    const aid = state.activeTabId;
    if (!aid || !state.documents[aid]) return;
    const docState = state.documents[aid];
    const maxDim = 600;
    const ratio = Math.min(maxDim / naturalW, maxDim / naturalH, 1);
    const w = (naturalW * ratio) / docState.scale;
    const h = (naturalH * ratio) / docState.scale;
    state.addCustomAsset(dataUrl);
    state.addShape({
      id: Math.random().toString(36).substring(7),
      type: 'image',
      x: 200 / docState.scale,
      y: 200 / docState.scale,
      width: w,
      height: h,
      imageUrl: dataUrl,
      strokeColor: 'transparent',
      strokeWidth: 0,
      page: docState.pageNum,
      author: 'User',
      date: new Date().toLocaleDateString(),
      comments: 'Inserted Image',
    });
  };

  // ── Local pdfDoc for LeftSidePanel page-thumbnail rendering ─────────────────
  // LeftSidePanel needs a PDFDocumentProxy to render thumbnails.  We derive one
  // here from the root-proxy pdfBytes (always the active tab's bytes) so that
  // LeftSidePanel doesn't need any knowledge of DocumentViewer internals.
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);

  useEffect(() => {
    if (!pdfBytes) { setPdfDoc(null); return; }
    let cancelled = false;
    acquirePdfDoc(pdfBytes)
      .then(pdf => { if (!cancelled) setPdfDoc(pdf); })
      .catch(() => { if (!cancelled) setPdfDoc(null); });
    return () => { cancelled = true; releasePdfDoc(pdfBytes); };
  }, [pdfBytes]);

  useEffect(() => {
    const onUnload = () => destroyAllPdfDocs();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // ── File-IO callbacks ───────────────────────────────────────────────────────



  /**
   * Replace the active document with new PDF bytes.
   * Used by LeftSidePanel (page insert/delete) and handleNewBlankDocument.
   */
  const handleInsertPages = async (mergedBuffer: ArrayBuffer, afterIndex?: number, numInserted?: number, isInsideSpread = false) => {
    const state = useStore.getState();
    const cloned = new Uint8Array(mergedBuffer.slice(0));
    
    // 1. Push to history first
    state.pushPageChangeToHistory();
    
    // 2. Shift shapes and master assignments in store if we are inserting at index
    if (afterIndex !== undefined && numInserted !== undefined) {
      if (isInsideSpread) {
        state.insertPagesInsideSpread(afterIndex, numInserted);
      } else {
        state.insertPagesAt(afterIndex, numInserted);
      }
    }
    
    // 3. Update PDF bytes
    state.setPdfBytes(cloned);
    
    // 4. Update page count
    try {
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(cloned);
      state.setNumPages(doc.getPageCount());

      // Auto-navigate to the first inserted page
      if (afterIndex !== undefined) {
        const docState = state.documents[state.activeTabId!];
        if (docState) {
          if (docState.isSpread) {
            const hasCover = docState.hasFrontCover ?? false;
            const targetPage = afterIndex + 1;
            let idx = 0;
            if (hasCover) {
              idx = targetPage === 1 ? 0 : Math.floor(targetPage / 2);
            } else {
              idx = Math.floor((targetPage - 1) / 2);
            }
            state.setActiveSpreadIndex(idx);
          } else {
            state.setPageNum(afterIndex + 1);
          }
        }
      }
    } catch (err) {
      console.error('Failed to update page count after insert:', err);
    }
  };

  /**
   * Create a blank document at the specified page size and open it in a NEW tab.
   * Called from NewDocumentDialog (via both the "+" button and TopCommandCenter → New).
   * When isSpread=true and numPages>1, creates a multi-page PDF and activates spread mode.
   */
  const handleNewBlankDocument = async (widthPt = 595.28, heightPt = 841.89, isSpread = false, numPages = 1, hasFrontCover = false, hasBackCover = false) => {
    const newTabId = `tab-${Date.now()}`;
    openTab(newTabId, { label: isSpread ? 'New Spread Doc' : 'New Document', isDirty: false });
    useStore.getState().setPdfBytes(null);
    setShowNewDocDialog(false);
    try {
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      const pageCount = Math.max(1, numPages);
      for (let i = 0; i < pageCount; i++) {
        doc.addPage([widthPt, heightPt]);
      }
      const bytes = await doc.save();
      await handleInsertPages(bytes.buffer as ArrayBuffer);
      if (isSpread) {
        useStore.getState().setIsSpread(true);
        if (hasFrontCover) useStore.getState().setHasFrontCover(true);
        if (hasBackCover) useStore.getState().setHasBackCover(true);
      }
    } catch (err) {
      console.error('Failed to create blank document:', err);
      alert('Could not create blank document.');
    }
  };

  const handleDeletePage = async (pageIndex: number) => {
    const state = useStore.getState();
    const bytes = state.activeTabId ? state.documents[state.activeTabId]?.pdfBytes : null;
    if (!bytes) return;
    try {
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(new Uint8Array(bytes.slice(0)));
      if (doc.getPageCount() <= 1) { alert('Cannot delete the only remaining page.'); return; }
      
      const docState = state.documents[state.activeTabId!];
      const isFrontCover = pageIndex === 0 && docState?.hasFrontCover;
      const isBackCover = pageIndex === (docState?.numPages - 1) && docState?.hasBackCover;

      // 1. Push to history
      state.pushPageChangeToHistory();
      
      // 2. Remove from PDF
      doc.removePage(pageIndex);
      const savedBytes = await doc.save();
      const cloned = new Uint8Array(savedBytes.buffer as ArrayBuffer);
      
      // 3. Remove shapes on page and shift other shapes/assignments
      state.deletePageAt(pageIndex);
      
      // 4. Update PDF bytes and total pages
      state.setPdfBytes(cloned);
      state.setNumPages(doc.getPageCount());

      // 5. Toggle covers off if they were deleted
      if (isFrontCover) {
        state.setHasFrontCover(false);
      }
      if (isBackCover) {
        state.setHasBackCover(false);
      }
      
      // 6. Constrain current pageNum
      const currentPageNum = state.documents[state.activeTabId!]?.pageNum || 1;
      if (currentPageNum > doc.getPageCount()) {
        state.setPageNum(doc.getPageCount());
      }
    } catch (err) { alert('Failed to delete page: ' + String(err)); }
  };

  const handleDeleteSpread = async (leftIndex: number, rightIndex: number | null) => {
    if (rightIndex !== null) {
      await handleDeletePage(rightIndex);
    }
    await handleDeletePage(leftIndex);
  };

  const handleResizePage = async (pageIndex: number | undefined, widthPt: number, heightPt: number) => {
    const state = useStore.getState();
    const docState = state.activeTabId ? state.documents[state.activeTabId] : null;
    const bytes = docState?.pdfBytes;
    if (!bytes || !docState) return;

    try {
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(new Uint8Array(bytes.slice(0)));
      
      let pagesToResize: number[] = [];
      if (pageIndex !== undefined) {
         pagesToResize.push(pageIndex - 1);
      } else {
         const idx = docState.activeSpreadIndex || 0;
         const hasFrontCover = docState.hasFrontCover || false;
         let leftIdx = hasFrontCover ? (idx === 0 ? 0 : idx * 2 - 1) : idx * 2;
         let rightIdx = hasFrontCover ? (idx === 0 ? null : idx * 2) : leftIdx + 1;
         
         pagesToResize.push(leftIdx);
         if (rightIdx !== null && rightIdx < doc.getPageCount()) {
            pagesToResize.push(rightIdx);
         }
      }

      state.pushPageChangeToHistory();

      for (let i of pagesToResize) {
         if (i >= 0 && i < doc.getPageCount()) {
            const page = doc.getPage(i);
            page.setSize(widthPt, heightPt);
         }
      }

      const savedBytes = await doc.save();
      state.setPdfBytes(new Uint8Array(savedBytes.buffer as ArrayBuffer));
      
    } catch(err) {
      alert('Failed to resize page(s): ' + String(err));
    }
  };

  const handleAddBlankPage = async (afterIndex: number, widthPt?: number, heightPt?: number, numPages = 1, isInsideSpread = false) => {
    const state = useStore.getState();
    const bytes = state.activeTabId ? state.documents[state.activeTabId]?.pdfBytes : null;
    if (!bytes) return;
    try {
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(new Uint8Array(bytes.slice(0)));
      
      const refPage = doc.getPage(Math.min(afterIndex, doc.getPageCount() - 1));
      const size = refPage.getSize();
      const existingW = size.width;
      const existingH = size.height;

      let pw = widthPt !== undefined ? widthPt : existingW;
      let ph = heightPt !== undefined ? heightPt : existingH;

      for (let i = 0; i < numPages; i++) {
        doc.insertPage(afterIndex + i, [pw, ph]);
      }
      
      await handleInsertPages((await doc.save()).buffer as ArrayBuffer, afterIndex, numPages, isInsideSpread);
    } catch (err) { alert('Failed to add blank page: ' + String(err)); }
  };

  // ── Multi-monitor snipping (Tauri IPC) ──────────────────────────────────────

  const handleStartSnip = async () => {
    try {
      await invoke('capture_all_monitors');
      const monitors = await invoke<any[]>('get_monitors');
      const captureWindows: WebviewWindow[] = [];
      for (const m of monitors) {
        const sanitizedName = m.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const label = `cap-${sanitizedName}-${Math.random().toString(36).substring(7)}`;
        captureWindows.push(new WebviewWindow(label, {
          url: `index.html?capture=true&monitorName=${encodeURIComponent(m.name)}`,
          x: m.x, y: m.y, width: m.width, height: m.height,
          fullscreen: true, alwaysOnTop: true, transparent: true,
          decorations: false, skipTaskbar: true, shadow: false,
        }));
      }
      const stopAll = async () => {
        unSnipDone(); unSnipCancel();
        for (const w of captureWindows) { try { await w.close(); } catch { /* ignore */ } }
      };
      const unSnipDone = await listen('snippet-completed', async (event: any) => {
        handleSnipCapture(event.payload.image, event.payload.w, event.payload.h);
        stopAll();
      });
      const unSnipCancel = await listen('snippet-cancelled', stopAll);
    } catch (err) {
      console.error('Snipping orchestration failed:', err);
      alert('Failed to start snipping tool.');
    }
  };

  const handleSnipCapture = (image: string, w: number, h: number) => {
    const state = useStore.getState();
    const activeTabId = state.activeTabId;
    if (!activeTabId || !state.documents[activeTabId]) return;
    const docState = state.documents[activeTabId];
    // Add to global asset library so it appears in the Assets tab
    state.addCustomAsset(image);
    state.addShape({
      id: Math.random().toString(36).substring(7),
      type: 'image',
      x: 150 / docState.scale, y: 150 / docState.scale,
      width: w / docState.scale, height: h / docState.scale,
      imageUrl: image,
      strokeColor: 'transparent', strokeWidth: 0,
      page: docState.pageNum, author: 'Snipping Engine',
      date: new Date().toLocaleDateString(), comments: 'Screen Capture',
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  const tabIds = Object.keys(tabMetas);

  const activeSaveTabId = Object.keys(savingStatus || {}).find(id => (savingStatus || {})[id]) || null;
  const activeSaveStatus = activeSaveTabId ? (savingStatus || {})[activeSaveTabId] : null;
  const activeSaveMeta = activeSaveTabId ? tabMetas[activeSaveTabId] : null;

  return (
    <div className="app-container">
      {activeSaveStatus && (
        <div style={{
          height: 4,
          width: '100%',
          background: '#1a1b1f',
          position: 'relative',
          zIndex: 999999,
          flexShrink: 0,
        }}>
          <div style={{
            height: '100%',
            width: `${activeSaveStatus.progress}%`,
            background: 'linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%)',
            transition: 'width 0.1s ease-out',
            boxShadow: '0 0 8px #60a5fa',
          }} />
          {/* Small floating status text */}
          <div style={{
            position: 'absolute',
            right: 12,
            top: 6,
            fontSize: 10,
            color: '#888',
            zIndex: 1000000,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <span style={{ fontWeight: 600, color: '#ccc' }}>
              {activeSaveStatus.mode === 'export' ? 'Exporting' : 'Saving'} "{activeSaveMeta?.label || 'Document'}":
            </span>
            <span style={{ color: '#4da6ff', fontWeight: 700 }}>{activeSaveStatus.progress}%</span>
          </div>
        </div>
      )}


      {/* New-document configuration dialog */}
      {showNewDocDialog && (
        <NewDocumentDialog
          onClose={() => setShowNewDocDialog(false)}
          onCreate={(w, h, spread, pages, frontCover, backCover) => handleNewBlankDocument(w, h, spread, pages, frontCover, backCover)}
        />
      )}

      <TopCommandCenter
        onSnip={handleStartSnip}
        onNewDocument={() => setShowNewDocDialog(true)}
        onInsertImage={placeImageOnCanvas}
      />

      {/* Tab bar — '+' triggers the NewDocumentDialog */}
      {(editorMode as any) !== 'master' && <TabBar onNewTab={() => setShowNewDocDialog(true)} />}

      <div className="main-content">
        {(editorMode as any) === 'master' ? (
          <MasterPageEditor />
        ) : (
          <LeftSidePanel
            pdfDoc={pdfDoc}
            pageNum={pageNum}
            setPageNum={setPageNum}
            isSpread={isSpread}
            hasFrontCover={hasFrontCover}
            hasBackCover={hasBackCover}
            activeSpreadIndex={activeSpreadIndex}
            setActiveSpreadIndex={(idx: number) => useStore.getState().setActiveSpreadIndex(idx)}
            getRawPdfBytes={() => {
              const state = useStore.getState();
              return state.activeTabId ? state.documents[state.activeTabId]?.pdfBytes : null;
            }}
            onInsertPages={handleInsertPages}
            onDeletePage={handleDeletePage}
            onDeleteSpread={handleDeleteSpread}
            onAddBlankPage={handleAddBlankPage}
            onResizePage={handleResizePage}
          />
        )}

        {/* ── Center Workspace ── */}
        {(editorMode as any) === 'master' ? (
          activeMasterPageId ? (
            <DocumentViewer
              key={`__master__${activeMasterPageId}`}
              tabId={`__master__${activeMasterPageId}`}
              isActive={true}
            />
          ) : (
            <main className="workspace">
              <div className="empty-state">
                <p>No master page selected.</p>
                <br/>
                <p>Click <strong>+ New Master</strong> on the left to create a master page, or select an existing one.</p>
              </div>
            </main>
          )
        ) : (
          <>
            {/* Ghost Tab stack */}
            {tabIds.map(tabId => (
              <DocumentViewer
                key={tabId}
                tabId={tabId}
                isActive={tabId === activeTabId}
              />
            ))}

            {/* Fallback when all tabs are closed */}
            {tabIds.length === 0 && (
              <main className="workspace">
                <div className="empty-state">
                  <p>Click <strong>+</strong> to create a new document, or use <strong>File → Open</strong> to load a PDF.</p>
                  <br/>
                  <p>Please open a PDF to start working.</p>
                </div>
              </main>
            )}
          </>
        )}

        <RightSidePanel />
      </div>

      {/* Persistent Bottom Status Bar underneath workspace and panels */}
      {editorMode !== 'master' && (
        <div style={{ height: 40, display: 'flex', alignItems: 'center', background: '#1e1f23', borderTop: '1px solid #2a2a2e', padding: '0 12px', zIndex: 100, flexShrink: 0, gap: 8, overflow: 'hidden' }}>

         {/* Center: Page Navigator */}
         <div style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto' }}>
           {pdfBytes && numPages > 0 && (
             isSpread
               ? <SpreadNavigator
                   spreadIndex={activeSpreadIndex}
                   numSpreads={numSpreads}
                   leftPage={spreadLeftPage}
                   rightPage={spreadHasRight ? spreadRightPage : null}
                   activeSide={activeSide}
                   onNav={(idx) => useStore.getState().setActiveSpreadIndex(idx)}
                 />
               : <PageNavigator pageNum={pageNum} numPages={pdfDoc?.numPages || numPages} setPageNum={setPageNum} />
           )}
         </div>

         {/* Spacer */}
         <div style={{ flex: 1 }} />

         {/* Right: Guide controls + toggles — scrollable so it never wraps */}
         <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto', overflowX: 'auto', maxWidth: '80vw' }}>

           {/* Snap Sensitivity (inline number input) */}
           <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 4 }}>
             <span style={{ color: '#555', fontSize: 10 }}>Snap px</span>
             <input
               type="number" min={1} max={100}
               value={snapSensitivity}
               onChange={(e) => useStore.getState().setSnapSensitivity(parseInt(e.target.value) || 10)}
               style={{
                 width: 40, background: '#151618', border: '1px solid #2e2e35',
                 color: '#aaa', borderRadius: 4, padding: '3px 4px',
                 fontSize: 10, textAlign: 'center',
               }}
             />
           </div>

           {/* Guide Location input */}
           <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
             <span style={{ color: '#555', fontSize: 10, whiteSpace: 'nowrap' }}>Guide pos</span>
             {selectedGuide && (
               <select
                 value={selectedGuide.origin || (selectedGuide.orientation === 'vertical' ? 'left' : 'top')}
                 onChange={(e) => {
                   const newOrigin = e.target.value as any;
                   useStore.getState().updateGuide(selectedGuide.id, selectedGuide.position, { origin: newOrigin });
                 }}
                 style={{
                   background: '#1a1b20',
                   border: '1px solid #3a3a45',
                   color: '#e0e0e0',
                   borderRadius: 4,
                   padding: '2px 4px',
                   fontSize: 10,
                   cursor: 'pointer',
                   height: 20,
                   outline: 'none',
                 }}
               >
                 {selectedGuide.orientation === 'vertical' ? (
                   <>
                     <option value="left">Left (Page)</option>
                     <option value="right">Right (Page)</option>
                     {isSpread && spreadHasRight && (
                       <>
                         <option value="left-spread">Left (Spread)</option>
                         <option value="right-spread">Right (Spread)</option>
                       </>
                     )}
                   </>
                 ) : (
                   <>
                     <option value="top">Top</option>
                     <option value="bottom">Bottom</option>
                   </>
                 )}
               </select>
             )}
             <input
               type="text"
               value={guideLocInput}
               disabled={!selectedGuide}
               placeholder={selectedGuide ? '' : '—'}
               onChange={(e) => setGuideLocInput(e.target.value)}
               onFocus={() => setGuideLocFocused(true)}
               onBlur={() => { setGuideLocFocused(false); applyGuideLocation(guideLocInput); }}
               onKeyDown={(e) => {
                 if (e.key === 'Enter') {
                   applyGuideLocation(guideLocInput);
                   (e.target as HTMLInputElement).blur();
                 }
               }}
               title={selectedGuide
                 ? `${selectedGuide.orientation === 'horizontal' ? 'Distance from top' : 'Distance from left'} edge of page. Enter value in inches (e.g. 2.5) or mm (e.g. 63.5mm).`
                 : 'Select a guide to set its position'}
               style={{
                 width: 68, background: selectedGuide ? '#1a1b20' : '#111314',
                 border: `1px solid ${selectedGuide ? '#3a3a45' : '#1e1e22'}`,
                 color: selectedGuide ? '#e0e0e0' : '#383840',
                 borderRadius: 4, padding: '3px 6px', fontSize: 10,
                 cursor: selectedGuide ? 'text' : 'default',
               }}
             />
             <span style={{ color: '#444', fontSize: 10 }}>in/mm</span>
           </div>

            {/* Master Pages button */}
            <button
              id="master-pages-toggle-btn"
              onClick={() => setEditorMode((editorMode as any) === 'master' ? 'document' : 'master')}
              title="Open Master Page Editor"
              style={{
                background: (editorMode as any) === 'master' ? 'rgba(245,158,11,0.2)' : '#26272c',
                color: (editorMode as any) === 'master' ? '#f59e0b' : '#ccc',
                border: `1px solid ${(editorMode as any) === 'master' ? '#f59e0b' : '#333'}`,
                padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                fontWeight: (editorMode as any) === 'master' ? 700 : 400,
                transition: 'all 0.15s ease',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <span style={{ opacity: 0.7 }}>📄</span>
              {`Masters${masterPages.length > 0 ? ` (${masterPages.length})` : ''}`}
            </button>

           {/* Guide Select toggle */}
           <button
             onClick={() => useStore.getState().toggleGuideSelection()}
             title="Enable clicking to select/move guides"
             style={{
               background: guideSelectionEnabled ? 'rgba(255, 149, 0, 0.18)' : '#26272c',
               color: guideSelectionEnabled ? '#ff9500' : '#999',
               border: `1px solid ${guideSelectionEnabled ? '#ff9500' : '#333'}`,
               padding: '4px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
               fontWeight: guideSelectionEnabled ? 600 : 400,
               transition: 'all 0.15s ease',
             }}
           >{`Guide Sel: ${guideSelectionEnabled ? 'ON' : 'OFF'}`}</button>

           {/* Guides toggle */}
           <button
             onClick={() => useStore.getState().toggleShowGuides()}
             style={{
               background: showGuides ? 'rgba(77, 166, 255, 0.18)' : '#26272c',
               color: showGuides ? '#4da6ff' : '#ccc',
               border: `1px solid ${showGuides ? '#4da6ff' : '#333'}`,
               padding: '4px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
               fontWeight: showGuides ? 600 : 400,
               transition: 'all 0.15s ease',
             }}
           >{`Guides: ${showGuides ? 'ON' : 'OFF'}`}</button>

           {/* Snap toggle */}
           <button
             onClick={() => useStore.getState().toggleSnap()}
             style={{
               background: snapEnabled ? 'rgba(77, 166, 255, 0.18)' : '#26272c',
               color: snapEnabled ? '#4da6ff' : '#ccc',
               border: `1px solid ${snapEnabled ? '#4da6ff' : '#333'}`,
               padding: '4px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
               fontWeight: snapEnabled ? 600 : 400,
               transition: 'all 0.15s ease',
             }}
           >{`Snap: ${snapEnabled ? 'ON' : 'OFF'}`}</button>

           {/* Vector Snap toggle */}
           <button
             onClick={() => useStore.getState().toggleVectorSnap()}
             style={{
               background: vectorSnapEnabled ? 'rgba(16, 185, 129, 0.18)' : '#26272c',
               color: vectorSnapEnabled ? '#10b981' : '#ccc',
               border: `1px solid ${vectorSnapEnabled ? '#10b981' : '#333'}`,
               padding: '4px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
               fontWeight: vectorSnapEnabled ? 600 : 400,
               transition: 'all 0.15s ease',
             }}
           >{`Vector Snap: ${vectorSnapEnabled ? 'ON' : 'OFF'}`}</button>

           {/* Centre Snap toggle */}
           <button
             onClick={() => useStore.getState().toggleCenterSnap()}
             title="Snap shapes to the horizontal and vertical centre lines of each page"
             style={{
               background: centerSnapEnabled ? 'rgba(251, 146, 60, 0.18)' : '#26272c',
               color: centerSnapEnabled ? '#fb923c' : '#ccc',
               border: `1px solid ${centerSnapEnabled ? '#fb923c' : '#333'}`,
               padding: '4px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
               fontWeight: centerSnapEnabled ? 600 : 400,
               transition: 'all 0.15s ease',
             }}
           >{`Centre Snap: ${centerSnapEnabled ? 'ON' : 'OFF'}`}</button>

         </div>
        </div>
      )}

      {/* Persistent bottom markup ledger */}
      {editorMode !== 'master' && <MarkupLedger />}
    </div>
  );
}

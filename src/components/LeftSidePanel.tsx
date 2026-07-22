import { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useStore, type ShapeData } from '../store/useStore';
import { renderShapesOnCanvas } from '../utils/canvasRenderer';
import { isLineMark } from './MarksRenderer';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { NewDocumentDialog } from './NewDocumentDialog';
import { InsertPdfPagesDialog } from './InsertPdfPagesDialog';
import { getSpreads } from '../utils/spreadLayout';
import { duplicateSpreadCrossingShapes } from '../utils/pdfExporter';


export function LeftSidePanel({ pdfDoc, pageNum, setPageNum, isSpread, hasFrontCover, hasBackCover, activeSpreadIndex, setActiveSpreadIndex, onInsertPages, onDeletePage, onDeleteSpread, onAddBlankPage }: any) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<'Thumbnails' | 'Bookmarks' | 'Layers'>('Thumbnails');

  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [pendingInsertContext, setPendingInsertContext] = useState<{ afterIndex: number, isInsideSpread: boolean } | null>(null);

  // Page-picker dialog state
  const [pdfPickerState, setPdfPickerState] = useState<{
    srcBytes: ArrayBuffer;
    isSrcSpread: boolean;
    afterIndex: number;
    isInsideSpread: boolean;
  } | null>(null);

  const { activeTabId, documents, setLayerVisible, setSelectedShapeIds } = useStore();

  
  const doc = activeTabId ? documents[activeTabId] : null;
  const shapes = doc?.shapes || [];
  const selectedShapeIds = doc?.selectedShapeIds || [];
  const layersVisible = doc?.layersVisible || { base: true, active: true, chest: true };


  const baseCanvasesRef = useRef<HTMLCanvasElement[]>([]);
  const prevPageShapesJsonRef = useRef<Record<number, string>>({});
  const masterBgCanvasesRef = useRef<Record<string, HTMLCanvasElement>>({});

  const getPageSideInSpread = (pNum: number, isSpreadMode: boolean, cover: boolean): 'left' | 'right' => {
    if (!isSpreadMode) return 'left';
    if (cover) {
      if (pNum === 1) return 'left';
      return pNum % 2 === 0 ? 'left' : 'right';
    } else {
      return pNum % 2 !== 0 ? 'left' : 'right';
    }
  };

  const getOrLoadMasterBgCanvas = async (master: any, scale: number) => {
    const key = `${master.id}_${master.backgroundPageNum}`;
    if (masterBgCanvasesRef.current[key]) {
      return masterBgCanvasesRef.current[key];
    }
    if (!master.backgroundPdfBytes) return null;
    try {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(master.backgroundPdfBytes.slice(0)) }).promise;
      const pageIdx = Math.max(1, Math.min(master.backgroundPageNum, pdf.numPages));
      const page = await pdf.getPage(pageIdx);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      masterBgCanvasesRef.current[key] = canvas;
      return canvas;
    } catch (err) {
      console.error("Error loading master background PDF:", err);
      return null;
    }
  };

  const getMasterShapesForPage = (master: any, isRight: boolean, pageW: number, pageH: number) => {
    const offsetX = (pageW - master.pageWidth) / 2;
    const offsetY = (pageH - master.pageHeight) / 2;
    
    const filtered: ShapeData[] = [];
    
    master.shapes.forEach((shape: ShapeData) => {
      if (master.isSpread) {
        if (isRight) {
          if (shape.x >= master.pageWidth) {
            const shiftX = offsetX - master.pageWidth;
            filtered.push({
              ...shape,
              x: shape.x + shiftX,
              y: shape.y + offsetY,
              points: shape.points ? (
                isLineMark(shape.type)
                  ? shape.points
                  : shape.points.map((pt, idx) => idx % 2 === 0 ? pt + shiftX : pt + offsetY)
              ) : undefined
            });
          }
        } else {
          if (shape.x < master.pageWidth) {
            filtered.push({
              ...shape,
              x: shape.x + offsetX,
              y: shape.y + offsetY,
              points: shape.points ? (
                isLineMark(shape.type)
                  ? shape.points
                  : shape.points.map((pt, idx) => idx % 2 === 0 ? pt + offsetX : pt + offsetY)
              ) : undefined
            });
          }
        }
      } else {
        filtered.push({
          ...shape,
          x: shape.x + offsetX,
          y: shape.y + offsetY,
          points: shape.points ? (
            isLineMark(shape.type)
              ? shape.points
              : shape.points.map((pt, idx) => idx % 2 === 0 ? pt + offsetX : pt + offsetY)
          ) : undefined
        });
      }
    });
    
    return filtered;
  };

  useEffect(() => {
    if (!pdfDoc) {
      baseCanvasesRef.current = [];
      prevPageShapesJsonRef.current = {};
      masterBgCanvasesRef.current = {};
      setThumbnails([]);
      return;
    }
    let cancelled = false;
    const cacheBasePages = async () => {
      const canvases: HTMLCanvasElement[] = [];
      const initialThumbs: string[] = [];
      prevPageShapesJsonRef.current = {};
      
      // Pre-fetch viewport widths for all pages to duplicate crossing shapes correctly
      const mockOriginalPages: any[] = [];
      try {
        for (let p = 1; p <= pdfDoc.numPages; p++) {
          const page = await pdfDoc.getPage(p);
          const vp = page.getViewport({ scale: 1.0 });
          mockOriginalPages.push({
            getSize: () => ({ width: vp.width })
          });
        }
      } catch (err) {
        console.error("Error pre-fetching page viewports:", err);
      }

      const duplicatedShapes = duplicateSpreadCrossingShapes(
        shapes,
        isSpread,
        hasFrontCover,
        pdfDoc.numPages,
        mockOriginalPages
      );
      
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        if (cancelled) return;
        try {
          const page = await pdfDoc.getPage(i);
          const vp = page.getViewport({ scale: 0.25 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          const ctx = canvas.getContext('2d')!;
          await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
          canvases.push(canvas);
          
          const pageW = canvas.width / 0.25;
          const pageH = canvas.height / 0.25;
          
          const masterId = doc?.masterPageAssignments?.[i] ?? null;
          const master = masterId ? (doc?.masterPages || []).find(m => m.id === masterId) : null;
          
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = canvas.width;
          tempCanvas.height = canvas.height;
          const tempCtx = tempCanvas.getContext('2d')!;
          
          tempCtx.fillStyle = '#ffffff';
          tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
          
          if (master?.backgroundPdfBytes) {
            const bgCanvas = await getOrLoadMasterBgCanvas(master, 0.25);
            if (bgCanvas) {
              const isRight = getPageSideInSpread(i, isSpread, hasFrontCover) === 'right';
              if (master.isSpread) {
                const sw = bgCanvas.width / 2;
                const sh = bgCanvas.height;
                const sx = isRight ? bgCanvas.width / 2 : 0;
                const sy = 0;
                const dw = master.pageWidth * 0.25;
                const dh = master.pageHeight * 0.25;
                const dx = ((pageW - master.pageWidth) / 2) * 0.25;
                const dy = ((pageH - master.pageHeight) / 2) * 0.25;
                tempCtx.drawImage(bgCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
              } else {
                const sw = bgCanvas.width;
                const sh = bgCanvas.height;
                const sx = 0;
                const sy = 0;
                const dw = master.pageWidth * 0.25;
                const dh = master.pageHeight * 0.25;
                const dx = ((pageW - master.pageWidth) / 2) * 0.25;
                const dy = ((pageH - master.pageHeight) / 2) * 0.25;
                tempCtx.drawImage(bgCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
              }
            }
          }
          
          tempCtx.drawImage(canvas, 0, 0);
          
          if (master) {
            const isRight = getPageSideInSpread(i, isSpread, hasFrontCover) === 'right';
            const masterShapes = getMasterShapesForPage(master, isRight, pageW, pageH);
            await renderShapesOnCanvas(tempCtx, masterShapes, 0.25, true);
          }
          
          const pageShapes = duplicatedShapes.filter((s: ShapeData) => s.page === i);
          const cacheObj = {
            pageShapes,
            masterId,
            masterName: master?.name,
            masterShapes: master?.shapes,
            masterBgPdf: master?.backgroundPdfBytes ? master.backgroundPdfBytes.length : 0,
            masterBgPageNum: master?.backgroundPageNum
          };
          prevPageShapesJsonRef.current[i] = JSON.stringify(cacheObj);
          await renderShapesOnCanvas(tempCtx, pageShapes, 0.25, true);
          
          initialThumbs.push(tempCanvas.toDataURL('image/jpeg', 0.7));
          if (!cancelled) setThumbnails([...initialThumbs]);
        } catch (err) {
          console.error("Error caching page thumbnail:", err);
          canvases.push(null as any);
          initialThumbs.push('');
          if (!cancelled) setThumbnails([...initialThumbs]);
        }
      }
      if (!cancelled) {
        baseCanvasesRef.current = canvases;
      }
    };
    cacheBasePages();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, doc?.masterPageAssignments, doc?.masterPages, isSpread, hasFrontCover]);

  useEffect(() => {
    if (!pdfDoc || baseCanvasesRef.current.length === 0) return;
    
    let cancelled = false;
    const updateWithShapes = async () => {
      const updatedThumbs = [...thumbnails];
      let changed = false;
      
      const mockOriginalPages = baseCanvasesRef.current.map(canvas => {
        const width = canvas ? canvas.width / 0.25 : 612;
        return {
          getSize: () => ({ width })
        };
      });
      
      const duplicatedShapes = duplicateSpreadCrossingShapes(
        shapes,
        isSpread,
        hasFrontCover,
        pdfDoc.numPages,
        mockOriginalPages
      );
      
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const baseCanvas = baseCanvasesRef.current[i - 1];
        if (!baseCanvas) continue;
        
        const masterId = doc?.masterPageAssignments?.[i] ?? null;
        const master = masterId ? (doc?.masterPages || []).find(m => m.id === masterId) : null;
        
        const pageShapes = duplicatedShapes.filter((s: ShapeData) => s.page === i);
        const cacheObj = {
          pageShapes,
          masterId,
          masterName: master?.name,
          masterShapes: master?.shapes,
          masterBgPdf: master?.backgroundPdfBytes ? master.backgroundPdfBytes.length : 0,
          masterBgPageNum: master?.backgroundPageNum
        };
        const shapesJson = JSON.stringify(cacheObj);
        
        if (prevPageShapesJsonRef.current[i] === shapesJson && updatedThumbs[i - 1]) {
          continue;
        }
        
        prevPageShapesJsonRef.current[i] = shapesJson;
        
        const pageW = baseCanvas.width / 0.25;
        const pageH = baseCanvas.height / 0.25;
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = baseCanvas.width;
        tempCanvas.height = baseCanvas.height;
        const tempCtx = tempCanvas.getContext('2d')!;
        
        tempCtx.fillStyle = '#ffffff';
        tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        
        if (master?.backgroundPdfBytes) {
          const bgCanvas = await getOrLoadMasterBgCanvas(master, 0.25);
          if (bgCanvas) {
            const isRight = getPageSideInSpread(i, isSpread, hasFrontCover) === 'right';
            if (master.isSpread) {
              const sw = bgCanvas.width / 2;
              const sh = bgCanvas.height;
              const sx = isRight ? bgCanvas.width / 2 : 0;
              const sy = 0;
              const dw = master.pageWidth * 0.25;
              const dh = master.pageHeight * 0.25;
              const dx = ((pageW - master.pageWidth) / 2) * 0.25;
              const dy = ((pageH - master.pageHeight) / 2) * 0.25;
              tempCtx.drawImage(bgCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
            } else {
              const sw = bgCanvas.width;
              const sh = bgCanvas.height;
              const sx = 0;
              const sy = 0;
              const dw = master.pageWidth * 0.25;
              const dh = master.pageHeight * 0.25;
              const dx = ((pageW - master.pageWidth) / 2) * 0.25;
              const dy = ((pageH - master.pageHeight) / 2) * 0.25;
              tempCtx.drawImage(bgCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
            }
          }
        }
        
        tempCtx.drawImage(baseCanvas, 0, 0);
        
        if (master) {
          const isRight = getPageSideInSpread(i, isSpread, hasFrontCover) === 'right';
          const masterShapes = getMasterShapesForPage(master, isRight, pageW, pageH);
          await renderShapesOnCanvas(tempCtx, masterShapes, 0.25, true);
        }
        
        await renderShapesOnCanvas(tempCtx, pageShapes, 0.25, true);
        
        const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.7);
        updatedThumbs[i - 1] = dataUrl;
        changed = true;
      }
      
      if (changed && !cancelled) {
        setThumbnails(updatedThumbs);
      }
    };
    
    updateWithShapes();
    return () => {
      cancelled = true;
    };
  }, [shapes, pdfDoc, thumbnails.length, doc?.masterPageAssignments, doc?.masterPages, isSpread, hasFrontCover]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleInsertClick = async (afterIndex: number, isInsideSpread = false) => {
    try {
      // 1. Open file picker
      const selected = await open({
        multiple: false,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
      if (!selected || Array.isArray(selected)) return;

      const srcBytes = await readFile(selected as string);
      const arrayBuffer = srcBytes.buffer as ArrayBuffer;

      // 2. Detect if the source PDF is a Layers spread document by checking metadata
      let isSrcSpread = false;
      try {
        const srcPdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) }).promise;
        const metadata = await srcPdf.getMetadata();
        const info = metadata?.info as any;
        if (info?.Subject?.startsWith('LAYERS_MARKUP_DATA:')) {
          const raw = JSON.parse(info.Subject.substring('LAYERS_MARKUP_DATA:'.length));
          isSrcSpread = !!(raw?.spreadConfig?.isSpread);
        }
      } catch { /* not a Layers PDF or no metadata — fine */ }

      // 3. Show page picker dialog
      setPdfPickerState({ srcBytes: arrayBuffer, isSrcSpread, afterIndex, isInsideSpread });
    } catch (err) {
      console.error(err);
      alert('Failed to open PDF.');
    }
  };

  /**
   * Called after the user confirms page selection in InsertPdfPagesDialog.
   * Merges selected pages from the source PDF into the current document at afterIndex.
   * For spread source pages, each spread pair (left+right A4) is combined into one wide page.
   */
  const handlePagePickerConfirm = async (selectedPageIndices: number[]) => {
    if (!pdfPickerState || selectedPageIndices.length === 0) {
      setPdfPickerState(null);
      return;
    }

    const { srcBytes, isSrcSpread, afterIndex, isInsideSpread } = pdfPickerState;
    setPdfPickerState(null);

    try {
      const { PDFDocument } = await import('pdf-lib');

      // Load source PDF (strip LAYERS_MARKUP_DATA metadata to avoid corrupting
      // the receiving document's spread/layout state on load)
      const srcDoc = await PDFDocument.load(new Uint8Array(srcBytes.slice(0)), { ignoreEncryption: true });
      srcDoc.setSubject(''); // Strip embedded markup data

      // Load the current document
      const state = useStore.getState();
      const currentBytes = state.activeTabId ? state.documents[state.activeTabId]?.pdfBytes : null;
      if (!currentBytes) { alert('No active document to insert into.'); return; }

      const destDoc = await PDFDocument.load(new Uint8Array(currentBytes.slice(0)));

      const numInserted = isSrcSpread
        ? Math.ceil(selectedPageIndices.length / 2)  // Each spread pair → 1 wide page
        : selectedPageIndices.length;

      if (isSrcSpread) {
        // ── Spread mode: merge each pair of pages into one wide page ──────────
        // selectedPageIndices come in pairs: [0,1], [2,3], etc. (0-based)
        const pairs: number[][] = [];
        for (let i = 0; i < selectedPageIndices.length; i += 2) {
          pairs.push([selectedPageIndices[i], selectedPageIndices[i + 1]]);
        }

        for (let pairIdx = 0; pairIdx < pairs.length; pairIdx++) {
          const [leftIdx, rightIdx] = pairs[pairIdx];
          const insertAt = afterIndex + pairIdx;

          // Embed left page
          const [embeddedLeft] = await destDoc.embedPages([srcDoc.getPage(leftIdx)]);
          const leftSize = srcDoc.getPage(leftIdx).getSize();

          // Embed right page (may not exist for odd-page spread PDFs)
          const hasRight = rightIdx !== undefined && rightIdx < srcDoc.getPageCount();
          let embeddedRight: Awaited<ReturnType<typeof destDoc.embedPages>>[0] | null = null;
          let rightSize = leftSize;
          if (hasRight) {
            [embeddedRight] = await destDoc.embedPages([srcDoc.getPage(rightIdx)]);
            rightSize = srcDoc.getPage(rightIdx).getSize();
          }

          // Create wide page: width = left + right, height = max of both
          const pageWidth = leftSize.width + (hasRight ? rightSize.width : 0);
          const pageHeight = Math.max(leftSize.height, hasRight ? rightSize.height : 0);
          const widePage = destDoc.insertPage(insertAt, [pageWidth, pageHeight]);

          // Draw left page at origin
          widePage.drawPage(embeddedLeft, {
            x: 0, y: 0,
            width: leftSize.width, height: leftSize.height,
          });

          // Draw right page adjacent to left
          if (hasRight && embeddedRight) {
            widePage.drawPage(embeddedRight, {
              x: leftSize.width, y: 0,
              width: rightSize.width, height: rightSize.height,
            });
          }
        }
      } else {
        // ── Regular single-page mode: copy selected pages one by one ──────────
        const [copiedPages] = [await destDoc.copyPages(srcDoc, selectedPageIndices)];
        for (let i = 0; i < copiedPages.length; i++) {
          destDoc.insertPage(afterIndex + i, copiedPages[i]);
        }
      }

      const mergedBytes = await destDoc.save();
      onInsertPages(mergedBytes.buffer as ArrayBuffer, afterIndex, numInserted, isInsideSpread);
    } catch (err) {
      console.error(err);
      alert('Failed to insert PDF pages: ' + String(err));
    }
  };



  if (isCollapsed) {
    return (
      <div style={{ width: 28, flexShrink: 0, background: '#16171a', borderRight: '1px solid #111', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10 }}>
        <button onClick={() => setIsCollapsed(false)} title="Expand" style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 12 }}>▶</button>
      </div>
    );
  }

  const pageMarkups = shapes.filter((s: ShapeData) => s.page === pageNum);

  const tabBtn = (t: string) => ({
    flex: 1, padding: '8px 4px', background: 'none', border: 'none',
    borderBottom: activeTab === t ? '2px solid #4da6ff' : '2px solid transparent',
    color: activeTab === t ? '#4da6ff' : '#666',
    fontWeight: activeTab === t ? 600 : 400,
    fontSize: 11, cursor: 'pointer', transition: 'all 0.15s',
  } as React.CSSProperties);

  const IconBtn = ({ title, onClick, children, danger }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) => (
    <button
      title={title} onClick={onClick}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        color: danger ? '#ef4444' : '#555',
        padding: '2px 5px', borderRadius: 4, fontSize: 12,
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = danger ? '#ff6b6b' : '#aaa'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = danger ? '#ef4444' : '#555'; }}
    >
      {children}
    </button>
  );

  return (
    <>
      {pendingInsertContext && (
        <NewDocumentDialog
          mode="insert"
          insertType={pendingInsertContext.isInsideSpread ? 'inside_spread' : 'add_spread'}
          defaultIsSpread={isSpread}
          insertDocumentIsSpread={isSpread}
          onClose={() => setPendingInsertContext(null)}
          onCreate={(w, h, _spr, num, _fc, _bc) => {
            onAddBlankPage(
              pendingInsertContext.afterIndex,
              w, h,
              num,
              pendingInsertContext.isInsideSpread
            );
            setPendingInsertContext(null);
          }}
        />
      )}

      {/* PDF page picker dialog */}
      {pdfPickerState && (
        <InsertPdfPagesDialog
          srcPdfBytes={pdfPickerState.srcBytes}
          isSrcSpread={pdfPickerState.isSrcSpread}
          onConfirm={handlePagePickerConfirm}
          onClose={() => setPdfPickerState(null)}
        />
      )}

      <aside style={{ width: 190, flexShrink: 0, background: '#16171a', borderRight: '1px solid #111', display: 'flex', flexDirection: 'column', fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #111', background: '#1a1b1f', flexShrink: 0 }}>
          {(['Thumbnails', 'Bookmarks', 'Layers'] as const).map(t => (
            <button key={t} style={tabBtn(t)} onClick={() => setActiveTab(t)}>
              {t === 'Thumbnails' ? 'Thumbs' : t}
            </button>
          ))}
          <button onClick={() => setIsCollapsed(true)} title="Collapse" style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', padding: '8px 8px', fontSize: 11, flexShrink: 0 }}>◀</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
          {activeTab === 'Thumbnails' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {isSpread ? (
                (() => {
                  const spreads: React.ReactNode[] = [];

                  // 1. Add Front Cover page button at the top if missing
                  if (!hasFrontCover) {
                    spreads.push(
                      <div key="add-front-page-btn-container" style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, paddingBottom: 12, borderBottom: '1px dashed #2a2a2e' }}>
                        <button
                          onClick={() => {
                            useStore.getState().setHasFrontCover(true);
                            onAddBlankPage(0, undefined, undefined, 1, false);
                          }}
                          style={{
                            background: 'rgba(77,166,255,0.08)',
                            border: '1px dashed #4da6ff',
                            color: '#4da6ff',
                            borderRadius: 6,
                            padding: '8px 16px',
                            cursor: 'pointer',
                            fontSize: 10,
                            fontWeight: 600,
                            width: '100%',
                            textAlign: 'center',
                            transition: 'all 0.15s'
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.15)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.08)'; }}
                        >
                          + Add Front Page (Cover)
                        </button>
                      </div>
                    );
                  }

                  const activeSpreads = getSpreads(thumbnails.length, hasFrontCover, hasBackCover);
                  
                  activeSpreads.forEach((spread) => {
                    const spreadIdx = spread.index;
                    const left = spread.pages[0] - 1; // 0-indexed page index
                    const right = spread.pages.length > 1 ? spread.pages[1] - 1 : null;
                    const isActive = activeSpreadIndex === spreadIdx;
                    const isSolo = right === null;
                    const isFrontCoverSolo = hasFrontCover && spreadIdx === 0 && isSolo;
                      
                      // For a front cover, the single page is physically on the right.
                      // For a back cover, the single page is physically on the left.
                      const renderLeftPage = !isFrontCoverSolo;
                      const renderRightPage = !isSolo || isFrontCoverSolo;

                      // The actual page index for the left side of the thumbnail view
                      const leftPageIndex = isFrontCoverSolo ? null : left;
                      // The actual page index for the right side of the thumbnail view
                      const rightPageIndex = isFrontCoverSolo ? left : right;

                      spreads.push(
                        <div key={spreadIdx} style={{ display: 'flex', flexDirection: 'column', padding: '12px 0 16px 0', borderBottom: '1px solid #222' }}>
                          <div style={{ display: 'flex', alignItems: 'center', width: '100%', paddingBottom: 6 }}>
                            <span style={{ flex: 1, fontSize: 10, fontWeight: 600, color: isActive ? '#4da6ff' : '#666', paddingLeft: 4 }}>
                               {isSolo ? `Spread (p. ${left + 1})` : `Spread (pp. ${left + 1}–${right! + 1})`}
                            </span>
                            <IconBtn title="Delete spread" onClick={() => isSolo ? onDeletePage(left) : onDeleteSpread(left, right)} danger>🗑</IconBtn>
                          </div>
                          
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', position: 'relative' }}>
                            {/* LEFT HALF */}
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                              {renderLeftPage ? (
                                <>
                                  <div onClick={() => setActiveSpreadIndex(spreadIdx)} style={{ width: '100%', border: isActive ? '2px solid #4da6ff' : '2px solid #2a2a2e', borderRadius: 5, overflow: 'hidden', cursor: 'pointer', background: '#fff' }}>
                                    {thumbnails[leftPageIndex!] ? <img src={thumbnails[leftPageIndex!]} style={{ width: '100%', display: 'block' }} /> : <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{leftPageIndex! + 1}</div>}
                                  </div>
                                  <div style={{ fontSize: 10, color: '#888', paddingTop: 4 }}>p. {leftPageIndex! + 1}</div>
                                </>
                              ) : (
                                <>
                                  <div style={{ width: '100%', border: '2px solid transparent', borderRadius: 5, overflow: 'hidden', background: '#0a0a0c', opacity: 0.5 }}>
                                    <div style={{ height: 60 }}></div>
                                  </div>
                                  <div style={{ fontSize: 10, color: 'transparent', paddingTop: 4 }}>-</div>
                                </>
                              )}
                            </div>

                            {/* SPINE */}
                            <div style={{ width: 1, background: '#222', alignSelf: 'stretch', margin: '0 2px', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                               {!isSolo && (
                                 <button title="Insert pages inside" onClick={() => setPendingInsertContext({ afterIndex: left + 1, isInsideSpread: true })} style={{ position: 'absolute', width: 20, height: 20, borderRadius: '50%', background: '#4da6ff', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>+</button>
                               )}
                            </div>

                            {/* RIGHT HALF */}
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                              {renderRightPage ? (
                                <>
                                  <div onClick={() => setActiveSpreadIndex(spreadIdx)} style={{ width: '100%', border: isActive ? '2px solid #4da6ff' : '2px solid #2a2a2e', borderRadius: 5, overflow: 'hidden', cursor: 'pointer', background: '#fff' }}>
                                    {thumbnails[rightPageIndex!] ? <img src={thumbnails[rightPageIndex!]} style={{ width: '100%', display: 'block' }} /> : <div style={{ height: 60, background: '#1a1b1f' }}></div>}
                                  </div>
                                  <div style={{ fontSize: 10, color: '#888', paddingTop: 4 }}>p. {rightPageIndex! + 1}</div>
                                </>
                              ) : (
                                <>
                                  <div style={{ width: '100%', border: '2px solid transparent', borderRadius: 5, overflow: 'hidden', background: '#0a0a0c', opacity: 0.5 }}>
                                    <div style={{ height: 60 }}></div>
                                  </div>
                                  <div style={{ fontSize: 10, color: 'transparent', paddingTop: 4 }}>-</div>
                                </>
                              )}
                            </div>
                          </div>

                        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                           <button onClick={() => setPendingInsertContext({ afterIndex: isSolo ? left + 1 : right! + 1, isInsideSpread: false })} style={{ background: '#1e1f23', border: '1px dashed #444', color: '#888', borderRadius: 4, padding: '4px 16px', cursor: 'pointer', fontSize: 10 }}>+ Add Spread</button>
                        </div>
                      </div>
                    );
                  });

                  // 2. Add Back Cover page button at the bottom if missing
                  if (!hasBackCover) {
                    spreads.push(
                      <div key="add-back-page-btn-container" style={{ display: 'flex', justifyContent: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px dashed #2a2a2e' }}>
                        <button
                          onClick={() => {
                            useStore.getState().setHasBackCover(true);
                            onAddBlankPage(thumbnails.length, undefined, undefined, 1, false);
                          }}
                          style={{
                            background: 'rgba(77,166,255,0.08)',
                            border: '1px dashed #4da6ff',
                            color: '#4da6ff',
                            borderRadius: 6,
                            padding: '8px 16px',
                            cursor: 'pointer',
                            fontSize: 10,
                            fontWeight: 600,
                            width: '100%',
                            textAlign: 'center',
                            transition: 'all 0.15s'
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.15)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.08)'; }}
                        >
                          + Add Back Page (Cover)
                        </button>
                      </div>
                    );
                  }

                  return spreads;
                })()
              ) : (
                thumbnails.map((thumb, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div onClick={() => setPageNum(i + 1)} style={{ width: '100%', border: pageNum === i + 1 ? '2px solid #4da6ff' : '2px solid #2a2a2e', borderRadius: 5, overflow: 'hidden', cursor: 'pointer', background: '#fff' }}>
                      {thumb ? <img src={thumb} style={{ width: '100%', display: 'block' }} /> : <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', width: '100%', paddingTop: 3, paddingBottom: 2 }}>
                      <span style={{ flex: 1, fontSize: 10, color: pageNum === i + 1 ? '#4da6ff' : '#555', paddingLeft: 2 }}>Page {i + 1}</span>
                      <IconBtn title="Delete page" onClick={() => onDeletePage(i)} danger>🗑</IconBtn>
                    </div>
                    <div style={{ display: 'flex', gap: 3, width: '100%', marginBottom: 6 }}>
                      <button onClick={() => setPendingInsertContext({ afterIndex: i + 1, isInsideSpread: false })} style={{ flex: 1, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#666', borderRadius: 4, padding: '2px 0', cursor: 'pointer', fontSize: 10 }}>+ Blank</button>
                      <button onClick={() => handleInsertClick(i + 1, false)} style={{ flex: 1, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#666', borderRadius: 4, padding: '2px 0', cursor: 'pointer', fontSize: 10 }}>+ PDF</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}


          {/* ── BOOKMARKS ── */}
          {activeTab === 'Bookmarks' && (
            <div>
              {!pdfDoc ? <span style={{ color: '#444', fontSize: 11 }}>No PDF loaded.</span> : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  <li style={{ fontWeight: 600, color: '#888', marginBottom: 8, fontSize: '11px' }}>
                    Page {pageNum} Markups ({pageMarkups.length})
                  </li>
                  {pageMarkups.length === 0 && <span style={{ color: '#444', fontSize: '11px', paddingLeft: 8 }}>None on this page.</span>}
                  {pageMarkups.map((m: ShapeData) => (
                    <li key={m.id}
                      onClick={() => setSelectedShapeIds([m.id])}
                      style={{
                        padding: '5px 8px', cursor: 'pointer',
                        background: selectedShapeIds.includes(m.id) ? 'rgba(77,166,255,0.15)' : 'transparent',
                        color: selectedShapeIds.includes(m.id) ? '#4da6ff' : '#888',
                        borderRadius: 4, fontSize: '11px', marginBottom: 2,
                        borderLeft: selectedShapeIds.includes(m.id) ? '2px solid #4da6ff' : '2px solid transparent',
                      }}>
                      {m.type.toUpperCase()} — {m.id.slice(0, 6)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ── LAYERS ── */}
          {activeTab === 'Layers' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {([
                { key: 'base',   label: 'Base PDF',        dot: '#4da6ff' },
                { key: 'active', label: 'Markups',         dot: '#ef4444' },
                { key: 'chest',  label: 'Tool Chest',      dot: '#a78bfa' },
              ] as const).map(({ key, label, dot }) => (
                <div key={key}
                  onClick={() => setLayerVisible(key, !layersVisible[key])}
                  style={{
                    cursor: 'pointer', padding: '7px 8px',
                    background: '#1e1f23', borderRadius: 5,
                    display: 'flex', alignItems: 'center', gap: 8,
                    border: '1px solid #2a2a2e', transition: 'all 0.13s',
                    opacity: layersVisible[key] ? 1 : 0.45,
                  }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: layersVisible[key] ? '#ccc' : '#555', flex: 1 }}>{label}</span>
                  <span style={{ fontSize: 10, color: layersVisible[key] ? '#4da6ff' : '#444' }}>{layersVisible[key] ? '●' : '○'}</span>
                </div>
              ))}
            </div>
          )}

        </div>
      </aside>
    </>
  );
}

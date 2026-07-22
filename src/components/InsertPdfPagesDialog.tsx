import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import * as pdfjsLib from 'pdfjs-dist';

interface Props {
  srcPdfBytes: ArrayBuffer;
  /** True when the source PDF was created by Layers with isSpread=true */
  isSrcSpread: boolean;
  onConfirm: (selectedIndices: number[]) => void;
  onClose: () => void;
}

/**
 * Modal that shows thumbnails of each page (or spread pair) in `srcPdfBytes`
 * and lets the user pick which ones to insert into the current document.
 *
 * For spread PDFs each "item" represents a spread (2 pages).
 * For regular PDFs each "item" represents a single page.
 */
export function InsertPdfPagesDialog({ srcPdfBytes, isSrcSpread, onConfirm, onClose }: Props) {
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const cancelledRef = useRef(false);

  /* ── Render page thumbnails from the source PDF ── */
  useEffect(() => {
    cancelledRef.current = false;
    const generate = async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(srcPdfBytes.slice(0)) }).promise;
        if (cancelledRef.current) return;

        const count = pdf.numPages;
        setPageCount(count);

        const generated: string[] = [];
        const thumbScale = 0.22;

        if (isSrcSpread) {
          // Pair pages into spreads: [1,2], [3,4], ... (last may be solo)
          for (let i = 1; i <= count; i += 2) {
            if (cancelledRef.current) break;
            const leftPage = await pdf.getPage(i);
            const rightPage = i + 1 <= count ? await pdf.getPage(i + 1) : null;

            const leftVp = leftPage.getViewport({ scale: thumbScale });

            // Combined canvas: left page + right page side by side
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(leftVp.width * (rightPage ? 2 : 1));
            canvas.height = Math.round(leftVp.height);
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            await leftPage.render({ canvasContext: ctx, viewport: leftVp } as any).promise;

            if (rightPage) {
              const rightVp = rightPage.getViewport({ scale: thumbScale });
              ctx.save();
              ctx.translate(leftVp.width, 0);
              await rightPage.render({ canvasContext: ctx, viewport: rightVp } as any).promise;
              ctx.restore();
            }

            generated.push(canvas.toDataURL('image/jpeg', 0.75));
          }
        } else {
          for (let i = 1; i <= count; i++) {
            if (cancelledRef.current) break;
            const page = await pdf.getPage(i);
            const vp = page.getViewport({ scale: thumbScale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport: vp } as any).promise;
            generated.push(canvas.toDataURL('image/jpeg', 0.75));
          }
        }

        if (!cancelledRef.current) {
          setThumbs(generated);
          // Default: select all
          setSelected(new Set(generated.map((_, i) => i)));
          setLoading(false);
        }
      } catch (err) {
        console.error('InsertPdfPagesDialog: thumbnail error:', err);
        if (!cancelledRef.current) setLoading(false);
      }
    };
    generate();
    return () => { cancelledRef.current = true; };
  }, [srcPdfBytes, isSrcSpread]);

  const toggleItem = (idx: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(thumbs.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());

  /* ── Build the list of page indices to return ── */
  const handleConfirm = () => {
    const sorted = [...selected].sort((a, b) => a - b);
    const pageIndices: number[] = [];
    if (isSrcSpread) {
      // Each item index maps to pages [2i, 2i+1] (0-based)
      sorted.forEach(itemIdx => {
        pageIndices.push(itemIdx * 2);
        if (itemIdx * 2 + 1 < pageCount) pageIndices.push(itemIdx * 2 + 1);
      });
    } else {
      sorted.forEach(itemIdx => pageIndices.push(itemIdx));
    }
    onConfirm(pageIndices);
  };

  /* ── Styles ── */
  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
    zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  const dialog: React.CSSProperties = {
    background: '#18191c', border: '1px solid #2a2a2e', borderRadius: 12,
    width: 700, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
  };
  const header: React.CSSProperties = {
    padding: '14px 20px', borderBottom: '1px solid #222', display: 'flex',
    alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
    background: '#1c1d21',
  };
  const footer: React.CSSProperties = {
    padding: '12px 20px', borderTop: '1px solid #222', display: 'flex',
    alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
    background: '#1c1d21',
  };

  return createPortal(
    <div style={overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={dialog}>

        {/* Header */}
        <div style={header}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
              {isSrcSpread ? 'Select Spreads to Insert' : 'Select Pages to Insert'}
            </div>
            <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>
              {isSrcSpread
                ? 'Each selected spread (2 pages) will be merged into a single wide page'
                : `${pageCount} page${pageCount !== 1 ? 's' : ''} available`}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {/* Quick-select bar */}
        <div style={{ padding: '8px 20px', borderBottom: '1px solid #1e1f23', display: 'flex', gap: 10, alignItems: 'center', background: '#111213', flexShrink: 0 }}>
          <button onClick={selectAll}
            style={{ padding: '3px 12px', fontSize: 11, background: 'rgba(77,166,255,0.12)', border: '1px solid #4da6ff44', color: '#4da6ff', borderRadius: 4, cursor: 'pointer' }}>
            Select All
          </button>
          <button onClick={selectNone}
            style={{ padding: '3px 12px', fontSize: 11, background: 'transparent', border: '1px solid #2a2a2e', color: '#888', borderRadius: 4, cursor: 'pointer' }}>
            Select None
          </button>
          <span style={{ fontSize: 11, color: '#555', marginLeft: 'auto' }}>
            {selected.size} of {thumbs.length} {isSrcSpread ? 'spread(s)' : 'page(s)'} selected
          </span>
        </div>

        {/* Thumbnail grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#555', fontSize: 13 }}>
              Generating previews…
            </div>
          ) : thumbs.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#555', fontSize: 13 }}>
              No pages found in PDF.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
              {thumbs.map((thumb, idx) => {
                const isSelected = selected.has(idx);
                const pageLabel = isSrcSpread
                  ? (idx * 2 + 2 <= pageCount ? `Pages ${idx * 2 + 1}–${idx * 2 + 2}` : `Page ${idx * 2 + 1}`)
                  : `Page ${idx + 1}`;
                return (
                  <div
                    key={idx}
                    onClick={() => toggleItem(idx)}
                    style={{
                      cursor: 'pointer', borderRadius: 7,
                      border: `2px solid ${isSelected ? '#4da6ff' : '#2a2a2e'}`,
                      background: isSelected ? 'rgba(77,166,255,0.08)' : '#111213',
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      padding: '10px 8px 8px', gap: 8, transition: 'all 0.13s',
                      position: 'relative',
                    }}
                  >
                    {/* Checkbox overlay */}
                    <div style={{
                      position: 'absolute', top: 6, right: 6, width: 18, height: 18,
                      borderRadius: 4, border: `2px solid ${isSelected ? '#4da6ff' : '#444'}`,
                      background: isSelected ? '#4da6ff' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, color: '#fff', fontWeight: 700, transition: 'all 0.1s',
                    }}>
                      {isSelected ? '✓' : ''}
                    </div>

                    {/* Thumbnail */}
                    <div style={{ width: '100%', borderRadius: 4, overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.5)', flexShrink: 0 }}>
                      <img src={thumb} style={{ width: '100%', display: 'block' }} alt={pageLabel} />
                    </div>

                    {/* Label */}
                    <div style={{ fontSize: 10, color: isSelected ? '#4da6ff' : '#666', fontWeight: isSelected ? 600 : 400, textAlign: 'center' }}>
                      {pageLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={footer}>
          <div style={{ fontSize: 11, color: '#555' }}>
            {isSrcSpread && selected.size > 0 && (
              <span>⟶ Will insert <strong style={{ color: '#4da6ff' }}>{selected.size}</strong> wide page{selected.size !== 1 ? 's' : ''}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose}
              style={{ padding: '7px 16px', background: 'transparent', color: '#aaa', border: '1px solid #444', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={selected.size === 0}
              style={{
                padding: '7px 16px', background: selected.size === 0 ? '#333' : '#4da6ff',
                color: selected.size === 0 ? '#666' : '#fff', border: 'none',
                borderRadius: 6, cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: 12, transition: 'all 0.13s',
              }}>
              Insert {selected.size > 0 ? (isSrcSpread ? `${selected.size} Spread${selected.size !== 1 ? 's' : ''}` : `${selected.size} Page${selected.size !== 1 ? 's' : ''}`) : ''}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

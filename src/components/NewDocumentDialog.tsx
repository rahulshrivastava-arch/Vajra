import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

/* ─── Unit conversion (everything stored in pts internally) ─── */
const PT = { pt: 1, px: 0.75, mm: 2.8346, cm: 28.346, in: 72 };
const toPt = (v: number, u: keyof typeof PT) => v * PT[u];
const fromPt = (v: number, u: keyof typeof PT) => +(v / PT[u]).toFixed(3);

/* ─── Presets ─── */
type Preset = { name: string; w: number; h: number; unit: 'in' | 'mm' };
type Category = { name: string; icon: string; presets: Preset[] };

const CATEGORIES: Category[] = [
  {
    name: 'Recent', icon: '🕐',
    presets: [
      { name: 'A4', w: 210, h: 297, unit: 'mm' },
      { name: 'Letter', w: 8.5, h: 11, unit: 'in' },
    ],
  },
  {
    name: 'Paper', icon: '📄',
    presets: [
      { name: 'Letter', w: 8.5, h: 11, unit: 'in' },
      { name: 'Legal', w: 8.5, h: 14, unit: 'in' },
      { name: 'Tabloid', w: 11, h: 17, unit: 'in' },
      { name: 'A5', w: 148, h: 210, unit: 'mm' },
      { name: 'A4', w: 210, h: 297, unit: 'mm' },
      { name: 'A3', w: 297, h: 420, unit: 'mm' },
      { name: 'A2', w: 420, h: 594, unit: 'mm' },
      { name: 'A1', w: 594, h: 841, unit: 'mm' },
      { name: 'A0', w: 841, h: 1189, unit: 'mm' },
      { name: 'B5', w: 176, h: 250, unit: 'mm' },
      { name: 'B4', w: 250, h: 353, unit: 'mm' },
      { name: 'B3', w: 353, h: 500, unit: 'mm' },
    ],
  },
  {
    name: 'Architectural', icon: '📐',
    presets: [
      { name: 'Arch A  (9×12″)',   w: 9,  h: 12,  unit: 'in' },
      { name: 'Arch B  (12×18″)',  w: 12, h: 18,  unit: 'in' },
      { name: 'Arch C  (18×24″)',  w: 18, h: 24,  unit: 'in' },
      { name: 'Arch D  (24×36″)',  w: 24, h: 36,  unit: 'in' },
      { name: 'Arch E  (36×48″)',  w: 36, h: 48,  unit: 'in' },
      { name: 'Arch E1 (30×42″)',  w: 30, h: 42,  unit: 'in' },
      { name: 'ANSI A  (8.5×11″)', w: 8.5, h: 11, unit: 'in' },
      { name: 'ANSI B  (11×17″)',  w: 11, h: 17,  unit: 'in' },
      { name: 'ANSI C  (17×22″)',  w: 17, h: 22,  unit: 'in' },
      { name: 'ANSI D  (22×34″)',  w: 22, h: 34,  unit: 'in' },
      { name: 'ANSI E  (34×44″)',  w: 34, h: 44,  unit: 'in' },
    ],
  },
  {
    name: 'Web / Screen', icon: '🖥️',
    presets: [
      { name: 'Full HD  (1920×1080)', w: 1920 * 0.75, h: 1080 * 0.75, unit: 'mm' },
      { name: '4K UHD  (3840×2160)', w: 3840 * 0.75, h: 2160 * 0.75, unit: 'mm' },
      { name: 'HD (1280×720)',        w: 1280 * 0.75, h:  720 * 0.75, unit: 'mm' },
      { name: 'iPad (2732×2048)',    w: 2732 * 0.75, h: 2048 * 0.75, unit: 'mm' },
      { name: 'iPhone 14 (390×844)', w:  390 * 0.75, h:  844 * 0.75, unit: 'mm' },
    ],
  },
  {
    name: 'Custom', icon: '✏️',
    presets: [],
  },
];

/* ─── Props ─── */
interface Props {
  onClose: () => void;
  onCreate: (widthPt: number, heightPt: number, isSpread?: boolean, numPages?: number, hasFrontCover?: boolean, hasBackCover?: boolean) => void;
  defaultIsSpread?: boolean;
  defaultWidthPt?: number;
  defaultHeightPt?: number;
  mode?: 'create' | 'insert';
  insertType?: 'inside_spread' | 'add_spread';
  /** When true (inserting into a spread doc), locks the size controls.
   *  When false (inserting into a single-page doc), lets the user pick any size. */
  insertDocumentIsSpread?: boolean;
}

/* ─── Component ─── */
export function NewDocumentDialog({ onClose, onCreate, defaultIsSpread = false, defaultWidthPt, defaultHeightPt, mode = 'create', insertType, insertDocumentIsSpread = false }: Props) {
  const [activeCategory, setActiveCategory] = useState(defaultWidthPt ? 'Custom' : 'Paper');
  const [unit, setUnit] = useState<'in' | 'mm' | 'cm' | 'pt' | 'px'>(defaultWidthPt ? 'pt' : 'mm');
  const [landscape, setLandscape] = useState(false);
  const [wPt, setWPt] = useState(defaultWidthPt ?? toPt(210, 'mm')); // A4 default
  const [hPt, setHPt] = useState(defaultHeightPt ?? toPt(297, 'mm'));
  const [wStr, setWStr] = useState(String(fromPt(defaultWidthPt ?? toPt(210, 'mm'), defaultWidthPt ? 'pt' : 'mm')));
  const [hStr, setHStr] = useState(String(fromPt(defaultHeightPt ?? toPt(297, 'mm'), defaultWidthPt ? 'pt' : 'mm')));
  const [pages, setPages] = useState(insertType === 'inside_spread' ? 2 : (defaultIsSpread ? 2 : 1));
  const [spreads, setSpreads] = useState(1);
  const [inputMode, setInputMode] = useState<'pages' | 'spreads'>(insertType === 'add_spread' ? 'spreads' : 'pages');
  const [selectedPreset, setSelectedPreset] = useState<string>(defaultWidthPt ? 'Custom' : 'A4');
  const primaryColor = '#ffffff';
  const [isSpread, setIsSpread] = useState(defaultIsSpread);
  const [hasFrontCover, setHasFrontCover] = useState(false);
  const [hasBackCover, setHasBackCover] = useState(false);

  /* Sync string fields when unit changes */
  useEffect(() => {
    setWStr(String(fromPt(wPt, unit)));
    setHStr(String(fromPt(hPt, unit)));
  }, [unit]);

  const applyPreset = (p: Preset) => {
    const pw = toPt(p.w, p.unit);
    const ph = toPt(p.h, p.unit);
    const [fw, fh] = landscape ? [Math.max(pw, ph), Math.min(pw, ph)] : [Math.min(pw, ph), Math.max(pw, ph)];
    setWPt(fw); setHPt(fh);
    setWStr(String(fromPt(fw, unit)));
    setHStr(String(fromPt(fh, unit)));
    setSelectedPreset(p.name);
  };

  const commitW = (v: string) => {
    const n = parseFloat(v);
    if (!isNaN(n) && n > 0) { setWPt(toPt(n, unit)); setSelectedPreset('Custom'); }
  };
  const commitH = (v: string) => {
    const n = parseFloat(v);
    if (!isNaN(n) && n > 0) { setHPt(toPt(n, unit)); setSelectedPreset('Custom'); }
  };

  const flipOrientation = (toLandscape: boolean) => {
    setLandscape(toLandscape);
    const [nw, nh] = toLandscape
      ? [Math.max(wPt, hPt), Math.min(wPt, hPt)]
      : [Math.min(wPt, hPt), Math.max(wPt, hPt)];
    setWPt(nw); setHPt(nh);
    setWStr(String(fromPt(nw, unit)));
    setHStr(String(fromPt(nh, unit)));
  };

  const handleCreate = () => {
    let fw = wPt, fh = hPt;
    if (landscape) { fw = Math.max(wPt, hPt); fh = Math.min(wPt, hPt); }
    else { fw = Math.min(wPt, hPt); fh = Math.max(wPt, hPt); }
    
    let finalPages = pages;
    if (isSpread && inputMode === 'spreads') {
      finalPages = spreads * 2 + (hasFrontCover ? 1 : 0) + (hasBackCover ? 1 : 0);
    }
    onCreate(fw, fh, isSpread, finalPages, hasFrontCover, hasBackCover);
    onClose();
  };

  /* ─── preview aspect: thumbnail preview of page ─── */
  const maxPrev = 100;
  const ratio = wPt / hPt;
  const prevW = ratio >= 1 ? maxPrev : Math.round(maxPrev * ratio);
  const prevH = ratio >= 1 ? Math.round(maxPrev / ratio) : maxPrev;


  const category = CATEGORIES.find(c => c.name === activeCategory)!;

  /* ─── styles ─── */
  const s = {
    overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' },
    dialog: { background: '#18191c', border: '1px solid #333', borderRadius: 12, width: 900, height: 600, display: 'flex', flexDirection: 'column' as const, boxShadow: '0 24px 48px rgba(0,0,0,0.5)', overflow: 'hidden' },
    header: { padding: '16px 24px', borderBottom: '1px solid #2a2b2e', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1c1d21', flexShrink: 0 },
    body: { display: 'flex', flex: 1, overflow: 'hidden' },
    catList: { width: 150, background: '#111213', borderRight: '1px solid #1e1f2a', padding: '10px 0', flexShrink: 0, overflowY: 'auto' as const },
    presetGrid: { flex: 1, overflowY: 'auto' as const, padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, alignContent: 'start' },
    rightPanel: { width: 245, background: '#111213', borderLeft: '1px solid #1e1f2a', padding: '16px', flexShrink: 0, display: 'flex', flexDirection: 'column' as const, gap: 0, overflowY: 'auto' as const },
    footer: { padding: '16px 24px', borderTop: '1px solid #2a2b2e', display: 'flex', justifyContent: 'flex-end', gap: 12, background: '#1c1d21', flexShrink: 0 },
  };

  const inputStyle: React.CSSProperties = {
    background: '#1e1f23', border: '1px solid #2a2a2e', color: '#e0e0e0',
    borderRadius: 5, padding: '6px 9px', fontSize: 12, width: '100%',
    outline: 'none', boxSizing: 'border-box',
    fontVariantNumeric: 'tabular-nums',
  };
  const labelStyle: React.CSSProperties = { fontSize: 10, color: '#666', fontWeight: 600, letterSpacing: '0.7px', textTransform: 'uppercase', marginBottom: 4, display: 'block' };
  const sectionStyle: React.CSSProperties = { marginBottom: 16 };

  return createPortal(
    <div style={s.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.dialog}>

        {/* Header */}
        <div style={s.header}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>{mode === 'create' ? 'New Document' : 'Insert Pages'}</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{mode === 'create' ? 'Choose a preset or set custom dimensions' : 'Choose page size and amount to insert'}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '2px 6px', borderRadius: 4 }}>✕</button>
        </div>

        {/* Body */}
        <div style={s.body}>

          {/* Category sidebar — locked only when inserting into a spread document */}
          <div style={{ ...s.catList, opacity: (mode === 'insert' && insertDocumentIsSpread) ? 0.3 : 1, pointerEvents: (mode === 'insert' && insertDocumentIsSpread) ? 'none' : 'auto' }}>
            {CATEGORIES.map(cat => (
              <button key={cat.name}
                onClick={() => setActiveCategory(cat.name)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '8px 14px', background: activeCategory === cat.name ? 'rgba(77,166,255,0.12)' : 'transparent',
                  border: 'none', borderLeft: `2px solid ${activeCategory === cat.name ? '#4da6ff' : 'transparent'}`,
                  color: activeCategory === cat.name ? '#4da6ff' : '#777', cursor: 'pointer',
                  fontSize: 12, textAlign: 'left', transition: 'all 0.12s',
                }}
                onMouseEnter={e => { if (activeCategory !== cat.name) (e.currentTarget as HTMLElement).style.color = '#bbb'; }}
                onMouseLeave={e => { if (activeCategory !== cat.name) (e.currentTarget as HTMLElement).style.color = '#777'; }}
              >
                <span style={{ fontSize: 14 }}>{cat.icon}</span>
                {cat.name}
              </button>
            ))}
          </div>

          {/* Preset grid OR custom prompt — locked only when inserting into a spread document */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, opacity: (mode === 'insert' && insertDocumentIsSpread) ? 0.3 : 1, pointerEvents: (mode === 'insert' && insertDocumentIsSpread) ? 'none' : 'auto' }}>
            {activeCategory === 'Custom' ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: '#555' }}>
                <div style={{ fontSize: 36 }}>✏️</div>
                <div style={{ fontSize: 13, color: '#777' }}>Set custom dimensions in the panel on the right.</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, alignContent: 'start' }}>
                {category.presets.map(p => {
                  const isActive = selectedPreset === p.name;
                  const pw = toPt(p.w, p.unit);
                  const ph = toPt(p.h, p.unit);
                  const thumbRatio = pw / ph;
                  const tw = thumbRatio >= 1 ? 44 : Math.round(44 * thumbRatio);
                  const th = thumbRatio >= 1 ? Math.round(44 / thumbRatio) : 44;
                  const dimW = +fromPt(pw, unit).toFixed(1);
                  const dimH = +fromPt(ph, unit).toFixed(1);
                  return (
                    <button key={p.name}
                      onClick={() => applyPreset(p)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                        padding: '14px 10px 10px', borderRadius: 8, cursor: 'pointer',
                        border: `1.5px solid ${isActive ? '#4da6ff' : '#2a2a2e'}`,
                        background: isActive ? 'rgba(77,166,255,0.1)' : '#1a1b1f',
                        transition: 'all 0.14s', gap: 8,
                      }}
                      onMouseEnter={e => { if (!isActive) { const el = e.currentTarget as HTMLElement; el.style.border = '1.5px solid #3a3a3e'; el.style.background = '#1e1f23'; } }}
                      onMouseLeave={e => { if (!isActive) { const el = e.currentTarget as HTMLElement; el.style.border = '1.5px solid #2a2a2e'; el.style.background = '#1a1b1f'; } }}
                    >
                      {/* Tiny page preview */}
                      <div style={{ width: tw, height: th, background: '#fff', border: `1px solid ${isActive ? '#4da6ff55' : '#333'}`, borderRadius: 2, boxShadow: '0 2px 6px rgba(0,0,0,0.4)', flexShrink: 0 }} />
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: isActive ? '#4da6ff' : '#ccc', marginBottom: 2 }}>{p.name}</div>
                        <div style={{ fontSize: 9, color: '#555' }}>{dimW} × {dimH} {unit}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right settings panel */}
          <div style={s.rightPanel}>

            {/* Layout toggle (Moved to Top) */}
            {mode === 'create' && (
              <div style={sectionStyle}>
                <label style={labelStyle}>Layout</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setIsSpread(false)}
                  style={{
                    flex: 1, padding: '8px 4px', borderRadius: 6, cursor: 'pointer', fontSize: 10,
                    border: `1px solid ${!isSpread ? '#4da6ff' : '#2a2a2e'}`,
                    background: !isSpread ? 'rgba(77,166,255,0.12)' : '#1e1f23',
                    color: !isSpread ? '#4da6ff' : '#666',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    transition: 'all 0.13s',
                  }}
                >
                  <div style={{ width: 18, height: 22, background: !isSpread ? '#4da6ff33' : '#2a2a2e', border: `1px solid ${!isSpread ? '#4da6ff' : '#444'}`, borderRadius: 1 }} />
                  Single
                </button>
                <button
                  onClick={() => {
                    setIsSpread(true);
                    if (pages < 2) setPages(2);
                  }}
                  style={{
                    flex: 1, padding: '8px 4px', borderRadius: 6, cursor: 'pointer', fontSize: 10,
                    border: `1px solid ${isSpread ? '#4da6ff' : '#2a2a2e'}`,
                    background: isSpread ? 'rgba(77,166,255,0.12)' : '#1e1f23',
                    color: isSpread ? '#4da6ff' : '#666',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    transition: 'all 0.13s',
                  }}
                >
                  <div style={{ display: 'flex', gap: 1 }}>
                    <div style={{ width: 9, height: 22, background: isSpread ? '#4da6ff33' : '#2a2a2e', border: `1px solid ${isSpread ? '#4da6ff' : '#444'}`, borderRadius: '1px 0 0 1px' }} />
                    <div style={{ width: 9, height: 22, background: isSpread ? '#4da6ff33' : '#2a2a2e', border: `1px solid ${isSpread ? '#4da6ff' : '#444'}`, borderRadius: '0 1px 1px 0' }} />
                  </div>
                  Spread
                </button>
              </div>
            </div>
            )}

            {/* Page preview */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid #1e1f2a' }}>
              <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, marginBottom: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>
                {(!isSpread || hasFrontCover) && <div style={{ width: prevW, height: prevH, background: primaryColor, border: '1px solid #333', borderRadius: isSpread ? '2px 0 0 2px' : 2 }} />}
                {isSpread && !hasFrontCover && (
                  <>
                    <div style={{ width: prevW, height: prevH, background: primaryColor, border: '1px solid #333', borderRadius: '2px 0 0 2px' }} />
                    <div style={{ width: 3, background: '#4da6ff44', borderLeft: '1.5px solid #4da6ff' }} />
                    <div style={{ width: prevW, height: prevH, background: primaryColor, border: '1px solid #333', borderRadius: '0 2px 2px 0' }} />
                  </>
                )}
              </div>
              <div style={{ fontSize: 10, color: '#555' }}>
                {+fromPt(wPt, unit).toFixed(1)} × {+fromPt(hPt, unit).toFixed(1)} {unit}
                {isSpread && <span style={{ color: '#4da6ff', marginLeft: 4 }}>× 2 spread</span>}
              </div>
            </div>

            {/* Count Input */}
            <div style={sectionStyle}>
              {isSpread ? (
                <>
                  <label style={labelStyle}>Input by</label>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <button 
                      onClick={() => setInputMode('pages')}
                      disabled={insertType === 'add_spread'}
                      style={{ flex: 1, padding: '4px', borderRadius: 4, fontSize: 10, cursor: insertType === 'add_spread' ? 'not-allowed' : 'pointer', border: `1px solid ${inputMode === 'pages' ? '#4da6ff' : '#2a2a2e'}`, background: inputMode === 'pages' ? '#4da6ff22' : 'transparent', color: inputMode === 'pages' ? '#4da6ff' : '#888', opacity: insertType === 'add_spread' ? 0.3 : 1 }}>
                      Pages
                    </button>
                    <button 
                      onClick={() => setInputMode('spreads')}
                      disabled={insertType === 'inside_spread'}
                      style={{ flex: 1, padding: '4px', borderRadius: 4, fontSize: 10, cursor: insertType === 'inside_spread' ? 'not-allowed' : 'pointer', border: `1px solid ${inputMode === 'spreads' ? '#4da6ff' : '#2a2a2e'}`, background: inputMode === 'spreads' ? '#4da6ff22' : 'transparent', color: inputMode === 'spreads' ? '#4da6ff' : '#888', opacity: insertType === 'inside_spread' ? 0.3 : 1 }}>
                      Spreads
                    </button>
                  </div>
                  {inputMode === 'pages' ? (
                    <>
                      <label style={labelStyle}>Total Pages</label>
                      <input type="number" min="1" max="200" style={inputStyle} value={pages}
                        onChange={e => {
                           let val = Math.max(1, Math.min(200, parseInt(e.target.value) || 1));
                           if (insertType === 'inside_spread') {
                             setPages(val); // Do not auto-correct, let the validation catch it
                           } else {
                             const expectedOdd = (hasFrontCover ? 1 : 0) !== (hasBackCover ? 1 : 0);
                             if (expectedOdd && val % 2 === 0) val += 1;
                             if (!expectedOdd && val % 2 !== 0) val += 1;
                             setPages(val);
                           }
                        }} />
                        {insertType === 'inside_spread' ? (
                          pages % 2 !== 0 ? (
                            <div style={{ fontSize: 10, color: '#ff6b6b', marginTop: 4 }}>⚠ You can only insert an even number of pages inside a spread.</div>
                          ) : (
                            <div style={{ fontSize: 9, color: '#888', marginTop: 4 }}>Note: Must insert an even number of pages inside a spread.</div>
                          )
                        ) : (
                          <div style={{ fontSize: 9, color: '#888', marginTop: 4 }}>Note: Value auto-adjusts to maintain front/back cover setup.</div>
                        )}
                    </>
                  ) : (
                    <>
                      <label style={labelStyle}>Total Spreads</label>
                      <input type="number" min="1" max="100" style={inputStyle} value={spreads}
                        onChange={e => setSpreads(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))} />
                      <div style={{ fontSize: 9, color: '#888', marginTop: 4 }}>
                        Calculated Pages: {spreads * 2 + (hasFrontCover ? 1 : 0) + (hasBackCover ? 1 : 0)}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <label style={labelStyle}>Pages</label>
                  <input type="number" min="1" max="200" style={inputStyle} value={pages}
                    onChange={e => setPages(Math.max(1, Math.min(200, parseInt(e.target.value) || 1)))} />
                </>
              )}
            </div>

            {/* Spread Options (Covers) */}
            {isSpread && mode === 'create' && (
              <div style={sectionStyle}>
                <div style={{ marginTop: 24 }}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 8 }}>COVER SETTINGS</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ddd', marginBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={hasFrontCover} onChange={e => { setHasFrontCover(e.target.checked); if (inputMode === 'pages') setPages(p => p + 1); }} />
                  Front Cover (Single Page)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ddd', cursor: 'pointer' }}>
                  <input type="checkbox" checked={hasBackCover} onChange={e => { setHasBackCover(e.target.checked); if (inputMode === 'pages') setPages(p => p + 1); }} />
                  Back Cover (Single Page)
                </label>
              </div>
                {(hasFrontCover || hasBackCover) && inputMode === 'spreads' && (
                  <div style={{ marginTop: 6, fontSize: 10, color: '#e0a020', padding: '4px 6px', background: 'rgba(224,160,32,0.1)', borderRadius: 4, border: '1px solid rgba(224,160,32,0.2)' }}>
                    ⚠ {(hasFrontCover && hasBackCover) ? '2' : '1'} extra page(s) will be added on top of the spreads selected.
                  </div>
                )}
              </div>
            )}

            {/* Units — locked only when inserting into a spread document */}
            <div style={{ ...sectionStyle, opacity: (mode === 'insert' && insertDocumentIsSpread) ? 0.3 : 1, pointerEvents: (mode === 'insert' && insertDocumentIsSpread) ? 'none' : 'auto' }}>
              <label style={labelStyle}>Units</label>
              <select value={unit} onChange={e => setUnit(e.target.value as any)} style={{ ...inputStyle }}>
                <option value="mm">Millimeters (mm)</option>
                <option value="in">Inches (in)</option>
                <option value="cm">Centimeters (cm)</option>
                <option value="pt">Points (pt)</option>
                <option value="px">Pixels (px)</option>
              </select>
            </div>

            {/* Dimensions — locked only when inserting into a spread document */}
            <div style={{ ...sectionStyle, opacity: (mode === 'insert' && insertDocumentIsSpread) ? 0.3 : 1, pointerEvents: (mode === 'insert' && insertDocumentIsSpread) ? 'none' : 'auto' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Width</label>
                  <input type="number" style={inputStyle} value={wStr} step="0.1"
                    onChange={e => setWStr(e.target.value)} onBlur={e => commitW(e.target.value)} onKeyDown={e => e.key === 'Enter' && commitW(wStr)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Height</label>
                  <input type="number" style={inputStyle} value={hStr} step="0.1"
                    onChange={e => setHStr(e.target.value)} onBlur={e => commitH(e.target.value)} onKeyDown={e => e.key === 'Enter' && commitH(hStr)} />
                </div>
              </div>
            </div>

            {/* Orientation — locked only when inserting into a spread document */}
            <div style={{ ...sectionStyle, opacity: (mode === 'insert' && insertDocumentIsSpread) ? 0.3 : 1, pointerEvents: (mode === 'insert' && insertDocumentIsSpread) ? 'none' : 'auto' }}>
              <label style={labelStyle}>Orientation</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {[ { label: 'Portrait', icon: '⬜', toLandscape: false }, { label: 'Landscape', icon: '⬛', toLandscape: true } ].map(o => (
                  <button key={o.label} onClick={() => flipOrientation(o.toLandscape)}
                    style={{ flex: 1, padding: '8px 4px', borderRadius: 6, cursor: 'pointer', fontSize: 10,
                      border: `1px solid ${landscape === o.toLandscape ? '#4da6ff' : '#2a2a2e'}`, background: landscape === o.toLandscape ? 'rgba(77,166,255,0.12)' : '#1e1f23',
                      color: landscape === o.toLandscape ? '#4da6ff' : '#666', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, transition: 'all 0.13s' }}>
                    <div style={{ width: o.toLandscape ? 22 : 14, height: o.toLandscape ? 14 : 22, background: landscape === o.toLandscape ? '#4da6ff33' : '#2a2a2e', border: `1px solid ${landscape === o.toLandscape ? '#4da6ff' : '#444'}`, borderRadius: 1 }} />
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ flex: 1 }} />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid #2a2b2e', display: 'flex', justifyContent: 'flex-end', gap: 12, background: '#1c1d21' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', background: 'transparent', color: '#aaa', border: '1px solid #444', borderRadius: 6, fontWeight: 500, cursor: 'pointer' }}>
            Cancel
          </button>
          <button 
            disabled={mode === 'insert' && insertType === 'inside_spread' && pages % 2 !== 0}
            onClick={handleCreate} 
            style={{ 
              padding: '8px 16px', 
              background: (mode === 'insert' && insertType === 'inside_spread' && pages % 2 !== 0) ? '#333' : '#4da6ff', 
              color: (mode === 'insert' && insertType === 'inside_spread' && pages % 2 !== 0) ? '#666' : '#fff', 
              border: 'none', 
              borderRadius: 6, 
              fontWeight: 500, 
              cursor: (mode === 'insert' && insertType === 'inside_spread' && pages % 2 !== 0) ? 'not-allowed' : 'pointer' 
            }}>
            {mode === 'create' ? 'Create Document' : 'Insert Pages'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

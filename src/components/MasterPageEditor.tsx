// ─────────────────────────────────────────────────────────────────────────────
// MasterPageEditor.tsx
//
// Renders the Left Side Panel for Master Page management when editorMode === 'master'.
// Features:
//   • CRUD list of Master Pages.
//   • Modal to create a new Master Page (with presets, orientation, and spread options).
//   • Active Master Page settings (PDF background upload, page selector, and details).
//   • Clean amber mode theme.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import type { MasterPage } from '../store/useStore';

const AMBER = '#f59e0b';
const AMBER_DIM = 'rgba(245,158,11,0.1)';
const AMBER_BORDER = 'rgba(245,158,11,0.3)';
const PANEL_BG = '#252525';
const BORDER = '#1a1a1a';
const TEXT_DIM = '#666';
const TEXT_MID = '#999';
const TEXT_BRIGHT = '#e0e0e0';
const ACCENT = '#4da6ff';

// Standard Page Presets in Points (1 inch = 72 points)
const PRESETS = [
  { id: 'letter', name: 'Letter (8.5" x 11")', w: 612, h: 792 },
  { id: 'legal', name: 'Legal (8.5" x 14")', w: 612, h: 1008 },
  { id: 'a4', name: 'A4 (210 x 297 mm)', w: 595, h: 842 },
  { id: 'a3', name: 'A3 (297 x 420 mm)', w: 842, h: 1190 },
  { id: 'a2', name: 'A2 (420 x 594 mm)', w: 1190, h: 1684 },
  { id: 'a1', name: 'A1 (594 x 841 mm)', w: 1684, h: 2384 },
  { id: 'custom', name: 'Custom Size...', w: 612, h: 792 },
];

export function MasterPageEditor() {
  const {
    masterPages,
    activeMasterPageId,
    setActiveMasterPageId,
    addMasterPage,
    updateMasterPage,
    deleteMasterPage,
    setEditorMode,
  } = useStore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [presetId, setPresetId] = useState('letter');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [isSpread, setIsSpread] = useState(false);
  const [customWStr, setCustomWStr] = useState('8.50');
  const [customHStr, setCustomHStr] = useState('11.00');

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showCreateModal) {
      setCustomWStr('8.50');
      setCustomHStr('11.00');
      setPresetId('letter');
    }
  }, [showCreateModal]);

  const activeMaster = masterPages.find((m) => m.id === activeMasterPageId) || null;

  // Initialize active master page ID
  useEffect(() => {
    if (!activeMasterPageId && masterPages.length > 0) {
      setActiveMasterPageId(masterPages[0].id);
    }
  }, [masterPages, activeMasterPageId, setActiveMasterPageId]);

  const handleCreate = () => {
    let baseW = 612;
    let baseH = 792;

    if (presetId === 'custom') {
      const parsedW = parseFloat(customWStr);
      const parsedH = parseFloat(customHStr);
      if (!isNaN(parsedW) && parsedW > 0) baseW = parsedW * 72;
      if (!isNaN(parsedH) && parsedH > 0) baseH = parsedH * 72;
    } else {
      const selectedPreset = PRESETS.find((p) => p.id === presetId);
      if (selectedPreset) {
        baseW = selectedPreset.w;
        baseH = selectedPreset.h;
      }
      if (orientation === 'landscape') {
        const tmp = baseW;
        baseW = baseH;
        baseH = tmp;
      }
    }

    const n = newName.trim() || `${String.fromCharCode(65 + masterPages.length)}-Master`;
    const id = addMasterPage(n, baseW, baseH, isSpread);
    setActiveMasterPageId(id);
    setShowCreateModal(false);

    // Reset fields
    setNewName('');
    setPresetId('letter');
    setOrientation('portrait');
    setIsSpread(false);
  };

  const commitRename = (id: string) => {
    if (renameVal.trim()) {
      updateMasterPage(id, { name: renameVal.trim() });
    }
    setRenamingId(null);
  };

  const getPageSizeLabel = (m: MasterPage) => {
    const wIn = (m.pageWidth / 72).toFixed(1);
    const hIn = (m.pageHeight / 72).toFixed(1);
    const wMm = Math.round(m.pageWidth * 0.3528);
    const hMm = Math.round(m.pageHeight * 0.3528);
    const spreadText = m.isSpread ? 'Spread' : 'Single';
    return `${wIn}" x ${hIn}" (${wMm}x${hMm}mm) — ${spreadText}`;
  };

  return (
    <aside
      className="left-side-panel"
      style={{
        width: 300,
        background: PANEL_BG,
        borderRight: `1px solid ${BORDER}`,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 14px 10px',
          borderBottom: `1px solid ${BORDER}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '1px',
            color: AMBER,
            textTransform: 'uppercase',
          }}
        >
          Master Pages
        </span>
        <button
          id="master-create-btn"
          onClick={() => setShowCreateModal(true)}
          title="Create new Master Page"
          style={{
            background: AMBER_DIM,
            border: `1px solid ${AMBER_BORDER}`,
            borderRadius: 5,
            color: AMBER,
            fontSize: 11,
            cursor: 'pointer',
            padding: '4px 10px',
            fontWeight: 600,
            transition: 'all 0.15s',
          }}
        >
          + New Master
        </button>
      </div>

      {/* Master List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {masterPages.length === 0 ? (
          <div style={{ padding: '16px 14px', color: TEXT_DIM, fontSize: 11, lineHeight: 1.6 }}>
            No masters yet. Click "+ New Master" to create one.
          </div>
        ) : (
          masterPages.map((m) => {
            const isActive = m.id === activeMasterPageId;
            return (
              <div
                key={m.id}
                id={`master-item-${m.id}`}
                onClick={() => setActiveMasterPageId(m.id)}
                style={{
                  padding: '12px 14px',
                  borderBottom: `1px solid ${BORDER}`,
                  background: isActive ? AMBER_DIM : 'transparent',
                  borderLeft: isActive ? `3px solid ${AMBER}` : '3px solid transparent',
                  cursor: 'pointer',
                  transition: 'background 0.12s',
                }}
              >
                {renamingId === m.id ? (
                  <input
                    autoFocus
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onBlur={() => commitRename(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(m.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: '#111',
                      border: `1px solid ${AMBER}`,
                      borderRadius: 4,
                      color: TEXT_BRIGHT,
                      fontSize: 12,
                      padding: '2px 6px',
                      width: '100%',
                      outline: 'none',
                    }}
                  />
                ) : (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span
                        style={{
                          fontSize: 12,
                          color: isActive ? AMBER : TEXT_MID,
                          fontWeight: isActive ? 700 : 500,
                        }}
                      >
                        {m.name}
                      </span>
                      <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                        <button
                          title="Rename"
                          onClick={() => {
                            setRenamingId(m.id);
                            setRenameVal(m.name);
                          }}
                          style={{ background: 'none', border: 'none', color: TEXT_DIM, cursor: 'pointer', fontSize: 11 }}
                        >
                          ✏
                        </button>
                        <button
                          title="Delete"
                          onClick={() => {
                            deleteMasterPage(m.id);
                          }}
                          style={{ background: 'none', border: 'none', color: '#e05050', cursor: 'pointer', fontSize: 11 }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 9, color: TEXT_DIM, marginTop: 4 }}>
                      {getPageSizeLabel(m)}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Active Master Details & Actions */}
      {activeMaster && (
        <div
          style={{
            borderTop: `1px solid ${BORDER}`,
            padding: '14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            background: 'rgba(0,0,0,0.1)',
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '1px', color: TEXT_MID, textTransform: 'uppercase' }}>
            Template Configuration
          </div>

          {/* Size details readout */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, background: '#1c1d21', padding: '8px', borderRadius: 4, border: '1px solid #2e2f33' }}>
            <div style={{ fontSize: 10, color: TEXT_DIM, display: 'flex', justifyContent: 'space-between' }}>
              <span>Page Size:</span>
              <span style={{ color: TEXT_BRIGHT, fontWeight: 500 }}>
                {Math.round(activeMaster.pageWidth * 0.3528)} x {Math.round(activeMaster.pageHeight * 0.3528)} mm
              </span>
            </div>
            <div style={{ fontSize: 10, color: TEXT_DIM, display: 'flex', justifyContent: 'space-between' }}>
              <span>Layout:</span>
              <span style={{ color: AMBER, fontWeight: 700 }}>
                {activeMaster.isSpread ? 'Double Page (Spread)' : 'Single Page'}
              </span>
            </div>
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '1px', color: TEXT_DIM, textTransform: 'uppercase', marginTop: 4 }}>
            Background PDF
          </div>

          <label
            id="master-upload-bg-btn"
            style={{
              background: 'rgba(77,166,255,0.08)',
              border: '1px solid rgba(77,166,255,0.25)',
              borderRadius: 5,
              color: ACCENT,
              fontSize: 11,
              cursor: 'pointer',
              padding: '8px',
              textAlign: 'center',
              display: 'block',
              fontWeight: 500,
              transition: 'background 0.2s',
            }}
          >
            {activeMaster.backgroundPdfBytes ? '↑ Replace PDF background' : '↑ Upload PDF background'}
            <input
              type="file"
              hidden
              accept=".pdf,application/pdf"
              ref={fileRef}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file || !activeMasterPageId) return;
                const buf = await file.arrayBuffer();
                updateMasterPage(activeMasterPageId, { backgroundPdfBytes: new Uint8Array(buf) });
                e.target.value = '';
              }}
            />
          </label>

          {activeMaster.backgroundPdfBytes && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Background PDF page number select */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: TEXT_MID }}>PDF Page:</span>
                <input
                  type="number"
                  min={1}
                  value={activeMaster.backgroundPageNum || 1}
                  onChange={(e) => {
                    const pageNum = Math.max(1, parseInt(e.target.value) || 1);
                    updateMasterPage(activeMaster.id, { backgroundPageNum: pageNum });
                  }}
                  style={{
                    width: 50,
                    background: '#1c1d21',
                    border: '1px solid #3a3b3e',
                    color: '#fff',
                    borderRadius: 4,
                    padding: '3px 6px',
                    fontSize: 11,
                    textAlign: 'center',
                  }}
                />
              </div>

              <button
                id="master-clear-bg-btn"
                onClick={() => updateMasterPage(activeMaster.id, { backgroundPdfBytes: null })}
                style={{
                  background: 'rgba(224,80,80,0.08)',
                  border: '1px solid rgba(224,80,80,0.2)',
                  borderRadius: 5,
                  color: '#e05050',
                  fontSize: 11,
                  cursor: 'pointer',
                  padding: '7px',
                  fontWeight: 500,
                  transition: 'background 0.2s',
                }}
              >
                ✕ Remove Background
              </button>
            </div>
          )}
        </div>
      )}

      {/* Done Button */}
      <button
        id="master-done-btn"
        onClick={() => setEditorMode('document')}
        style={{
          margin: '14px',
          padding: '10px',
          background: AMBER_DIM,
          border: `1px solid ${AMBER_BORDER}`,
          borderRadius: 6,
          color: AMBER,
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          letterSpacing: '0.5px',
          transition: 'background 0.2s',
        }}
      >
        ← Done Editing Masters
      </button>

      {/* CREATE MASTER MODAL DIALOG */}
      {showCreateModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999,
          }}
        >
          <div
            style={{
              background: '#1e1f23',
              border: `1px solid ${AMBER_BORDER}`,
              borderRadius: 8,
              width: 340,
              padding: '18px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: AMBER, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
              Create Master Page
            </div>

            {/* Name Input */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, color: TEXT_MID, fontWeight: 600 }}>Master Name</label>
              <input
                autoFocus
                placeholder="e.g. A-Master"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={{
                  background: '#121315',
                  border: '1px solid #333',
                  borderRadius: 4,
                  color: '#fff',
                  fontSize: 12,
                  padding: '6px 10px',
                  outline: 'none',
                }}
              />
            </div>

            {/* Presets Select */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, color: TEXT_MID, fontWeight: 600 }}>Page Size Preset</label>
              <select
                value={presetId}
                onChange={(e) => {
                  const val = e.target.value;
                  setPresetId(val);
                  if (val !== 'custom') {
                    const preset = PRESETS.find((p) => p.id === val);
                    if (preset) {
                      setCustomWStr((preset.w / 72).toFixed(2));
                      setCustomHStr((preset.h / 72).toFixed(2));
                    }
                  }
                }}
                style={{
                  background: '#121315',
                  border: '1px solid #333',
                  borderRadius: 4,
                  color: '#fff',
                  fontSize: 12,
                  padding: '6px 8px',
                  outline: 'none',
                }}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Custom Dimensions */}
            {presetId === 'custom' && (
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <label style={{ fontSize: 9, color: TEXT_DIM }}>Width (in)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={customWStr}
                    onChange={(e) => setCustomWStr(e.target.value)}
                    style={{
                      background: '#121315',
                      border: '1px solid #333',
                      borderRadius: 4,
                      color: '#fff',
                      fontSize: 12,
                      padding: '6px',
                      textAlign: 'center',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <label style={{ fontSize: 9, color: TEXT_DIM }}>Height (in)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={customHStr}
                    onChange={(e) => setCustomHStr(e.target.value)}
                    style={{
                      background: '#121315',
                      border: '1px solid #333',
                      borderRadius: 4,
                      color: '#fff',
                      fontSize: 12,
                      padding: '6px',
                      textAlign: 'center',
                    }}
                  />
                </div>
              </div>
            )}

            {/* Orientation Preset (Portrait/Landscape) */}
            {presetId !== 'custom' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 10, color: TEXT_MID, fontWeight: 600 }}>Orientation</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['portrait', 'landscape'] as const).map((o) => (
                    <button
                      key={o}
                      onClick={() => setOrientation(o)}
                      style={{
                        flex: 1,
                        background: orientation === o ? AMBER_DIM : 'transparent',
                        color: orientation === o ? AMBER : TEXT_MID,
                        border: `1px solid ${orientation === o ? AMBER : '#333'}`,
                        borderRadius: 4,
                        padding: '6px 0',
                        fontSize: 11,
                        cursor: 'pointer',
                        fontWeight: 600,
                        textTransform: 'capitalize',
                      }}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Layout Mode (Single vs Spread) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, color: TEXT_MID, fontWeight: 600 }}>Layout</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {[
                  { value: false, label: 'Single Page' },
                  { value: true, label: '2-Page Spread' },
                ].map((l) => (
                  <button
                    key={l.label}
                    onClick={() => setIsSpread(l.value)}
                    style={{
                      flex: 1,
                      background: isSpread === l.value ? AMBER_DIM : 'transparent',
                      color: isSpread === l.value ? AMBER : TEXT_MID,
                      border: `1px solid ${isSpread === l.value ? AMBER : '#333'}`,
                      borderRadius: 4,
                      padding: '6px 0',
                      fontSize: 11,
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button
                onClick={() => setShowCreateModal(false)}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: '1px solid #444',
                  borderRadius: 5,
                  color: TEXT_MID,
                  padding: '7px 0',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                style={{
                  flex: 1,
                  background: AMBER,
                  color: '#000',
                  border: 'none',
                  borderRadius: 5,
                  padding: '7px 0',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

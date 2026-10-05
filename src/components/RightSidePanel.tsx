import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/useStore';
import { useShallow } from 'zustand/react/shallow';
import type { MasterPage } from '../store/useStore';
import { acquirePdfDoc, releasePdfDoc } from '../utils/pdfDocumentManager';

// (PDF.js worker URL is configured once in ../utils/pdfDocumentManager.)

const formatPageSize = (w: number, h: number): string => {
  const matchPreset = (width: number, height: number) => {
    if (Math.abs(width - 612) <= 2 && Math.abs(height - 792) <= 2) return 'Letter';
    if (Math.abs(width - 792) <= 2 && Math.abs(height - 612) <= 2) return 'Letter (Landscape)';
    if (Math.abs(width - 612) <= 2 && Math.abs(height - 1008) <= 2) return 'Legal';
    if (Math.abs(width - 1008) <= 2 && Math.abs(height - 612) <= 2) return 'Legal (Landscape)';
    if (Math.abs(width - 595) <= 2 && Math.abs(height - 842) <= 2) return 'A4';
    if (Math.abs(width - 842) <= 2 && Math.abs(height - 595) <= 2) return 'A4 (Landscape)';
    if (Math.abs(width - 842) <= 2 && Math.abs(height - 1190) <= 2) return 'A3';
    if (Math.abs(width - 1190) <= 2 && Math.abs(height - 842) <= 2) return 'A3 (Landscape)';
    if (Math.abs(width - 1190) <= 2 && Math.abs(height - 1684) <= 2) return 'A2';
    if (Math.abs(width - 1684) <= 2 && Math.abs(height - 1190) <= 2) return 'A2 (Landscape)';
    if (Math.abs(width - 1684) <= 2 && Math.abs(height - 2384) <= 2) return 'A1';
    if (Math.abs(width - 2384) <= 2 && Math.abs(height - 1684) <= 2) return 'A1 (Landscape)';
    return null;
  };

  const presetName = matchPreset(w, h);
  if (presetName) return presetName;

  const inchesW = Number((w / 72).toFixed(2));
  const inchesH = Number((h / 72).toFixed(2));
  return `${inchesW}" x ${inchesH}"`;
};

interface SizeMismatch {
  hasMismatch: boolean;
  docLabel: string;
  masterLabel: string;
}

const checkMismatchForPages = (
  pages: number[],
  masterId: string | null,
  docPageSizes: Record<number, { width: number; height: number }>,
  masterPages: MasterPage[]
): SizeMismatch | null => {
  if (!masterId) return null;
  const master = masterPages.find(m => m.id === masterId);
  if (!master) return null;

  for (const pageNum of pages) {
    const docSize = docPageSizes[pageNum];
    if (!docSize) continue;

    if (Math.abs(docSize.width - master.pageWidth) > 5 || Math.abs(docSize.height - master.pageHeight) > 5) {
      return {
        hasMismatch: true,
        docLabel: formatPageSize(docSize.width, docSize.height),
        masterLabel: formatPageSize(master.pageWidth, master.pageHeight)
      };
    }
  }

  return null;
};

function MismatchWarning({ docLabel, masterLabel }: { docLabel: string; masterLabel: string }) {
  const [hovered, setHovered] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hovered && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setCoords({
        top: rect.top + window.scrollY - 8,
        left: rect.right + window.scrollX - 210,
      });
    }
  }, [hovered]);

  return (
    <div
      ref={triggerRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 6,
        cursor: 'help',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        style={{
          fontSize: 14,
          color: '#f59e0b',
          textShadow: '0 0 8px rgba(245, 158, 11, 0.5)',
        }}
      >
        ⚠️
      </span>
      {hovered && createPortal(
        <div
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            transform: 'translateY(-100%)',
            width: 210,
            background: 'rgba(20, 20, 25, 0.95)',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5), 0 0 8px rgba(245, 158, 11, 0.1)',
            color: '#e0e0e0',
            padding: '8px 10px',
            fontSize: 10,
            zIndex: 999999,
            pointerEvents: 'none',
            lineHeight: 1.4,
            backdropFilter: 'blur(4px)',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          <div style={{ fontWeight: 'bold', color: '#f59e0b', marginBottom: 3 }}>
            Page Size Mismatch
          </div>
          <div>
            Document is <span style={{ color: '#fff', fontWeight: 500 }}>{docLabel}</span>, Master is <span style={{ color: '#fff', fontWeight: 500 }}>{masterLabel}</span>.
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

import { getSpreads } from '../utils/spreadLayout';

const IMPERIAL_SCALES = [
  { label: '1:1', value: 1 },
  { label: '1/16" = 1\'-0"', value: 192 },
  { label: '3/32" = 1\'-0"', value: 128 },
  { label: '1/8" = 1\'-0"', value: 96 },
  { label: '3/16" = 1\'-0"', value: 64 },
  { label: '1/4" = 1\'-0"', value: 48 },
  { label: '3/8" = 1\'-0"', value: 32 },
  { label: '1/2" = 1\'-0"', value: 24 },
  { label: '3/4" = 1\'-0"', value: 16 },
  { label: '1" = 1\'-0"', value: 12 },
  { label: '1 1/2" = 1\'-0"', value: 8 },
  { label: '3" = 1\'-0"', value: 4 },
];

const METRIC_SCALES = [
  { label: '1:1', value: 1 },
  { label: '1:2', value: 2 },
  { label: '1:5', value: 5 },
  { label: '1:10', value: 10 },
  { label: '1:20', value: 20 },
  { label: '1:50', value: 50 },
  { label: '1:100', value: 100 },
  { label: '1:200', value: 200 },
  { label: '1:500', value: 500 },
  { label: '1:1000', value: 1000 },
];

/* ─── tiny shared styles ──────────────────────────────────────────────────── */
const panel: React.CSSProperties = {
  width: 220,
  flexShrink: 0,
  background: '#16171a',
  borderLeft: '1px solid #111',
  display: 'flex',
  flexDirection: 'column',
  fontSize: 12,
  color: '#ccc',
  overflow: 'hidden',
};

const sectionTitle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '1px',
  textTransform: 'uppercase',
  color: '#555',
  padding: '14px 14px 5px',
  borderBottom: '1px solid #1e1f23',
};

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '5px 14px',
};

const lbl: React.CSSProperties = {
  color: '#888',
  fontSize: 11,
};

const numInput: React.CSSProperties = {
  width: 72,
  background: '#1e1f23',
  border: '1px solid #2a2a2e',
  color: '#e0e0e0',
  borderRadius: 5,
  padding: '3px 7px',
  fontSize: 11,
  textAlign: 'right' as const,
  fontVariantNumeric: 'tabular-nums',
};

const select: React.CSSProperties = {
  background: '#1e1f23',
  border: '1px solid #2a2a2e',
  color: '#e0e0e0',
  borderRadius: 5,
  padding: '3px 6px',
  fontSize: 11,
  width: 120,
};

const actionBtn: React.CSSProperties = {
  margin: '4px 14px',
  padding: '6px 0',
  background: '#1e1f23',
  border: '1px solid #2a2a2e',
  borderRadius: 6,
  color: '#ccc',
  fontSize: 11,
  cursor: 'pointer',
  width: 'calc(100% - 28px)',
  textAlign: 'center' as const,
  transition: 'all 0.15s',
};

export function RightSidePanel() {
  const [activeTab, setActiveTab] = useState<'Properties' | 'ToolChest' | 'Masters'>('Properties');
  const [isCollapsed, setIsCollapsed] = useState(false);

  const {
    activeTabId, updateShape,
    customAssets, addCustomAsset,
    customStamps, addCustomStamp, removeCustomStamp,
    setActiveTool, setActiveStamp, activeTool, activeStamp,
    addShape, strokeColor, pushToHistory,
    // Master pages
    masterPages, setMasterPageAssignment, setEditorMode, setActiveMasterPageId,
    // Bleed & CMYK Exporter Actions
    setBleedOffset, setShowBleedGuides, setColorSpaceMode,
    bringToFront, sendToBack,
  } = useStore(
    useShallow((s) => ({
      activeTabId: s.activeTabId,
      updateShape: s.updateShape,
      customAssets: s.customAssets,
      addCustomAsset: s.addCustomAsset,
      customStamps: s.customStamps,
      addCustomStamp: s.addCustomStamp,
      removeCustomStamp: s.removeCustomStamp,
      setActiveTool: s.setActiveTool,
      setActiveStamp: s.setActiveStamp,
      activeTool: s.activeTool,
      activeStamp: s.activeStamp,
      addShape: s.addShape,
      strokeColor: s.strokeColor,
      pushToHistory: s.pushToHistory,
      masterPages: s.masterPages,
      setMasterPageAssignment: s.setMasterPageAssignment,
      setEditorMode: s.setEditorMode,
      setActiveMasterPageId: s.setActiveMasterPageId,
      setBleedOffset: s.setBleedOffset,
      setShowBleedGuides: s.setShowBleedGuides,
      setColorSpaceMode: s.setColorSpaceMode,
      bringToFront: s.bringToFront,
      sendToBack: s.sendToBack,
    }))
  );

  const doc = useStore((s) => (s.activeTabId ? s.documents[s.activeTabId] : null));
  const shapes = doc?.shapes || [];
  const selectedShapeIds = doc?.selectedShapeIds || [];

  const selectedShape = selectedShapeIds.length === 1
    ? shapes.find(s => s.id === selectedShapeIds[0])
    : null;

  const [docPageSizes, setDocPageSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [splitSpreads, setSplitSpreads] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!doc?.pdfBytes) {
      setDocPageSizes({});
      return;
    }

    let active = true;
    const bytes = doc.pdfBytes;
    const loadSizes = async () => {
      try {
        const pdf = await acquirePdfDoc(bytes);
        if (!active) return;

        const sizes: Record<number, { width: number; height: number }> = {};
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          if (!active) return;
          const vp = page.getViewport({ scale: 1.0 });
          sizes[i] = { width: vp.width, height: vp.height };
          page.cleanup();
        }
        if (active) {
          setDocPageSizes(sizes);
        }
      } catch (err) {
        console.error("Error loading PDF page sizes for mismatch checks:", err);
      }
    };

    loadSizes();
    return () => {
      active = false;
      releasePdfDoc(bytes);
    };
  }, [doc?.pdfBytes]);

  // Auto-switch to Properties when a shape is selected
  useEffect(() => {
    if (selectedShapeIds.length > 0) {
      setActiveTab('Properties');
      setIsCollapsed(false);
    }
  }, [selectedShapeIds]);

  // Auto-switch to Assets when stamp (or image) tool is activated
  useEffect(() => {
    if (activeTool === 'stamp' || activeTool === 'image') {
      setActiveTab('ToolChest');
      setIsCollapsed(false);
    }
  }, [activeTool]);

  const handlePropChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>, prop: string) => {
    let val: any = e.target.value;
    if (e.target.type === 'number' || e.target.type === 'range') val = parseFloat(val);
    if (selectedShapeIds.length > 0) pushToHistory();
    const POINT_BASED_TYPES = [
      'line', 'arrow', 'measure_length', 'measure_area',
      'cloud', 'callout', 'polyline', 'polygon', 'spline', 'arc',
      'freehand', 'brush', 'highlight'
    ];
    selectedShapeIds.forEach(id => {
      const updates: any = { [prop]: val };
      const s = shapes.find(x => x.id === id);
      if (s && POINT_BASED_TYPES.includes(s.type || '')) {
        if (prop === 'x') {
          const dx = val - (s.x || 0);
          if (s.points) {
            updates.points = s.points.map((p, i) => i % 2 === 0 ? p + dx : p);
          }
          if (s.type === 'cloud') {
            shapes.forEach(child => {
              if (child.type === 'callout' && child.parentId === s.id) {
                const childUpdates: any = { x: (child.x || 0) + dx };
                if (child.points) {
                  childUpdates.points = child.points.map((p, i) => i % 2 === 0 ? p + dx : p);
                }
                updateShape(child.id, childUpdates);
              }
            });
          }
        } else if (prop === 'y') {
          const dy = val - (s.y || 0);
          if (s.points) {
            updates.points = s.points.map((p, i) => i % 2 !== 0 ? p + dy : p);
          }
          if (s.type === 'cloud') {
            shapes.forEach(child => {
              if (child.type === 'callout' && child.parentId === s.id) {
                const childUpdates: any = { y: (child.y || 0) + dy };
                if (child.points) {
                  childUpdates.points = child.points.map((p, i) => i % 2 !== 0 ? p + dy : p);
                }
                updateShape(child.id, childUpdates);
              }
            });
          }
        }
      }
      if (s?.type === 'mark_door' && (prop === 'width' || prop === 'height')) {
        updates.width = val;
        updates.height = val;
      }
      if (s?.type === 'mark_double_door' && (prop === 'width' || prop === 'height')) {
        updates.width = val;
        updates.height = val / 2;
        if (prop === 'height') {
          updates.width = val * 2;
          updates.height = val;
        }
      }
      updateShape(id, updates);
    });
  };

  const handleMarkerDataChange = (key: string, val: string) => {
    if (!selectedShape) return;
    pushToHistory();
    const newData = { ...(selectedShape.markerData || {}), [key]: val };
    updateShape(selectedShape.id, { markerData: newData });
  };

  const handleAssetUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addCustomAsset(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleStampUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addCustomStamp(reader.result as string);
    reader.readAsDataURL(file);
  };

  /* ── Collapsed state ── */
  if (isCollapsed) {
    return (
      <div style={{
        width: 28, flexShrink: 0,
        background: '#16171a', borderLeft: '1px solid #111',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        paddingTop: 10,
      }}>
        <button
          onClick={() => setIsCollapsed(false)}
          title="Expand panel"
          style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 12, padding: '6px 0' }}
        >◀</button>
      </div>
    );
  }

  /* ── Multi-select ── */
  if (selectedShapeIds.length > 1) {
    return (
      <aside style={panel}>
        <PanelHeader
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onCollapse={() => setIsCollapsed(true)}
        />
        <div style={{ padding: '12px 14px', color: '#666', fontSize: 11, lineHeight: 1.5 }}>
          {selectedShapeIds.length} shapes selected.
        </div>
      </aside>
    );
  }

  return (
    <aside style={panel}>
      <PanelHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onCollapse={() => setIsCollapsed(true)}
      />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}>

        {/* ── PROPERTIES TAB ── */}
        {activeTab === 'Properties' && (
          <>
            {!selectedShape ? (
              <>
                <div style={sectionTitle}>Document Settings</div>
                {doc && (
                  <>
                    <div style={row}>
                      <span style={lbl}>Page Size</span>
                      <span style={{ fontSize: 11, color: '#e0e0e0', fontWeight: 600 }}>
                        {docPageSizes[doc.pageNum] 
                          ? formatPageSize(docPageSizes[doc.pageNum].width, docPageSizes[doc.pageNum].height) 
                          : 'Loading...'}
                      </span>
                    </div>
                    <div style={row}>
                      <span style={lbl}>Total Pages</span>
                      <span style={{ fontSize: 11, color: '#e0e0e0', fontWeight: 600 }}>{doc.numPages}</span>
                    </div>


                    <div style={sectionTitle}>Page Margins & Bleed</div>
                    <div style={row}>
                      <span style={lbl}>Bleed Offset</span>
                      <select
                        id="document-bleed-offset-select"
                        style={select}
                        value={doc.bleedOffset ?? 0}
                        onChange={e => setBleedOffset(parseFloat(e.target.value))}
                      >
                        <option value={0}>None (0")</option>
                        <option value={0.125}>1/8" (0.125")</option>
                        <option value={0.25}>1/4" (0.25")</option>
                        <option value={0.5}>1/2" (0.5")</option>
                      </select>
                    </div>
                    <div style={row}>
                      <span style={lbl}>Show Bleed Guides</span>
                      <input
                        id="document-show-bleed-checkbox"
                        type="checkbox"
                        style={{ cursor: 'pointer' }}
                        checked={doc.showBleedGuides ?? true}
                        onChange={e => setShowBleedGuides(e.target.checked)}
                      />
                    </div>

                    <div style={sectionTitle}>Color Space Profile</div>
                    <div style={row}>
                      <span style={lbl}>Export Color Space</span>
                      <select
                        id="document-color-space-select"
                        style={select}
                        value={doc.colorSpaceMode ?? 'srgb'}
                        onChange={e => setColorSpaceMode(e.target.value as 'srgb' | 'cmyk')}
                      >
                        <option value="srgb">sRGB (Digital Screens)</option>
                        <option value="cmyk">CMYK (Press Printing)</option>
                      </select>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div style={sectionTitle}>Geometry</div>

                {/* X / Y */}
                <div style={row}>
                  <span style={lbl}>X</span>
                  <input type="number" style={numInput} value={Math.round(selectedShape.x)} onChange={e => handlePropChange(e, 'x')} />
                </div>
                <div style={row}>
                  <span style={lbl}>Y</span>
                  <input type="number" style={numInput} value={Math.round(selectedShape.y)} onChange={e => handlePropChange(e, 'y')} />
                </div>

                {/* Width / Height */}
                {selectedShape.width !== undefined && (
                  <div style={row}>
                    <span style={lbl}>Width</span>
                    <input type="number" style={numInput} value={Math.round(selectedShape.width)} onChange={e => handlePropChange(e, 'width')} />
                  </div>
                )}
                {selectedShape.height !== undefined && (
                  <div style={row}>
                    <span style={lbl}>Height</span>
                    <input type="number" style={numInput} value={Math.round(selectedShape.height)} onChange={e => handlePropChange(e, 'height')} />
                  </div>
                )}

                {/* Radius */}
                {selectedShape.radius !== undefined && (
                  <div style={row}>
                    <span style={lbl}>Radius</span>
                    <input type="number" style={numInput} value={Math.round(selectedShape.radius)} onChange={e => handlePropChange(e, 'radius')} />
                  </div>
                )}

                {/* Text content */}
                {['text', 'callout', 'cloud'].includes(selectedShape.type) && (
                  <div style={{ padding: '5px 14px' }}>
                    <div style={{ ...lbl, marginBottom: 4 }}>Text</div>
                    <textarea
                      id="right-panel-textarea"
                      value={selectedShape.text || ''}
                      onFocus={() => pushToHistory()}
                      onChange={e => updateShape(selectedShape.id, { text: e.target.value })}
                      style={{
                        width: '100%', background: '#1e1f23', color: '#ddd',
                        border: '1px solid #2a2a2e', borderRadius: 5,
                        minHeight: 60, padding: '5px 7px', fontSize: 11,
                        resize: 'vertical', boxSizing: 'border-box',
                      }}
                    />
                  </div>
                )}

                {/* Measurement scale */}
                {(selectedShape.type === 'measure_length' || selectedShape.type === 'measure_area') && (
                  <>
                    <div style={sectionTitle}>Measurement</div>
                    <div style={row}>
                      <span style={lbl}>System</span>
                      <select
                        style={select}
                        value={selectedShape.measurementSystem || 'metric'}
                        onChange={e => updateShape(selectedShape.id, { measurementSystem: e.target.value as any, measurementScale: 1 })}
                      >
                        <option value="metric">Metric</option>
                        <option value="imperial">Imperial</option>
                      </select>
                    </div>
                    <div style={row}>
                      <span style={lbl}>Scale</span>
                      <select
                        style={select}
                        value={selectedShape.measurementScale || 1}
                        onChange={e => updateShape(selectedShape.id, { measurementScale: parseFloat(e.target.value) })}
                      >
                        {(selectedShape.measurementSystem === 'imperial' ? IMPERIAL_SCALES : METRIC_SCALES).map(s => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                {/* Table Properties */}
                {selectedShape.type === 'table' && selectedShape.tableData && (
                  <>
                    <div style={sectionTitle}>Table Grid</div>
                    <div style={row}>
                      <span style={lbl}>Border Thickness</span>
                      <input 
                        type="number" style={numInput} 
                        value={selectedShape.tableData.borderThickness} 
                        onChange={e => {
                          pushToHistory();
                          updateShape(selectedShape.id, { 
                            tableData: { ...selectedShape.tableData!, borderThickness: parseFloat(e.target.value) } 
                          });
                        }} 
                      />
                    </div>
                    {selectedShape.tableData.selectedCellIds && selectedShape.tableData.selectedCellIds.length > 0 && (
                      <>
                        <div style={sectionTitle}>Selected Cell(s)</div>
                        <div style={row}>
                          <span style={lbl}>Fill Color</span>
                          <div style={{ position: 'relative' }}>
                            <div 
                              style={{ 
                                ...numInput, 
                                padding: 0, height: 22, width: 40, cursor: 'pointer', 
                                background: selectedShape.tableData.cells[selectedShape.tableData.selectedCellIds[0]]?.fillColor || '#ffffff',
                                border: '1px solid #444'
                              }}
                              onClick={() => document.getElementById('table-cell-color-picker')?.click()}
                            />
                            <input 
                              id="table-cell-color-picker"
                              type="color" 
                              style={{ position: 'absolute', right: 220, top: 0, width: 10, height: 10, opacity: 0 }}
                              value={selectedShape.tableData.cells[selectedShape.tableData.selectedCellIds[0]]?.fillColor || '#ffffff'} 
                              onChange={e => {
                                pushToHistory();
                                const newCells = { ...selectedShape.tableData!.cells };
                                selectedShape.tableData!.selectedCellIds!.forEach(id => {
                                  newCells[id] = { ...newCells[id], fillColor: e.target.value };
                                });
                                updateShape(selectedShape.id, { 
                                  tableData: { ...selectedShape.tableData!, cells: newCells } 
                                });
                              }} 
                            />
                          </div>
                        </div>
                        <div style={row}>
                          <span style={lbl}>Wrap Text</span>
                          <input 
                            type="checkbox" 
                            style={{ cursor: 'pointer' }}
                            checked={selectedShape.tableData.cells[selectedShape.tableData.selectedCellIds[0]]?.wrapText || false} 
                            onChange={e => {
                              pushToHistory();
                              const newCells = { ...selectedShape.tableData!.cells };
                              selectedShape.tableData!.selectedCellIds!.forEach(id => {
                                newCells[id] = { ...newCells[id], wrapText: e.target.checked };
                              });
                              updateShape(selectedShape.id, { 
                                tableData: { ...selectedShape.tableData!, cells: newCells } 
                              });
                            }} 
                          />
                        </div>
                        {selectedShape.tableData.selectedCellIds.length > 1 && (
                          <button
                            style={{ ...actionBtn, borderColor: 'rgba(77,166,255,0.25)', color: '#4da6ff' }}
                            onClick={() => {
                              pushToHistory();
                              const newCells = { ...selectedShape.tableData!.cells };
                              const ids = selectedShape.tableData!.selectedCellIds!;
                              
                              let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
                              ids.forEach(id => {
                                const [r, c] = id.split('_').map(Number);
                                minR = Math.min(minR, r); minC = Math.min(minC, c);
                                maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
                              });
                              
                              const primaryId = `${minR}_${minC}`;
                              newCells[primaryId] = {
                                ...newCells[primaryId],
                                rowSpan: maxR - minR + 1,
                                colSpan: maxC - minC + 1,
                                isMerged: false,
                              };
                              
                              for (let r = minR; r <= maxR; r++) {
                                for (let c = minC; c <= maxC; c++) {
                                  const id = `${r}_${c}`;
                                  if (id !== primaryId) {
                                    newCells[id] = { ...newCells[id], isMerged: true };
                                  }
                                }
                              }
                              
                              updateShape(selectedShape.id, { 
                                tableData: { ...selectedShape.tableData!, cells: newCells, selectedCellIds: [primaryId] } 
                              });
                            }}
                          >
                            Merge Selected Cells
                          </button>
                        )}
                        {selectedShape.tableData.selectedCellIds.length === 1 && (selectedShape.tableData.cells[selectedShape.tableData.selectedCellIds[0]]?.rowSpan! > 1 || selectedShape.tableData.cells[selectedShape.tableData.selectedCellIds[0]]?.colSpan! > 1) && (
                          <button
                            style={{ ...actionBtn, borderColor: 'rgba(255,100,100,0.25)', color: '#ff6666' }}
                            onClick={() => {
                              pushToHistory();
                              const newCells = { ...selectedShape.tableData!.cells };
                              const primaryId = selectedShape.tableData!.selectedCellIds![0];
                              const cell = newCells[primaryId] || { text: '' };
                              const [minR, minC] = primaryId.split('_').map(Number);
                              const maxR = minR + (cell.rowSpan || 1) - 1;
                              const maxC = minC + (cell.colSpan || 1) - 1;
                              
                              newCells[primaryId] = { ...cell, rowSpan: 1, colSpan: 1 };
                              
                              for (let r = minR; r <= maxR; r++) {
                                for (let c = minC; c <= maxC; c++) {
                                  const id = `${r}_${c}`;
                                  if (id !== primaryId) {
                                    newCells[id] = { ...newCells[id], isMerged: false };
                                  }
                                }
                              }
                              
                              updateShape(selectedShape.id, { 
                                tableData: { ...selectedShape.tableData!, cells: newCells } 
                              });
                            }}
                          >
                            Explode Merged Cell
                          </button>
                        )}
                      </>
                    )}
                  </>
                )}

                {/* Door / Double Door Properties */}
                {['mark_door', 'mark_double_door'].includes(selectedShape.type) && (
                  <>
                    <div style={sectionTitle}>{selectedShape.type === 'mark_door' ? 'Door' : 'Double Door'} Properties</div>
                    <div style={{ padding: '8px 14px' }}>
                      <div style={{ ...lbl, marginBottom: 8 }}>Width Slider</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input 
                          type="range" 
                          min="10" 
                          max="800" 
                          value={selectedShape.width || 40} 
                          onChange={e => handlePropChange(e, 'width')}
                          style={{ flex: 1, accentColor: '#4da6ff', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: 10, color: '#aaa', minWidth: 25 }}>{Math.round(selectedShape.width || 40)}px</span>
                      </div>
                    </div>
                    <div style={row}>
                      <span style={lbl}>Flip Horizontal</span>
                      <input 
                        type="checkbox" 
                        style={{ cursor: 'pointer' }}
                        checked={selectedShape.markerData?.flipH === 'true'} 
                        onChange={e => handleMarkerDataChange('flipH', e.target.checked ? 'true' : 'false')} 
                      />
                    </div>
                    <div style={row}>
                      <span style={lbl}>Flip Vertical</span>
                      <input 
                        type="checkbox" 
                        style={{ cursor: 'pointer' }}
                        checked={selectedShape.markerData?.flipV === 'true'} 
                        onChange={e => handleMarkerDataChange('flipV', e.target.checked ? 'true' : 'false')} 
                      />
                    </div>
                  </>
                )}

                {/* Cloud callout */}
                {selectedShape.type === 'cloud' && (
                  <>
                    <div style={sectionTitle}>Annotations</div>
                    <button
                      style={{ ...actionBtn, color: '#4da6ff', borderColor: 'rgba(77,166,255,0.25)', background: 'rgba(77,166,255,0.07)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.14)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.07)'; }}
                      onClick={() => {
                        const id = Math.random().toString(36).substring(7);
                        const width = 150, height = 60;
                        
                        // Robustly find Cloud center/bounds
                        let minX = selectedShape.x;
                        let minY = selectedShape.y;
                        let maxX = selectedShape.x;
                        let maxY = selectedShape.y;
                        
                        if (selectedShape.points && selectedShape.points.length > 0) {
                            minX = Math.min(...selectedShape.points.filter((_, i) => i % 2 === 0));
                            minY = Math.min(...selectedShape.points.filter((_, i) => i % 2 !== 0));
                            maxX = Math.max(...selectedShape.points.filter((_, i) => i % 2 === 0));
                            maxY = Math.max(...selectedShape.points.filter((_, i) => i % 2 !== 0));
                        }
                        
                        const boxX = maxX + 40;
                        const boxY = minY + (maxY - minY) / 2 - height / 2;
                        
                        // Snap callout leader line to the closest point along the cloud's perimeter
                        let startX = minX, startY = minY;
                        if (selectedShape.points && selectedShape.points.length > 0) {
                          const targetX = boxX, targetY = boxY + height / 2;
                          let minDst = Infinity;
                          let bestSeg = 0;
                          for (let i = 0; i < selectedShape.points.length; i += 2) {
                            const x1 = selectedShape.points[i], y1 = selectedShape.points[i + 1];
                            const ni = (i + 2) % selectedShape.points.length;
                            const x2 = selectedShape.points[ni], y2 = selectedShape.points[ni + 1];
                            
                            const A = targetX - x1, B = targetY - y1, C = x2 - x1, D = y2 - y1;
                            const dot = A * C + B * D, len_sq = C * C + D * D;
                            let param = len_sq !== 0 ? dot / len_sq : -1;
                            let xx, yy;
                            if (param < 0) { xx = x1; yy = y1; }
                            else if (param > 1) { xx = x2; yy = y2; }
                            else { xx = x1 + param * C; yy = y1 + param * D; }
                            const dst = Math.pow(targetX - xx, 2) + Math.pow(targetY - yy, 2);
                            if (dst < minDst) { minDst = dst; startX = xx; startY = yy; bestSeg = i; }
                          }
                          
                          const bX1 = selectedShape.points[bestSeg], bY1 = selectedShape.points[bestSeg + 1];
                          const ni = (bestSeg + 2) % selectedShape.points.length;
                          const bX2 = selectedShape.points[ni], bY2 = selectedShape.points[ni + 1];
                          const dx = bX2 - bX1, dy = bY2 - bY1, len = Math.sqrt(dx * dx + dy * dy);
                          if (len > 0) {
                            const bump = Math.max(selectedShape.radius || 20, 5);
                            const dist_along = Math.sqrt(Math.pow(startX - bX1, 2) + Math.pow(startY - bY1, 2));
                            const f = Math.min(1, Math.max(0, dist_along / len));
                            const arcCount = Math.max(1, Math.round(len / (bump * 1.5)));
                            const j = Math.min(arcCount - 1, Math.floor(f * arcCount));
                            const lt = (f * arcCount) - j;
                            
                            const p0x = bX1 + (j / arcCount) * dx, p0y = bY1 + (j / arcCount) * dy;
                            const p2x = bX1 + ((j + 1) / arcCount) * dx, p2y = bY1 + ((j + 1) / arcCount) * dy;
                            const amx = (p0x + p2x) / 2, amy = (p0y + p2y) / 2;
                            const p1x = amx + (-dy / len) * bump, p1y = amy + (dx / len) * bump;
                            
                            const mt = 1 - lt;
                            startX = mt * mt * p0x + 2 * mt * lt * p1x + lt * lt * p2x;
                            startY = mt * mt * p0y + 2 * mt * lt * p1y + lt * lt * p2y;
                          }
                        }
                        const isRight = boxX + width / 2 > startX;
                        const elbowX = isRight ? boxX - 20 : boxX + width + 20;
                        const elbowY = boxY + height / 2;
                        addShape({
                          id, type: 'callout', parentId: selectedShape.id,
                          x: boxX, y: boxY,
                          points: [startX, startY, elbowX, elbowY],
                          width, height,
                          text: 'Double click to edit...',
                          fontSize: 16, fontFamily: 'Inter',
                          strokeColor, strokeWidth: useStore.getState().strokeWidth,
                          page: selectedShape.page,
                          author: 'Drafting User',
                          date: new Date().toLocaleDateString(),
                        });
                        useStore.getState().pushToHistory();
                      }}
                    >
                      + Add Callout
                    </button>
                  </>
                )}

                {selectedShape.type === 'content_box' && (
                  <>
                    <div style={sectionTitle}>Frame Border</div>
                    <div style={row}>
                      <span style={lbl}>Border Visible</span>
                      <input 
                        type="checkbox" 
                        style={{ cursor: 'pointer' }}
                        checked={selectedShape.strokeColor !== 'transparent'} 
                        onChange={e => {
                          pushToHistory();
                          const isVisible = e.target.checked;
                          updateShape(selectedShape.id, { 
                            strokeColor: isVisible ? '#4da6ff' : 'transparent',
                            strokeWidth: isVisible ? (selectedShape.strokeWidth || 2) : 0
                          });
                        }} 
                      />
                    </div>
                    {selectedShape.strokeColor !== 'transparent' && (
                      <>
                        <div style={row}>
                          <span style={lbl}>Border Color</span>
                          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                            <div 
                              style={{ 
                                ...numInput, 
                                padding: 0, height: 22, width: 40, cursor: 'pointer', 
                                background: selectedShape.strokeColor && selectedShape.strokeColor.startsWith('#') ? selectedShape.strokeColor : '#4da6ff',
                                border: '1px solid #444'
                              }}
                              onClick={() => document.getElementById('frame-border-color-picker')?.click()}
                            />
                            <input 
                              id="frame-border-color-picker"
                              type="color" 
                              style={{ position: 'absolute', right: 220, top: 0, width: 10, height: 10, opacity: 0 }}
                              value={selectedShape.strokeColor && selectedShape.strokeColor.startsWith('#') ? selectedShape.strokeColor : '#4da6ff'} 
                              onChange={e => {
                                pushToHistory();
                                updateShape(selectedShape.id, { strokeColor: e.target.value });
                              }} 
                            />
                          </div>
                        </div>
                        <div style={row}>
                          <span style={lbl}>Border Width</span>
                          <input 
                            type="number" 
                            min="1" 
                            max="20"
                            style={numInput}
                            value={selectedShape.strokeWidth ?? 2} 
                            onChange={e => {
                              const v = parseFloat(e.target.value) || 1;
                              pushToHistory();
                              updateShape(selectedShape.id, { strokeWidth: v });
                            }} 
                          />
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* Layering */}
                <div style={sectionTitle}>Layering</div>
                <button style={actionBtn}
                  onClick={bringToFront}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#26272c'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#1e1f23'; }}
                >
                  Bring to Front
                </button>
                <button style={actionBtn}
                  onClick={sendToBack}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#26272c'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#1e1f23'; }}
                >
                  Send to Back
                </button>
              </>
            )}
          </>
        )}

        {/* ── TOOLCHEST TAB ── */}
        {activeTab === 'ToolChest' && (
          <>
            <div style={sectionTitle}>Stamps</div>
            <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { id: 'APPROVED', label: 'APPROVED', color: '#4ade80' },
                { id: 'REJECTED', label: 'REJECTED', color: '#ef4444' },
                { id: 'DRAFT',    label: 'DRAFT',    color: '#facc15' },
              ].map(stamp => {
                const isActive = activeTool === 'stamp' && activeStamp === stamp.id;
                return (
                  <button
                    key={stamp.id}
                    onClick={() => { setActiveTool('stamp'); setActiveStamp(stamp.id); }}
                    style={{
                      padding: '7px', borderRadius: 6, cursor: 'pointer',
                      border: `1px solid ${isActive ? stamp.color + '88' : '#2a2a2e'}`,
                      background: isActive ? stamp.color + '15' : '#1e1f23',
                      color: stamp.color,
                      fontWeight: 700, letterSpacing: '1.5px', fontSize: 11,
                      fontFamily: '"Times New Roman", serif',
                      transition: 'all 0.15s',
                    }}
                  >
                    {stamp.label}
                  </button>
                );
              })}

              {customStamps && customStamps.map((url, i) => {
                const isActive = activeTool === 'stamp' && activeStamp === url;
                return (
                  <div
                    key={`custom_stamp_${i}`}
                    style={{ position: 'relative', border: '1px solid #2a2a2e', borderRadius: 6, overflow: 'hidden', padding: 4, background: isActive ? 'rgba(77,166,255,0.15)' : '#1e1f23', cursor: 'pointer', minHeight: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={() => { setActiveTool('stamp'); setActiveStamp(url); }}
                    onMouseEnter={e => {
                      const btn = (e.currentTarget as HTMLElement).querySelector('.stamp-delete-btn') as HTMLElement | null;
                      if (btn) btn.style.opacity = '1';
                    }}
                    onMouseLeave={e => {
                      const btn = (e.currentTarget as HTMLElement).querySelector('.stamp-delete-btn') as HTMLElement | null;
                      if (btn) btn.style.opacity = '0';
                    }}
                  >
                    <img src={url} style={{ maxHeight: 34, maxWidth: '100%', objectFit: 'contain' }} />
                    <button
                      className="stamp-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Also clear active stamp if it was this one
                        if (activeStamp === url) setActiveStamp('APPROVED');
                        removeCustomStamp(i);
                      }}
                      style={{
                        position: 'absolute', top: 2, right: 2,
                        width: 18, height: 18,
                        background: 'rgba(15,15,18,0.88)', border: '1px solid rgba(255,80,80,0.5)',
                        borderRadius: 4, color: '#ff6060', fontSize: 10, lineHeight: 1,
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        opacity: 0, transition: 'opacity 0.15s', padding: 0,
                      }}
                      title="Remove stamp"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}

              <label
                style={{
                  ...actionBtn, margin: '4px 0', display: 'block',
                  cursor: 'pointer', color: '#4da6ff',
                  borderColor: 'rgba(77,166,255,0.25)',
                  background: 'rgba(77,166,255,0.07)',
                }}
              >
                + Upload Stamp
                <input type="file" hidden accept="image/*" onChange={handleStampUpload} />
              </label>
            </div>

            <div style={sectionTitle}>Custom Assets</div>
            <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(!customAssets || customAssets.length === 0) ? (
                <span style={{ color: '#444', fontSize: 11, lineHeight: 1.5 }}>
                  Upload your own images to place on the canvas.
                </span>
              ) : (
                customAssets.map((url, i) => (
                  <div
                    key={i}
                    style={{ position: 'relative', border: '1px solid #2a2a2e', borderRadius: 5, overflow: 'hidden' }}
                    onMouseEnter={e => {
                      const btn = (e.currentTarget as HTMLElement).querySelector('.asset-delete-btn') as HTMLElement | null;
                      if (btn) btn.style.opacity = '1';
                    }}
                    onMouseLeave={e => {
                      const btn = (e.currentTarget as HTMLElement).querySelector('.asset-delete-btn') as HTMLElement | null;
                      if (btn) btn.style.opacity = '0';
                    }}
                  >
                    <img
                      src={url}
                      alt="Asset"
                      draggable={true}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', url);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        document.body.style.cursor = 'copy';
                        useStore.getState().setDraggingAssetIndex(i);
                      }}
                      style={{
                        width: '100%', objectFit: 'contain', maxHeight: 80,
                        display: 'block', cursor: 'grab', touchAction: 'none'
                      }}
                    />
                    <button
                      className="asset-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        useStore.getState().removeCustomAsset(i);
                      }}
                      style={{
                        position: 'absolute', top: 4, right: 4,
                        width: 20, height: 20,
                        background: 'rgba(15,15,18,0.88)',
                        border: '1px solid rgba(255,80,80,0.5)',
                        borderRadius: 4,
                        color: '#ff6060',
                        fontSize: 11, lineHeight: 1,
                        cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        opacity: 0,
                        transition: 'opacity 0.15s, background 0.15s',
                        padding: 0,
                      }}
                      title="Remove asset"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
              <label
                style={{
                  ...actionBtn, margin: '4px 0', display: 'block',
                  cursor: 'pointer', color: '#4da6ff',
                  borderColor: 'rgba(77,166,255,0.25)',
                  background: 'rgba(77,166,255,0.07)',
                }}
              >
                ↑ Upload Image
                <input type="file" hidden accept="image/*" onChange={handleAssetUpload} />
              </label>
            </div>
          </>
        )}
        {/* ── MASTERS TAB ── */}
        {activeTab === 'Masters' && (
          <>
            <div style={sectionTitle}>Page Master Assignments</div>
            {!activeTabId || !doc ? (
              <div style={{ padding: '14px', color: '#444', fontSize: 11, lineHeight: 1.6 }}>
                Open a document to assign masters to pages.
              </div>
            ) : doc.numPages === 0 ? (
              <div style={{ padding: '14px', color: '#444', fontSize: 11, lineHeight: 1.6 }}>
                No pages found in this document.
              </div>
            ) : masterPages.length === 0 ? (
              <div style={{ padding: '14px', color: '#444', fontSize: 11, lineHeight: 1.8 }}>
                No Master Pages defined yet.
                <br />
                <button
                  id="rsp-open-master-editor-btn"
                  onClick={() => { setEditorMode('master'); }}
                  style={{
                    marginTop: 8,
                    padding: '6px 10px',
                    background: 'rgba(245,158,11,0.1)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    borderRadius: 5,
                    color: '#f59e0b',
                    fontSize: 11,
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  Open Master Editor
                </button>
              </div>
            ) : (
              <div style={{ padding: '8px 0' }}>
                {doc.isSpread ? (
                  getSpreads(doc.numPages, doc.hasFrontCover || false, doc.hasBackCover || false).map(spread => {
                    const pages = spread.pages;
                    const isSplit = pages.length > 1 && !!splitSpreads[spread.index];

                    if (isSplit) {
                      return (
                        <div key={spread.index} style={{ borderBottom: '1px solid #1a1b1f', paddingBottom: 4 }}>
                          <div style={{ ...row, paddingTop: 4, paddingBottom: 2 }}>
                            <span style={{ ...lbl, fontWeight: 600, color: '#f59e0b' }}>{spread.label}</span>
                            <button
                              onClick={() => setSplitSpreads(prev => ({ ...prev, [spread.index]: false }))}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#4da6ff',
                                fontSize: 9,
                                cursor: 'pointer',
                                padding: 0,
                                textDecoration: 'underline'
                              }}
                            >
                              Combine to Spread
                            </button>
                          </div>
                          {pages.map(pageNum => {
                            const assigned = doc.masterPageAssignments?.[pageNum] ?? null;
                            const mismatch = checkMismatchForPages([pageNum], assigned, docPageSizes, masterPages);
                            return (
                              <div key={pageNum} style={{ ...row, paddingTop: 2, paddingBottom: 2, paddingLeft: 24 }}>
                                <span style={{ ...lbl, fontSize: 10 }}>Page {pageNum}</span>
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                  <select
                                    id={`master-assign-page-${pageNum}`}
                                    style={{ ...select, width: 112, fontSize: 10, height: 22, padding: '2px 4px' }}
                                    value={assigned || ''}
                                    onChange={e => {
                                      const val = e.target.value || null;
                                      if (activeTabId) setMasterPageAssignment(activeTabId, pageNum, val);
                                    }}
                                  >
                                    <option value="">— None —</option>
                                    {masterPages.map(m => (
                                      <option key={m.id} value={m.id}>{m.name}</option>
                                    ))}
                                  </select>
                                  {mismatch && <MismatchWarning docLabel={mismatch.docLabel} masterLabel={mismatch.masterLabel} />}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    }

                    const first = doc.masterPageAssignments?.[pages[0]] ?? null;
                    const allSame = pages.every(p => (doc.masterPageAssignments?.[p] ?? null) === first);
                    const assigned = allSame ? first : 'mixed';
                    const mismatch = checkMismatchForPages(pages, allSame ? first : null, docPageSizes, masterPages);

                    return (
                      <div key={spread.index} style={{ ...row, paddingTop: 4, paddingBottom: 4, borderBottom: '1px solid #1a1b1f' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ ...lbl, minWidth: 64 }}>{spread.label}</span>
                          {pages.length > 1 && (
                            <button
                              onClick={() => setSplitSpreads(prev => ({ ...prev, [spread.index]: true }))}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#f59e0b',
                                fontSize: 9,
                                cursor: 'pointer',
                                padding: 0,
                                textAlign: 'left',
                                textDecoration: 'underline',
                                marginTop: 2
                              }}
                            >
                              Split to Pages
                            </button>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <select
                            id={`master-assign-spread-${spread.index}`}
                            style={{ ...select, width: 112, fontSize: 10 }}
                            value={assigned || ''}
                            onChange={e => {
                              const val = e.target.value || null;
                              if (val === 'mixed') return;
                              if (activeTabId) {
                                pages.forEach(pageNum => {
                                  setMasterPageAssignment(activeTabId, pageNum, val);
                                });
                              }
                            }}
                          >
                            <option value="">— None —</option>
                            {assigned === 'mixed' && (
                              <option value="mixed" disabled>— Mixed —</option>
                            )}
                            {masterPages.map(m => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </select>
                          {mismatch && <MismatchWarning docLabel={mismatch.docLabel} masterLabel={mismatch.masterLabel} />}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  Array.from({ length: doc.numPages }, (_, i) => i + 1).map(pageNum => {
                    const assigned = doc.masterPageAssignments?.[pageNum] ?? null;
                    const mismatch = checkMismatchForPages([pageNum], assigned, docPageSizes, masterPages);
                    return (
                      <div key={pageNum} style={{ ...row, paddingTop: 4, paddingBottom: 4, borderBottom: '1px solid #1a1b1f' }}>
                        <span style={{ ...lbl, minWidth: 44 }}>Page {pageNum}</span>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <select
                            id={`master-assign-page-${pageNum}`}
                            style={{ ...select, width: 112, fontSize: 10 }}
                            value={assigned || ''}
                            onChange={e => {
                              const val = e.target.value || null;
                              if (activeTabId) setMasterPageAssignment(activeTabId, pageNum, val);
                            }}
                          >
                            <option value="">— None —</option>
                            {masterPages.map(m => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </select>
                          {mismatch && <MismatchWarning docLabel={mismatch.docLabel} masterLabel={mismatch.masterLabel} />}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            <div style={sectionTitle}>Master Pages</div>
            {masterPages.length === 0 ? (
              <div style={{ padding: '5px 14px', color: '#444', fontSize: 11 }}>No masters defined.</div>
            ) : (
              masterPages.map(m => (
                <div key={m.id} style={{ ...row, borderBottom: '1px solid #1a1b1f' }}>
                  <span style={{ ...lbl, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                  <button
                    id={`rsp-edit-master-${m.id}-btn`}
                    onClick={() => {
                      setActiveMasterPageId(m.id);
                      setEditorMode('master');
                    }}
                    style={{
                      background: 'none',
                      border: '1px solid #2a2a2e',
                      borderRadius: 4,
                      color: '#f59e0b',
                      fontSize: 10,
                      cursor: 'pointer',
                      padding: '2px 7px',
                    }}
                  >
                    Edit
                  </button>
                </div>
              ))
            )}

            <button
              id="rsp-open-master-editor-full-btn"
              onClick={() => setEditorMode('master')}
              style={{
                ...actionBtn,
                marginTop: 8,
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.25)',
                color: '#f59e0b',
                fontWeight: 600,
              }}
            >
              Open Master Editor
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

/* ─── Panel header tabs ─────────────────────────────────────────────────────── */
function PanelHeader({
  activeTab, setActiveTab, onCollapse,
}: {
  activeTab: 'Properties' | 'ToolChest' | 'Masters';
  setActiveTab: (t: 'Properties' | 'ToolChest' | 'Masters') => void;
  onCollapse: () => void;
}) {
  const tabs: Array<{ key: 'Properties' | 'ToolChest' | 'Masters'; label: string }> = [
    { key: 'Properties', label: 'Props' },
    { key: 'ToolChest', label: 'Assets' },
    { key: 'Masters',   label: 'Masters' },
  ];
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      borderBottom: '1px solid #111',
      background: '#1a1b1f',
      flexShrink: 0,
    }}>
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          id={`panel-tab-${key.toLowerCase()}`}
          onClick={() => setActiveTab(key)}
          style={{
            flex: 1, padding: '8px 4px',
            background: 'none', border: 'none',
            borderBottom: activeTab === key
              ? (key === 'Masters' ? '2px solid #f59e0b' : '2px solid #4da6ff')
              : '2px solid transparent',
            color: activeTab === key
              ? (key === 'Masters' ? '#f59e0b' : '#4da6ff')
              : '#666',
            fontWeight: activeTab === key ? 600 : 400,
            fontSize: 10, cursor: 'pointer',
            transition: 'all 0.15s',
          }}
        >
          {label}
        </button>
      ))}
      <button
        onClick={onCollapse}
        title="Collapse panel"
        style={{
          background: 'none', border: 'none', color: '#444',
          cursor: 'pointer', padding: '8px 10px', fontSize: 11,
          flexShrink: 0,
        }}
      >▶</button>
    </div>
  );
}

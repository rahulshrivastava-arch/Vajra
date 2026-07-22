import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/useStore';
import { PatternEngine } from '../utils/PatternEngine';
import type { ShapeData, TableCell } from '../store/types';
import { isMarkType } from './MarksRenderer';
import { flattenPdf, flattenPdfRasterized } from '../utils/pdfExporter';

/* ─── Tools ──────────────────────────────────────────────────────────────── */
const TOOLS = [
  { id: 'select',         label: 'Select',   icon: 'M5 3l14 9-7 2-3 7L5 3z' },
  { id: 'pan',            label: 'Pan',       icon: 'M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0m-2 6V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v6m-2 4h20l-2 5H5l-2-5z' },
  { id: 'line',           label: 'Line',      icon: 'M5 19L19 5' },
  { id: 'arrow',          label: 'Arrow',     icon: 'M5 12h14M12 5l7 7-7 7' },
  { id: 'rect',           label: 'Rect',      icon: 'M3 3h18v18H3z' },
  { id: 'circle',         label: 'Circle',    icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z' },
  { id: 'freehand',       label: 'Freehand',  icon: 'M3 17c3-2 4-6 7-8s5 4 8 2' },
  { id: 'cloud',          label: 'Cloud',     icon: 'M18 10h-1.3A7 7 0 1 0 5 15h13a3 3 0 0 0 0-5z' },
  { id: 'polyline',       label: 'Polyline',  icon: 'M3 20l5-8 4 5 3-4 6 7' },
  { id: 'polygon',        label: 'Polygon',   icon: 'M12 2l4.5 7.5h7.5l-6 5.5 2.5 8L12 19l-8.5 4 2.5-8-6-5.5h7.5z' },
  { id: 'spline',         label: 'Spline',    icon: 'M3 12c4-8 12 8 18 0' },
  { id: 'arc',            label: 'Arc',       icon: 'M5 15a10 10 0 0 1 14 0' },
  { id: 'text',           label: 'Text',      icon: 'M4 7V4h16v3M9 20h6M12 4v16' },
  { id: 'measure_length', label: 'Length',    icon: 'M3 12h18M3 6v12M21 6v12' },
  { id: 'measure_area',   label: 'Area',      icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
  { id: 'stamp',          label: 'Stamp',     icon: 'M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z' },
  { id: 'highlight',      label: 'Highlight', icon: 'M15.5 3.5c.5-.5 1.3-.5 1.8 0l3.2 3.2c.5.5.5 1.3 0 1.8L8.5 20.5 3 22l1.5-5.5L15.5 3.5' },
  { id: 'brush',          label: 'Brush',     icon: 'M13.447 11.553l8.553-8.553a2 2 0 0 0-2.828-2.828l-8.553 8.553M10.5 11.5l5 5-11 11-4-1 1-4 11-11z' },
  { id: 'table',          label: 'Table',     icon: 'M3 3h18v18H3V3z M3 9h18 M3 15h18 M9 3v18 M15 3v18' },
  { id: 'content_box',   label: 'Frame',     icon: 'M2 2h20v20H2z M6 6h12v12H6z M6 6l12 12M18 6L6 18' },
];

const askSpreadSaveOption = async (tabId: string): Promise<boolean> => {
  const state = useStore.getState();
  const doc = state.documents[tabId];
  if (doc?.isSpread) {
    try {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      return await ask(
        'Do you want to save the document in Spread layout (merged side-by-side pages)? If you choose No, the document will be saved in Single Page layout and spine-crossing elements will be duplicated.',
        {
          title: 'Spread Layout Save Option',
          okLabel: 'Spread',
          cancelLabel: 'Single Page',
        }
      );
    } catch (err) {
      console.error('Failed to show ask spread save option dialog:', err);
      return false;
    }
  }
  return false;
};

/* ─── Mark Tools Definition ─────────────────────────────────────────────── */
const MARKS_TOOLS = [
  {
    id: 'mark_section',
    label: 'Section',
    desc: 'Section cut line\nwith eye head',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="8" cy="18" r="6" />
        <line x1="14" y1="18" x2="26" y2="18" />
        <polygon points="8,5 4,12 12,12" fill="currentColor" stroke="none" />
        <text x="8" y="21" fontSize="6" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="bold">A</text>
      </svg>
    ),
  },
  {
    id: 'mark_level',
    label: 'Level',
    desc: 'Datum level line\nwith floor labels',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="2" y1="14" x2="14" y2="14" strokeDasharray="3 2" />
        <path d="M20 14 L14 14 A6 6 0 0 1 20 8 Z" fill="currentColor" stroke="none" />
        <path d="M20 14 L26 14 A6 6 0 0 1 20 20 Z" fill="currentColor" stroke="none" />
        <circle cx="20" cy="14" r="6" />
        <line x1="14" y1="14" x2="26" y2="14" />
        <line x1="20" y1="8" x2="20" y2="20" />
        <text x="12" y="11" fontSize="6" textAnchor="end" fill="currentColor" stroke="none">Lvl</text>
        <text x="12" y="21" fontSize="6" textAnchor="end" fill="currentColor" stroke="none">0'</text>
      </svg>
    ),
  },
  {
    id: 'mark_grid',
    label: 'Grid',
    desc: 'Grid bubble line',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="7" cy="14" r="6" />
        <text x="7" y="18" fontSize="9" textAnchor="middle" fill="currentColor" stroke="none">A</text>
        <line x1="13" y1="14" x2="28" y2="14" strokeDasharray="4 3" />
      </svg>
    ),
  },
  {
    id: 'mark_elevation',
    label: 'Elevation',
    desc: 'Elevation stamp\ndiamond marker',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="14,4 24,14 14,24 4,14" fill="currentColor" stroke="none" />
        <circle cx="14" cy="14" r="7.1" fill="#1e1f23" stroke="currentColor" strokeWidth="1.5" />
        <text x="14" y="16" fontSize="5" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="bold">A1</text>
        <text x="14" y="8" fontSize="4.5" textAnchor="middle" fill="currentColor" stroke="none">N</text>
        <text x="14" y="26" fontSize="4.5" textAnchor="middle" fill="currentColor" stroke="none">S</text>
        <text x="3.5" y="16" fontSize="4.5" textAnchor="end" fill="currentColor" stroke="none">W</text>
        <text x="24.5" y="16" fontSize="4.5" textAnchor="start" fill="currentColor" stroke="none">E</text>
      </svg>
    ),
  },
  {
    id: 'mark_callout',
    label: 'Callout',
    desc: 'Detail callout\ndashed box + tag',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="6" width="20" height="18" rx="3" strokeDasharray="5 3" />
        <circle cx="22" cy="6" r="5" fill="#1e1f23" stroke="currentColor" strokeWidth="1.5" />
        <text x="22" y="8" fontSize="5" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="bold">A1</text>
      </svg>
    ),
  },
  {
    id: 'mark_door',
    label: 'Single Door',
    desc: 'Single door marker\nwith swing arc',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="8" y1="22" x2="8" y2="6" strokeWidth="4" strokeLinecap="square" />
        <path d="M 8 6 A 16 16 0 0 1 24 22" />
        <line x1="8" y1="22" x2="24" y2="22" strokeDasharray="2 2" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'mark_double_door',
    label: 'Double Door',
    desc: 'Double door marker\nwith swing arcs',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="4" y1="22" x2="4" y2="10" strokeWidth="3" strokeLinecap="square" />
        <line x1="24" y1="22" x2="24" y2="10" strokeWidth="3" strokeLinecap="square" />
        <path d="M 4 10 A 10 10 0 0 1 14 20" />
        <path d="M 24 10 A 10 10 0 0 0 14 20" />
        <line x1="4" y1="22" x2="24" y2="22" strokeDasharray="2 2" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'mark_single_elevation',
    label: 'Single Elev',
    desc: 'Single elevation\ncircle + arrow',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="14" cy="11" r="8" />
        <polygon points="9,17 19,17 14,24" fill="currentColor" stroke="none" />
        <text x="14" y="13" fontSize="6" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="bold">-</text>
        <text x="14" y="27" fontSize="5" textAnchor="middle" fill="currentColor" stroke="none">-</text>
      </svg>
    ),
  },
  {
    id: 'mark_break_line',
    label: 'Break Line',
    desc: 'Break line with\nmasking region',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M 4 14 L 11 14 L 13 10 L 15 18 L 17 14 L 24 14" />
      </svg>
    ),
  },
];

/* ─── Building Elements Tools Definition ──────────────────────────────────── */
const BUILDING_ELEMENTS_TOOLS = [
  {
    id: 'mark_w_section',
    label: 'W Section',
    desc: 'W-shape steel section\nI-beam profile',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="currentColor">
        <path d="M 6 4 L 22 4 L 22 8 L 16 8 L 16 20 L 22 20 L 22 24 L 6 24 L 6 20 L 12 20 L 12 8 L 6 8 Z" />
      </svg>
    ),
  },
  {
    id: 'mark_insulation',
    label: 'Insulation',
    desc: 'Batting line\nalternating loops',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M 4 14 C 8 4, 12 4, 10 14 C 8 24, 16 24, 14 14 C 12 4, 20 4, 18 14 C 16 24, 24 24, 22 14" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'mark_hat_channel',
    label: 'Hat Channel',
    desc: 'Trapezoidal hat channel\nprofile with flanges',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M 4 22 L 9 22 L 12 10 L 16 10 L 19 22 L 24 22" />
      </svg>
    ),
  },
  {
    id: 'mark_masonry_ties',
    label: 'Masonry Ties',
    desc: 'Masonry tie assembly\nbracket + wire',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
        <path d="M 10 6 L 10 14 L 18 14" />
        <rect x="8.5" y="9" width="1.5" height="3" fill="currentColor" stroke="none" />
        <path d="M 16 12 Q 18 10, 20 12 L 22 15 L 26 15" />
        <line x1="16" y1="13" x2="16" y2="22" />
        <path d="M 2 10 L 8 12 M 2 14 L 8 14 M 2 18 L 8 16" strokeWidth="0.8" />
      </svg>
    ),
  },
  {
    id: 'mark_t_section',
    label: 'T Section',
    desc: 'T-shape steel section\nprofile',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="8" y1="4" x2="8" y2="24" />
        <line x1="8" y1="14" x2="22" y2="14" />
      </svg>
    ),
  },
  {
    id: 'mark_cfmf_stud',
    label: 'CFMF Stud',
    desc: 'Cold-formed metal framing\nstud profile',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M 6 10 L 4 10 L 4 22 L 24 22 L 24 10 L 22 10" />
      </svg>
    ),
  },
  {
    id: 'mark_block',
    label: 'Block',
    desc: 'Block marker\nrect with an X',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="6" y="4" width="16" height="20" />
        <line x1="6" y1="4" x2="22" y2="24" />
        <line x1="22" y1="4" x2="6" y2="24" />
      </svg>
    ),
  },
  {
    id: 'mark_sealant',
    label: 'Sealant W/ backerrod',
    desc: 'Sealant with backer rod\nU-shape + circle',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M 6 4 L 6 16 A 8 8 0 0 0 22 16 L 22 4" />
        <path d="M 6 4 Q 14 10, 22 4" />
        <circle cx="14" cy="18" r="6" />
      </svg>
    ),
  },
  {
    id: 'mark_angle',
    label: 'Angle',
    desc: 'Angle marker\nL-shape with adj. angle',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M 8 6 L 8 22 L 24 22" />
      </svg>
    ),
  },
  {
    id: 'mark_bolt',
    label: 'Bolt',
    desc: 'Bolt/Screw marker\nTapered shaft with head',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M 6 8 A 8 6 0 0 1 22 8 Z" />
        <path d="M 14 3 L 14 6" />
        <path d="M 10 8 L 14 24 L 18 8 Z" />
        <path d="M 11 12 L 17 14" />
        <path d="M 12 18 L 16 20" />
      </svg>
    ),
  },
  {
    id: 'mark_thermal_spacer',
    label: 'Thermal Spacer',
    desc: 'Thermal spacer marker\nStep profile',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M 6 22 L 6 14 L 22 14 L 22 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'mark_metal_deck',
    label: 'Metal Deck',
    desc: 'Metal deck profile\nRepeating trapezoid',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M 4 18 L 8 18 L 10 10 L 18 10 L 20 18 L 24 18" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'line',
    label: 'Line',
    desc: 'Simple line tool',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 19L19 5" />
      </svg>
    ),
  },
  {
    id: 'polyline',
    label: 'Polyline',
    desc: 'Multi-segment line tool',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 20l5-8 4 5 3-4 6 7" />
      </svg>
    ),
  },
  {
    id: 'rect',
    label: 'Rect',
    desc: 'Rectangle shape',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3h18v18H3z" />
      </svg>
    ),
  },
];


/* ─── Marks Toolbar ─────────────────────────────────────────────────────── */
function MarksToolbar({ activeTool, setActiveTool }: {
  activeTool: string;
  setActiveTool: (t: any) => void;
}) {
  const { editorMode } = useStore();
  const isMaster = editorMode === 'master';
  const themeColor = isMaster ? '#f59e0b' : '#4da6ff';
  const themeBg = isMaster ? 'rgba(245,158,11,0.18)' : 'rgba(77,166,255,0.18)';
  const themeOutline = isMaster ? 'rgba(245,158,11,0.45)' : 'rgba(77,166,255,0.45)';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: 0, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700, marginRight: 4 }}>Marks</span>
      {MARKS_TOOLS.map(tool => {
        const active = activeTool === tool.id;
        return (
          <button
            key={tool.id}
            title={tool.desc}
            onClick={() => setActiveTool(tool.id as any)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
              padding: '5px 7px', borderRadius: 6, cursor: 'pointer', border: 'none',
              background: active ? themeBg : 'transparent',
              color: active ? themeColor : '#d0d0d0',
              outline: active ? `1px solid ${themeOutline}` : '1px solid transparent',
              transition: 'all 0.14s', fontSize: 9, fontWeight: active ? 700 : 500, minWidth: 38,
            }}
            onMouseEnter={e => { if (!active) { const el = e.currentTarget as HTMLElement; el.style.background = '#26272c'; el.style.color = isMaster ? '#f59e0b' : '#fff'; } }}
            onMouseLeave={e => { if (!active) { const el = e.currentTarget as HTMLElement; el.style.background = 'transparent'; el.style.color = '#d0d0d0'; } }}
          >
            {React.cloneElement(tool.icon, { width: 13, height: 13 })}
            {tool.label}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Building Elements Toolbar ─────────────────────────────────────────── */
function BuildingElementsToolbar({ activeTool, setActiveTool }: {
  activeTool: string;
  setActiveTool: (t: any) => void;
}) {
  const { editorMode } = useStore();
  const isMaster = editorMode === 'master';
  const themeColor = isMaster ? '#f59e0b' : '#4da6ff';
  const themeBg = isMaster ? 'rgba(245,158,11,0.18)' : 'rgba(77,166,255,0.18)';
  const themeOutline = isMaster ? 'rgba(245,158,11,0.45)' : 'rgba(77,166,255,0.45)';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: 0, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700, marginRight: 4 }}>Elements</span>
      {BUILDING_ELEMENTS_TOOLS.map(tool => {
        const active = activeTool === tool.id;
        return (
          <button
            key={tool.id}
            title={tool.desc}
            onClick={() => setActiveTool(tool.id as any)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
              padding: '5px 7px', borderRadius: 6, cursor: 'pointer', border: 'none',
              background: active ? themeBg : 'transparent',
              color: active ? themeColor : '#d0d0d0',
              outline: active ? `1px solid ${themeOutline}` : '1px solid transparent',
              transition: 'all 0.14s', fontSize: 9, fontWeight: active ? 700 : 500, minWidth: 38,
            }}
            onMouseEnter={e => { if (!active) { const el = e.currentTarget as HTMLElement; el.style.background = '#26272c'; el.style.color = isMaster ? '#f59e0b' : '#fff'; } }}
            onMouseLeave={e => { if (!active) { const el = e.currentTarget as HTMLElement; el.style.background = 'transparent'; el.style.color = '#d0d0d0'; } }}
          >
            {React.cloneElement(tool.icon, { width: 13, height: 13 })}
            {tool.label}
          </button>
        );
      })}
    </div>
  );
}

const Icon = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const btnBase: React.CSSProperties = {
  background: 'transparent', border: '1px solid transparent',
  borderRadius: 6, color: '#ccc', cursor: 'pointer',
  padding: '4px 7px', fontSize: 13,
  display: 'flex', alignItems: 'center', gap: 4, transition: 'all 0.15s',
};

const btnTab: React.CSSProperties = {
  background: 'transparent', border: '1px solid transparent',
  borderRadius: 4, color: '#ccc', cursor: 'pointer',
  padding: '3px 6px', fontSize: 10,
  display: 'flex', alignItems: 'center', gap: 3, transition: 'all 0.15s',
};

/* ─── Menu Bar (File / Edit / View / Help) ──────────────────────────────── */
function MenuBar({ onNewDocument, undo, redo, isScaleMode, setIsScaleMode, setActiveTool, setScale, onInsertImage }: {
  onNewDocument: () => void | Promise<void>;
  undo: () => void; redo: () => void;
  isScaleMode: boolean; setIsScaleMode: (v: boolean) => void;
  setActiveTool: (t: any) => void;
  setScale: (fn: (s: number) => number) => void;
  onInsertImage: (dataUrl: string, w: number, h: number) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Refs for each trigger button so we can position dropdowns precisely
  const fileRef   = useRef<HTMLButtonElement>(null);
  const editRef   = useRef<HTMLButtonElement>(null);
  const insertRef = useRef<HTMLButtonElement>(null);
  const viewRef   = useRef<HTMLButtonElement>(null);
  const helpRef   = useRef<HTMLButtonElement>(null);
  const refs: Record<string, React.RefObject<HTMLButtonElement | null>> = { File: fileRef, Edit: editRef, Insert: insertRef, View: viewRef, Help: helpRef };

  const insertImageRef = useRef<HTMLInputElement>(null);

  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const inBar = barRef.current && barRef.current.contains(e.target as Node);
      const inDropdown = dropdownRef.current && dropdownRef.current.contains(e.target as Node);
      if (!inBar && !inDropdown) setOpen(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const handleSaveAs = async (tabId?: string) => {
    const state = useStore.getState();
    const targetTabId = tabId || state.activeTabId;
    if (!targetTabId) return;
    const doc = state.documents[targetTabId];
    const meta = state.tabMetas[targetTabId];
    const rawBytes = doc?.pdfBytes;
    if (!rawBytes || !meta) return alert('Please load a PDF first.');

    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri) {
      try {
        const isSpreadSave = await askSpreadSaveOption(targetTabId);
        state.setSavingStatus(targetTabId, { progress: 0, mode: 'save' });
        const flattened = await flattenPdf(
          rawBytes,
          doc.shapes,
          true,
          isSpreadSave,
          targetTabId,
          (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'save' })
        );
        state.setSavingStatus(targetTabId, null);

        const blob = new Blob([flattened as any], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = meta.label || 'document.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        state.updateTabMeta(meta.id, { isDirty: false });
      } catch (err) {
        alert('❌ Save As failed: ' + err);
        state.setSavingStatus(targetTabId, null);
      }
      return;
    }

    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      const path = await save({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (path) {
        const isSpreadSave = await askSpreadSaveOption(targetTabId);
        state.setSavingStatus(targetTabId, { progress: 0, mode: 'save' });
        const flattened = await flattenPdf(
          rawBytes,
          doc.shapes,
          true,
          isSpreadSave,
          targetTabId,
          (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'save' })
        );
        await writeFile(path, flattened);
        state.updateTabMeta(meta.id, { isDirty: false, filePath: path, label: path.replace(/^.*[\\\/]/, '') });
      }
    } catch (err) { alert('❌ Save As failed: ' + err); }
    finally {
      state.setSavingStatus(targetTabId, null);
    }
  };

  const handleSave = async () => {
    const state = useStore.getState();
    const targetTabId = state.activeTabId;
    if (!targetTabId) return;
    const doc = state.documents[targetTabId];
    const meta = state.tabMetas[targetTabId];
    const rawBytes = doc?.pdfBytes;
    if (!rawBytes || !meta) return;
    
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (meta.filePath && isTauri) {
      try {
        const isSpreadSave = await askSpreadSaveOption(targetTabId);
        state.setSavingStatus(targetTabId, { progress: 0, mode: 'save' });
        const flattened = await flattenPdf(
          rawBytes,
          doc.shapes,
          true,
          isSpreadSave,
          targetTabId,
          (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'save' })
        );
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(meta.filePath, flattened);
        state.updateTabMeta(meta.id, { isDirty: false });
      } catch (err) { alert('❌ Save failed: ' + err); }
      finally {
        state.setSavingStatus(targetTabId, null);
      }
    } else {
      await handleSaveAs(targetTabId);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  type Sep = { type: 'sep' };
  type Entry = { type: 'item'; label: string; input?: boolean; onClick?: () => void };
  type MenuItem = Sep | Entry;

  const { editorMode, activeMasterPageId, masterPages } = useStore();
  const activeMasterName = masterPages.find(m => m.id === activeMasterPageId)?.name || 'Master';

  const fileItems: MenuItem[] = editorMode === 'master' ? [
    { type: 'item', label: '💾  Save & Apply Masters', onClick: async () => { setOpen(null); useStore.getState().setEditorMode('document'); } },
    { type: 'sep' },
    { type: 'item', label: '🚪  Done Editing Masters', onClick: () => { setOpen(null); useStore.getState().setEditorMode('document'); } }
  ] : [
    { type: 'item', label: '📄  New Blank Document', onClick: async () => { setOpen(null); await onNewDocument(); } },
      { type: 'sep' },
      { type: 'item', label: '📂  Open PDF…', onClick: async () => {
        setOpen(null);
        const isTauri = !!(window as any).__TAURI_INTERNALS__;
        if (isTauri) {
          try {
            const { open: pick } = await import('@tauri-apps/plugin-dialog');
            const { readFile } = await import('@tauri-apps/plugin-fs');
            const sel = await pick({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
            if (sel && typeof sel === 'string') {
              const bytes = await readFile(sel);
              const targetTabId = `tab-${Date.now()}`;
              const fileName = sel.replace(/^.*[\\\/]/, '');
              useStore.getState().openTab(targetTabId, { label: fileName, isDirty: false, filePath: sel });
              useStore.getState().setPdfBytes(bytes);
            }
          } catch (err) { alert('❌ Open failed: ' + err); }
        } else {
          document.getElementById('browser-open-pdf-input')?.click();
        }
      }},
      { type: 'sep' },
      { type: 'item', label: '💾  Save', onClick: async () => { setOpen(null); await handleSave(); } },
      { type: 'item', label: '💾  Save As…', onClick: async () => { setOpen(null); await handleSaveAs(); } },
      { type: 'sep' },
      { type: 'item', label: '💾  Save Markups As…', onClick: async () => {
        setOpen(null);
        try {
          const { save } = await import('@tauri-apps/plugin-dialog');
          const { writeTextFile } = await import('@tauri-apps/plugin-fs');
          const path = await save({ title: 'Save', defaultPath: 'markups.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
          if (path) {
            const state = useStore.getState();
            const shapes = state.activeTabId ? state.documents[state.activeTabId].shapes : [];
            await writeTextFile(path, JSON.stringify({ version: '1.0', shapes }, null, 2)); 
            alert('✅ Saved to ' + path);
          }
        } catch (err) { alert('❌ Save failed: ' + err); }
      }},
      { type: 'item', label: '📥  Load Markups…', onClick: async () => {
        setOpen(null);
        try {
          const { open: pick } = await import('@tauri-apps/plugin-dialog');
          const { readTextFile } = await import('@tauri-apps/plugin-fs');
          const sel = await pick({ filters: [{ name: 'JSON', extensions: ['json'] }] });
          if (sel && typeof sel === 'string') { 
            const p = JSON.parse(await readTextFile(sel)); 
            if (p.shapes) useStore.getState().setShapes(p.shapes); 
          }
        } catch { /* ignore */ }
      }},
      { type: 'sep' },
      { type: 'item', label: '📤  Export (Rasterized PDF)…', onClick: async () => {
        setOpen(null);
        const state = useStore.getState();
        const targetTabId = state.activeTabId;
        if (!targetTabId) return;
        const doc = state.documents[targetTabId];
        const rawBytes = doc?.pdfBytes;
        if (!rawBytes) return alert('Please load a PDF first.');

        const isTauri = !!(window as any).__TAURI_INTERNALS__;
        if (!isTauri) {
          try {
            const isSpreadSave = await askSpreadSaveOption(targetTabId);
            state.setSavingStatus(targetTabId, { progress: 0, mode: 'export' });
            const flattened = await flattenPdfRasterized(
              rawBytes,
              doc.shapes,
              150,
              false,
              doc.scaleCalibration ?? 1.0,
              isSpreadSave,
              targetTabId,
              (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'export' })
            );
            state.setSavingStatus(targetTabId, null);
            const blob = new Blob([flattened as any], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (state.tabMetas[targetTabId]?.label || 'rasterized') + '_raster.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          } catch (err) {
            alert('❌ Rasterized export failed: ' + err);
            state.setSavingStatus(targetTabId, null);
          }
          return;
        }

        try {
          const { save } = await import('@tauri-apps/plugin-dialog');
          const { writeFile } = await import('@tauri-apps/plugin-fs');
          const path = await save({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          if (path) {
            const isSpreadSave = await askSpreadSaveOption(targetTabId);
            state.setSavingStatus(targetTabId, { progress: 0, mode: 'export' });
            const flattened = await flattenPdfRasterized(
              rawBytes,
              doc.shapes,
              150,
              false,
              doc.scaleCalibration ?? 1.0,
              isSpreadSave,
              targetTabId,
              (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'export' })
            );
            await writeFile(path, flattened);
            alert('✅ Rasterized export saved to ' + path);
          }
        } catch (err) { alert('❌ Rasterized export failed: ' + err); }
        finally {
          state.setSavingStatus(targetTabId, null);
        }
      }},
    ];

  const menus: Record<string, MenuItem[]> = {
    File: fileItems,
    Edit: [
      { type: 'item', label: '↺  Undo', onClick: () => { undo(); setOpen(null); } },
      { type: 'item', label: '↻  Redo', onClick: () => { redo(); setOpen(null); } },
      { type: 'item', label: '📋  Paste in Place', onClick: () => {
        setOpen(null);
        const state = useStore.getState();
        const clipboard = state.clipboard;
        if (clipboard && clipboard.length > 0) {
          state.pushToHistory();
          const newIds: string[] = [];
          const activeDoc = state.activeTabId ? state.documents[state.activeTabId] : null;
          const currentPageNum = activeDoc ? activeDoc.pageNum : 1;
          
          clipboard.forEach(s => {
            if (s.type === 'callout' && s.parentId && clipboard.some(p => p.id === s.parentId)) return;
            
            const newId = Math.random().toString(36).substring(7);
            newIds.push(newId);
            state.addShape({ ...s, id: newId, page: currentPageNum });
            
            if (s.type === 'cloud') {
              const callouts = clipboard.filter(child => child.type === 'callout' && child.parentId === s.id);
              callouts.forEach(child => {
                const childNewId = Math.random().toString(36).substring(7);
                newIds.push(childNewId);
                state.addShape({ ...child, id: childNewId, parentId: newId, page: currentPageNum });
              });
            }
          });
          state.setSelectedShapeIds(newIds);
        }
      }},
      { type: 'sep' },
      ...([
        { id: 'select', lb: '↖  Select' }, { id: 'pan', lb: '✋  Pan' },
        { id: 'line', lb: '╱  Line' }, { id: 'arrow', lb: '→  Arrow' },
        { id: 'rect', lb: '▭  Rectangle' }, { id: 'circle', lb: '◯  Circle' },
        { id: 'freehand', lb: '✏  Freehand' }, { id: 'cloud', lb: '☁  Rev Cloud' },
        { id: 'polyline', lb: '⟋  Polyline' }, { id: 'polygon', lb: '⬡  Polygon' },
        { id: 'text', lb: 'T  Text Box' },
        { id: 'measure_length', lb: '📏  Length' }, { id: 'measure_area', lb: '📐  Area' },
        { id: 'stamp', lb: '★  Stamp' },
        { id: 'highlight', lb: '🖍  Highlighter' },
      ] as const).map(({ id, lb }) => ({
        type: 'item' as const, label: lb,
        onClick: () => { setActiveTool(id); setOpen(null); },
      })),
    ],
    Insert: [
      {
        type: 'item' as const,
        label: '🖼  Images…',
        onClick: () => { setOpen(null); insertImageRef.current?.click(); },
      },
    ],
    View: [
      { type: 'item', label: '🔍  Zoom In', onClick: () => { setScale((s: number) => Math.min(5, s + 0.25)); setOpen(null); } },
      { type: 'item', label: '🔎  Zoom Out', onClick: () => { setScale((s: number) => Math.max(0.25, s - 0.25)); setOpen(null); } },
      { type: 'sep' },
      { type: 'item', label: `📐  Scale Mode: ${isScaleMode ? 'ON ✓' : 'OFF'}`, onClick: () => { setIsScaleMode(!isScaleMode); setOpen(null); } },
    ],
    Help: [
      { type: 'item', label: '⌨  Keyboard Shortcuts', onClick: () => {
        setOpen(null);
        alert('Ctrl+Z – Undo\nCtrl+Y – Redo\nDelete – Remove selected\nEscape / Enter – Finish current shape\nScroll wheel – Zoom in/out');
      }},
      { type: 'item', label: 'ℹ  About Layers', onClick: () => {
        setOpen(null);
        alert('Layers — PDF Markup Engine v1.0\nBuilt with React + Konva + pdf-lib + PDF.js');
      }},
    ],
  };

  const menuStyle = (name: string): React.CSSProperties => ({
    background: open === name ? '#26272c' : 'transparent',
    border: 'none', color: open === name ? '#e0e0e0' : '#999',
    padding: '3px 10px', cursor: 'pointer', fontSize: 12,
    borderRadius: 3, transition: 'all 0.12s',
  });

  const renderMenu = (name: string, items: MenuItem[]) => {
    const rect = refs[name]?.current?.getBoundingClientRect();
    return (
      <div
        ref={dropdownRef}
        onMouseDown={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: (rect?.bottom ?? 26) + 2, left: rect?.left ?? 0,
          zIndex: 999999, background: '#18191d',
          border: '1px solid #2a2a2e', borderRadius: 6,
          minWidth: 230, padding: '4px 0',
          boxShadow: '0 8px 24px rgba(0,0,0,0.8)',
        }}>
        {items.map((item, idx) =>
          item.type === 'sep' ? (
            <div key={idx} style={{ height: 1, background: '#222', margin: '3px 0' }} />
          ) : (item as Entry).input ? (
            <label key={idx}
              style={{ display: 'flex', alignItems: 'center', padding: '7px 14px', cursor: 'pointer', color: '#ccc', fontSize: 12 }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.1)'; (e.currentTarget as HTMLElement).style.color = '#fff'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#ccc'; }}>
              {(item as Entry).label}
              <input type="file" hidden accept="application/pdf" onChange={() => { setOpen(null); }} />
            </label>
          ) : (
            <button key={idx} onClick={(item as Entry).onClick}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 14px', background: 'transparent', border: 'none', color: '#ccc', fontSize: 12, cursor: 'pointer' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.1)'; (e.currentTarget as HTMLElement).style.color = '#fff'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#ccc'; }}
            >{(item as Entry).label}</button>
          )
        )}
      </div>
    );
  };

  return (
    <div ref={barRef} style={{ display: 'flex', alignItems: 'center', background: '#111213', borderBottom: '1px solid #0a0a0b', padding: '0 10px', height: 26, flexShrink: 0, userSelect: 'none', overflow: 'visible' }}>
      {editorMode === 'master' && (
        <span style={{
          color: '#f59e0b',
          fontSize: 11,
          fontWeight: 700,
          marginRight: 15,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          borderRight: '1px solid rgba(245,158,11,0.3)',
          paddingRight: 10,
          display: 'inline-flex',
          alignItems: 'center',
        }}>
          MASTER EDITOR — Editing: {activeMasterName}
        </span>
      )}
      {/* Hidden file input for image insertion via Insert menu */}
      <input
        ref={insertImageRef}
        type="file"
        accept="image/*"
        hidden
        onChange={e => {
          const file = e.target.files?.[0];
          if (!file) return;
          e.target.value = '';
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const img = new window.Image();
            img.onload = () => onInsertImage(dataUrl, img.naturalWidth, img.naturalHeight);
            img.src = dataUrl;
          };
          reader.readAsDataURL(file);
        }}
      />
      {/* Hidden file input for browser fallback to open PDF */}
      <input
        id="browser-open-pdf-input"
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (!file) return;
          e.target.value = '';
          const reader = new FileReader();
          reader.onload = async () => {
            if (reader.result) {
              const bytes = new Uint8Array(reader.result as ArrayBuffer);
              const targetTabId = `tab-${Date.now()}`;
              useStore.getState().openTab(targetTabId, { label: file.name, isDirty: false });
              useStore.getState().setPdfBytes(bytes);
            }
          };
          reader.readAsArrayBuffer(file);
        }}
      />
      {(['File', 'Edit', 'Insert', 'View', 'Help'] as const).map(name => (
        <div key={name} style={{ position: 'relative' }}>
          <button
            ref={refs[name] as React.RefObject<HTMLButtonElement>}
            style={menuStyle(name)}
            onClick={() => setOpen(open === name ? null : name)}
            onMouseEnter={e => { if (open && open !== name) setOpen(name); (e.currentTarget as HTMLElement).style.color = '#e0e0e0'; }}
            onMouseLeave={e => { if (open !== name) (e.currentTarget as HTMLElement).style.color = '#999'; }}
          >{name}</button>
          {open === name && createPortal(renderMenu(name, menus[name]), document.body)}
        </div>
      ))}
    </div>
  );
}

/* ─── Top Command Center ────────────────────────────────────────────────── */
export function TopCommandCenter({
  onSnip, onNewDocument, onInsertImage,
}: {
  onSnip: () => void;
  onNewDocument: () => void | Promise<void>;
  onInsertImage: (dataUrl: string, w: number, h: number) => void;
}) {
  const { 
    activeTool, setActiveTool, setScale, undo, redo, 
    activeTabId, documents, isScaleMode, setIsScaleMode, 
    setPendingTableDimensions, editorMode, strokeColor,
    bringToFront, sendToBack
  } = useStore();

  const [activeRibbonTab, setActiveRibbonTab] = useState<'draw' | 'marks' | 'building_elements'>('draw');
  
  const [showTableDialog, setShowTableDialog] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableCols, setTableCols] = useState(3);
  const [showVariableDropdown, setShowVariableDropdown] = useState(false);
  const varDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showVariableDropdown) return;
    const close = (e: MouseEvent) => {
      if (varDropdownRef.current && !varDropdownRef.current.contains(e.target as Node)) {
        setShowVariableDropdown(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showVariableDropdown]);

  const insertVariableTag = (tag: string) => {
    const state = useStore.getState();
    const aid = state.activeTabId;
    if (!aid || !state.documents[aid]) return;
    const docState = state.documents[aid];

    const activeMasterId = state.activeMasterPageId;
    const activeMaster = state.masterPages.find(m => m.id === activeMasterId);
    const pageWidth = activeMaster?.pageWidth || 612;
    const pageHeight = activeMaster?.pageHeight || 792;

    const newShape = {
      id: `shape-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type: 'text' as const,
      x: pageWidth / 2 - 75,
      y: pageHeight / 2 - 15,
      width: 150,
      height: 30,
      strokeColor: strokeColor || '#000000',
      strokeWidth: 1,
      fillColor: 'transparent',
      text: tag,
      fontSize: 16,
      fontFamily: 'Inter',
      textAlign: 'center' as const,
      page: docState.pageNum || 1,
      author: 'Master Editor',
      date: new Date().toLocaleDateString(),
      comments: `Variable tag: ${tag}`,
    };

    state.pushToHistory();
    state.addShape(newShape);
    state.setSelectedShapeIds([newShape.id]);
  };
  
  const doc = activeTabId ? documents[activeTabId] : null;
  const past = doc?.past || [];
  const future = doc?.future || [];
  const scale = doc?.scale || 1.0;
  const selectedShapeIds = doc?.selectedShapeIds || [];

  // Auto-switch ribbon tab when a mark tool is activated (e.g. from keyboard)
  const prevToolRef = useRef(activeTool);
  if (prevToolRef.current !== activeTool) {
    prevToolRef.current = activeTool;
    const inBuilding = BUILDING_ELEMENTS_TOOLS.some(t => t.id === activeTool);
    const inDraw = TOOLS.some(t => t.id === activeTool);
    const inMarks = isMarkType(activeTool) && !inBuilding;

    let target = activeRibbonTab;
    if (target === 'draw' && inDraw) {}
    else if (target === 'building_elements' && inBuilding) {}
    else if (target === 'marks' && inMarks) {}
    else if (inMarks) target = 'marks';
    else if (inBuilding && !inDraw) target = 'building_elements';
    else if (inDraw) target = 'draw';
    else if (inBuilding) target = 'building_elements';

    if (target !== activeRibbonTab) setActiveRibbonTab(target);
  }

  const isMaster = editorMode === 'master';
  const themeColor = isMaster ? '#f59e0b' : '#4da6ff';
  const themeBg = isMaster ? 'rgba(245,158,11,0.18)' : 'rgba(77,166,255,0.18)';
  const themeOutline = isMaster ? 'rgba(245,158,11,0.45)' : 'rgba(77,166,255,0.45)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: '#1e1f23', borderBottom: '1px solid #111', boxShadow: '0 2px 12px rgba(0,0,0,0.4)', zIndex: 100, overflow: 'visible', flexShrink: 0 }}>

      {/* ── OS-style menu bar ── */}
      <MenuBar
        onNewDocument={onNewDocument}
        undo={undo} redo={redo}
        isScaleMode={isScaleMode} setIsScaleMode={setIsScaleMode}
        setActiveTool={setActiveTool} setScale={setScale}
        onInsertImage={onInsertImage}
      />

      <div style={{ display: 'flex', alignItems: 'stretch', background: '#17181c', borderBottom: '1px solid #0e0f11', paddingLeft: 12, gap: 0, flexShrink: 0 }}>
        {(['draw', 'marks', 'building_elements'] as const).map(tab => {
          const labels: Record<string, string> = { draw: 'Draw', marks: 'Marks', building_elements: 'Building Elements' };
          const active = activeRibbonTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveRibbonTab(tab)}
              style={{
                background: active ? '#1e1f23' : 'transparent',
                border: 'none', borderBottom: active ? `2px solid ${themeColor}` : '2px solid transparent',
                color: active ? themeColor : '#777',
                padding: '5px 18px', fontSize: 11, fontWeight: active ? 700 : 500,
                cursor: 'pointer', letterSpacing: '0.4px', transition: 'all 0.12s',
              }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = isMaster ? '#f59e0b' : '#bbb'; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = '#777'; }}
            >
              {labels[tab]}
            </button>
          );
        })}

        {/* Right side utility buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 12, marginLeft: 'auto' }}>
          {!isMaster ? (
            <>
              {/* Scale */}
              <button
                onClick={() => setIsScaleMode(!isScaleMode)}
                style={{
                  ...btnTab,
                  background: isScaleMode ? 'rgba(77,166,255,0.18)' : 'transparent',
                  color: isScaleMode ? '#4da6ff' : '#ccc',
                  border: isScaleMode ? '1px solid rgba(77,166,255,0.35)' : '1px solid transparent',
                }}
                onMouseEnter={e => {
                  if (!isScaleMode) {
                    (e.currentTarget as HTMLElement).style.background = '#26272c';
                    (e.currentTarget as HTMLElement).style.color = '#fff';
                  }
                }}
                onMouseLeave={e => {
                  if (!isScaleMode) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                    (e.currentTarget as HTMLElement).style.color = '#ccc';
                  }
                }}
                title="Toggle calibration scale mode"
              >
                📐 {isScaleMode ? 'Scale ON' : 'Scale'}
              </button>

              {/* Snip */}
              <button
                onClick={onSnip}
                style={{
                  ...btnTab,
                  border: '1px solid transparent',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = '#26272c';
                  (e.currentTarget as HTMLElement).style.color = '#fff';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                  (e.currentTarget as HTMLElement).style.color = '#ccc';
                }}
                title="Take a snip"
              >
                ✂ Snip
              </button>

              {/* Toggle Clip */}
              <button
                onClick={() => {
                  const state = useStore.getState();
                  if (selectedShapeIds.length === 0) return;
                  const d = state.documents[state.activeTabId!];
                  if (!d) return;
                  const selShapes = d.shapes.filter(s => selectedShapeIds.includes(s.id));
                  const allClipped = selShapes.every(s => s.clippedToPage);
                  
                  state.pushToHistory();
                  state.setShapes(prev => prev.map(s => {
                    if (selectedShapeIds.includes(s.id)) {
                      return { ...s, clippedToPage: !allClipped };
                    }
                    return s;
                  }));
                }}
                disabled={selectedShapeIds.length === 0}
                style={{
                  ...btnTab,
                  color: selectedShapeIds.length > 0 ? '#ccc' : '#555',
                  cursor: selectedShapeIds.length > 0 ? 'pointer' : 'not-allowed',
                  border: selectedShapeIds.length > 0 ? '1px solid #2a2a2e' : '1px solid transparent',
                }}
                onMouseEnter={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = '#26272c';
                    (e.currentTarget as HTMLElement).style.color = '#fff';
                  }
                }}
                onMouseLeave={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                    (e.currentTarget as HTMLElement).style.color = '#ccc';
                  }
                }}
                title="Toggle clipping at spread spine for selected shapes"
              >
                ✂ Toggle Clip
              </button>

              {/* Bring to Front */}
              <button
                onClick={bringToFront}
                disabled={selectedShapeIds.length === 0}
                style={{
                  ...btnTab,
                  color: selectedShapeIds.length > 0 ? '#ccc' : '#555',
                  cursor: selectedShapeIds.length > 0 ? 'pointer' : 'not-allowed',
                  border: selectedShapeIds.length > 0 ? '1px solid #2a2a2e' : '1px solid transparent',
                }}
                onMouseEnter={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = '#26272c';
                    (e.currentTarget as HTMLElement).style.color = '#fff';
                  }
                }}
                onMouseLeave={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                    (e.currentTarget as HTMLElement).style.color = '#ccc';
                  }
                }}
                title="Bring selected shape(s) to front"
              >
                ⇈ Bring to Front
              </button>

              {/* Send to Back */}
              <button
                onClick={sendToBack}
                disabled={selectedShapeIds.length === 0}
                style={{
                  ...btnTab,
                  color: selectedShapeIds.length > 0 ? '#ccc' : '#555',
                  cursor: selectedShapeIds.length > 0 ? 'pointer' : 'not-allowed',
                  border: selectedShapeIds.length > 0 ? '1px solid #2a2a2e' : '1px solid transparent',
                }}
                onMouseEnter={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = '#26272c';
                    (e.currentTarget as HTMLElement).style.color = '#fff';
                  }
                }}
                onMouseLeave={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                    (e.currentTarget as HTMLElement).style.color = '#ccc';
                  }
                }}
                title="Send selected shape(s) to back"
              >
                ⇊ Send to Back
              </button>

              {/* Export group (Editable / Flattened) */}
              <div style={{ display: 'flex', gap: 1, border: '1px solid #2a2a2e', borderRadius: 4, overflow: 'hidden' }}>
                <button
                  style={{
                    ...btnTab,
                    background: 'rgba(59,130,246,0.18)',
                    color: '#60a5fa',
                    border: 'none',
                    borderRadius: 0,
                    padding: '3px 8px',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,0.28)';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,0.18)';
                  }}
                  onClick={async () => {
                    const state = useStore.getState();
                    const targetTabId = state.activeTabId;
                    if (!targetTabId) return;
                    const doc = state.documents[targetTabId];
                    const rawBytes = doc?.pdfBytes;
                    if (!rawBytes) return alert("Please load a PDF first.");

                    const isTauri = !!(window as any).__TAURI_INTERNALS__;
                    if (!isTauri) {
                      try {
                        const isSpreadSave = await askSpreadSaveOption(targetTabId);
                        state.setSavingStatus(targetTabId, { progress: 0, mode: 'export' });
                        const flattened = await flattenPdf(
                          rawBytes,
                          doc.shapes,
                          true,
                          isSpreadSave,
                          targetTabId,
                          (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'export' })
                        );
                        state.setSavingStatus(targetTabId, null);

                        const blob = new Blob([flattened as any], { type: 'application/pdf' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = (state.tabMetas[targetTabId]?.label || 'document') + '_editable.pdf';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                      } catch (err) {
                        alert("❌ Export error: " + err);
                        state.setSavingStatus(targetTabId, null);
                      }
                      return;
                    }

                    try {
                      const { save } = await import('@tauri-apps/plugin-dialog');
                      const { writeFile } = await import('@tauri-apps/plugin-fs');
                      const path = await save({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
                      if (path) {
                        const isSpreadSave = await askSpreadSaveOption(targetTabId);
                        state.setSavingStatus(targetTabId, { progress: 0, mode: 'export' });
                        const flattened = await flattenPdf(
                          rawBytes,
                          doc.shapes,
                          true,
                          isSpreadSave,
                          targetTabId,
                          (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'export' })
                        );
                        await writeFile(path, flattened);
                        alert("✅ Exported: " + path);
                      }
                    } catch (err) { alert("❌ Export error: " + err); console.error(err); }
                    finally {
                      state.setSavingStatus(targetTabId, null);
                    }
                  }}
                >
                  ↑ Editable
                </button>
                <button
                  style={{
                    ...btnTab,
                    background: 'rgba(59,130,246,0.1)',
                    color: '#60a5fa',
                    border: 'none',
                    borderRadius: 0,
                    padding: '3px 8px',
                    borderLeft: '1px solid #2a2a2e',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,0.18)';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,0.1)';
                  }}
                  onClick={async () => {
                    const state = useStore.getState();
                    const targetTabId = state.activeTabId;
                    if (!targetTabId) return;
                    const doc = state.documents[targetTabId];
                    const rawBytes = doc?.pdfBytes;
                    if (!rawBytes) return alert("Please load a PDF first.");

                    const isTauri = !!(window as any).__TAURI_INTERNALS__;
                    if (!isTauri) {
                      try {
                        const isSpreadSave = await askSpreadSaveOption(targetTabId);
                        state.setSavingStatus(targetTabId, { progress: 0, mode: 'export' });
                        const flattened = await flattenPdf(
                          rawBytes,
                          doc.shapes,
                          false,
                          isSpreadSave,
                          targetTabId,
                          (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'export' })
                        );
                        state.setSavingStatus(targetTabId, null);

                        const blob = new Blob([flattened as any], { type: 'application/pdf' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = (state.tabMetas[targetTabId]?.label || 'document') + '_flattened.pdf';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                      } catch (err) {
                        alert("❌ Export error: " + err);
                        state.setSavingStatus(targetTabId, null);
                      }
                      return;
                    }

                    try {
                      const { save } = await import('@tauri-apps/plugin-dialog');
                      const { writeFile } = await import('@tauri-apps/plugin-fs');
                      const path = await save({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
                      if (path) {
                        const isSpreadSave = await askSpreadSaveOption(targetTabId);
                        state.setSavingStatus(targetTabId, { progress: 0, mode: 'export' });
                        const flattened = await flattenPdf(
                          rawBytes,
                          doc.shapes,
                          false,
                          isSpreadSave,
                          targetTabId,
                          (progress) => state.setSavingStatus(targetTabId, { progress, mode: 'export' })
                        );
                        await writeFile(path, flattened);
                        alert("✅ Exported: " + path);
                      }
                    } catch (err) { alert("❌ Export error: " + err); console.error(err); }
                    finally {
                      state.setSavingStatus(targetTabId, null);
                    }
                  }}
                >
                  Flattened
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Bring to Front (Master mode) */}
              <button
                onClick={bringToFront}
                disabled={selectedShapeIds.length === 0}
                style={{
                  ...btnTab,
                  color: selectedShapeIds.length > 0 ? '#ccc' : '#555',
                  cursor: selectedShapeIds.length > 0 ? 'pointer' : 'not-allowed',
                  border: selectedShapeIds.length > 0 ? '1px solid #2a2a2e' : '1px solid transparent',
                }}
                onMouseEnter={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = '#26272c';
                    (e.currentTarget as HTMLElement).style.color = '#fff';
                  }
                }}
                onMouseLeave={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                    (e.currentTarget as HTMLElement).style.color = '#ccc';
                  }
                }}
                title="Bring selected shape(s) to front"
              >
                ⇈ Bring to Front
              </button>

              {/* Send to Back (Master mode) */}
              <button
                onClick={sendToBack}
                disabled={selectedShapeIds.length === 0}
                style={{
                  ...btnTab,
                  color: selectedShapeIds.length > 0 ? '#ccc' : '#555',
                  cursor: selectedShapeIds.length > 0 ? 'pointer' : 'not-allowed',
                  border: selectedShapeIds.length > 0 ? '1px solid #2a2a2e' : '1px solid transparent',
                }}
                onMouseEnter={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = '#26272c';
                    (e.currentTarget as HTMLElement).style.color = '#fff';
                  }
                }}
                onMouseLeave={e => {
                  if (selectedShapeIds.length > 0) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                    (e.currentTarget as HTMLElement).style.color = '#ccc';
                  }
                }}
                title="Send selected shape(s) to back"
              >
                ⇊ Send to Back
              </button>

              {/* Done Editing */}
              <button
                onClick={() => useStore.getState().setEditorMode('document')}
                style={{
                  ...btnTab,
                  background: 'rgba(245,158,11,0.18)',
                  color: '#f59e0b',
                  border: '1px solid rgba(245,158,11,0.35)',
                  padding: '3px 10px',
                  fontWeight: 700,
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(245,158,11,0.28)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(245,158,11,0.18)';
                }}
              >
                ← Done Editing
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Tool pills row (Unified) ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', overflow: 'visible' }}>

        {/* Undo / Redo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, paddingRight: 8, borderRight: '1px solid #2a2a2e', flexShrink: 0 }}>
          <button onClick={undo} disabled={past.length === 0} style={{ ...btnBase, color: past.length === 0 ? '#444' : '#ccc', cursor: past.length === 0 ? 'not-allowed' : 'pointer' }}>↺</button>
          <button onClick={redo} disabled={future.length === 0} style={{ ...btnBase, color: future.length === 0 ? '#444' : '#ccc', cursor: future.length === 0 ? 'not-allowed' : 'pointer' }}>↻</button>
        </div>

        {/* Zoom */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 8, borderRight: '1px solid #2a2a2e', flexShrink: 0 }}>
          <button onClick={() => setScale(s => Math.max(0.25, s - 0.25))} style={btnBase}>−</button>
          <span style={{ fontSize: 12, color: '#ccc', minWidth: 38, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale(s => Math.min(5, s + 0.25))} style={btnBase}>+</button>
        </div>

        {/* Dynamic Center Tools */}
        {activeRibbonTab === 'draw' && (
          <>
            {/* Tool buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
              {TOOLS.map(tool => {
                const active = activeTool === tool.id;
                return (
                  <button key={tool.id} title={tool.label} onClick={() => {
                    if (tool.id === 'table') {
                      setShowTableDialog(!showTableDialog);
                    } else {
                      setActiveTool(tool.id as any);
                      setShowTableDialog(false);
                    }
                  }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                      padding: '5px 7px', borderRadius: 6, cursor: 'pointer', border: 'none',
                      background: active ? themeBg : 'transparent',
                      color: active ? themeColor : '#d0d0d0',
                      outline: active ? `1px solid ${themeOutline}` : '1px solid transparent',
                      transition: 'all 0.14s', fontSize: 9, fontWeight: active ? 700 : 500, minWidth: 38,
                    }}
                    onMouseEnter={e => { if (!active) { const el = e.currentTarget as HTMLElement; el.style.background = '#26272c'; el.style.color = isMaster ? '#f59e0b' : '#fff'; } }}
                    onMouseLeave={e => { if (!active) { const el = e.currentTarget as HTMLElement; el.style.background = 'transparent'; el.style.color = '#d0d0d0'; } }}
                  >
                    <Icon d={tool.icon} size={13} />
                    {tool.label}
                  </button>
                );
              })}
            </div>

            {/* Insert Variable Dropdown inside Master Editor */}
            {isMaster && (
              <div ref={varDropdownRef} style={{ position: 'relative', display: 'inline-block', paddingLeft: 8, borderLeft: '1px solid #2a2a2e', flexShrink: 0 }}>
                <button
                  onClick={() => setShowVariableDropdown(!showVariableDropdown)}
                  style={{
                    ...btnBase,
                    background: 'rgba(245,158,11,0.15)',
                    color: '#f59e0b',
                    border: '1px solid rgba(245,158,11,0.3)',
                    padding: '5px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span>{'{x}'} Insert Variable</span>
                  <span style={{ fontSize: 9 }}>▼</span>
                </button>
                {showVariableDropdown && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 30,
                      left: 8,
                      zIndex: 9999,
                      background: '#1c1d21',
                      border: '1px solid rgba(245,158,11,0.3)',
                      borderRadius: 6,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                      minWidth: 150,
                      padding: '4px 0',
                    }}
                  >
                    {[
                      { label: 'Page Number', tag: '{{Page Number}}' },
                      { label: 'Total Pages', tag: '{{Total Pages}}' },
                      { label: 'Date', tag: '{{Date}}' },
                      { label: 'Document Title', tag: '{{Document Title}}' },
                    ].map((item) => (
                      <button
                        key={item.tag}
                        onClick={() => {
                          insertVariableTag(item.tag);
                          setShowVariableDropdown(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 12px',
                          background: 'transparent',
                          border: 'none',
                          color: '#ddd',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.background = 'rgba(245,158,11,0.1)';
                          (e.currentTarget as HTMLElement).style.color = '#f59e0b';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.background = 'transparent';
                          (e.currentTarget as HTMLElement).style.color = '#ddd';
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Table Creation Dialog */}
            {showTableDialog && (
              <div style={{ position: 'absolute', top: 56, left: 300, background: '#26272c', padding: '12px 16px', borderRadius: 8, border: '1px solid #3a3a3e', zIndex: 100, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#fff', fontSize: 13, fontWeight: 'bold' }}>Create Table</span>
                  <button onClick={() => setShowTableDialog(false)} style={{ background: 'transparent', border: 'none', color: '#999', cursor: 'pointer', fontSize: 14 }}>✕</button>
                </div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <label style={{ color: '#ccc', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>Rows 
                    <input type="number" min={1} value={tableRows} onChange={e => setTableRows(Math.max(1, +e.target.value))} style={{ width: 50, background: '#111', color: '#fff', border: '1px solid #333', padding: '4px 6px', borderRadius: 4 }} />
                  </label>
                  <label style={{ color: '#ccc', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>Cols 
                    <input type="number" min={1} value={tableCols} onChange={e => setTableCols(Math.max(1, +e.target.value))} style={{ width: 50, background: '#111', color: '#fff', border: '1px solid #333', padding: '4px 6px', borderRadius: 4 }} />
                  </label>
                </div>
                <button onClick={() => {
                  setPendingTableDimensions({ rows: tableRows, cols: tableCols });
                  setActiveTool('table');
                  setShowTableDialog(false);
                }} style={{ background: '#4da6ff', color: '#000', border: 'none', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', alignSelf: 'flex-end', marginTop: 4 }}>Create</button>
              </div>
            )}
          </>
        )}

        {activeRibbonTab === 'marks' && (
          <MarksToolbar activeTool={activeTool} setActiveTool={setActiveTool} />
        )}

        {activeRibbonTab === 'building_elements' && (
          <BuildingElementsToolbar activeTool={activeTool} setActiveTool={setActiveTool} />
        )}


      </div>

      {/* ── Contextual properties bar ── */}
      <PropertiesBar />
    </div>
  );
}

/* ─── Measurement Scale Constants ──────────────────────────────────────────── */
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

/* ─── Properties Bar ────────────────────────────────────────────────────── */
function PropertiesBar() {
  const {
    activeTool, updateShape,
    strokeColor, setStrokeColor, strokeWidth, setStrokeWidth,
    fillColor, setFillColor, activeDash, setActiveDash,
    polygonSides, setPolygonSides, pushToHistory,
    cloudMode, setCloudMode,
    arrowHeadType, setArrowHeadType,
    arrowHeadSize, setArrowHeadSize,
    arrowHeadAngle, setArrowHeadAngle,
    arrowHeadFilled, setArrowHeadFilled,
    addLabelMode, setAddLabelMode,
    activeTabId, documents,
    brushThickness, setBrushThickness
  } = useStore();
  
  const doc = activeTabId ? documents[activeTabId] : null;
  const shapes = doc?.shapes || [];
  const selectedShapeIds = doc?.selectedShapeIds || [];

  const [showPatternMenu, setShowPatternMenu] = useState(false);
  const patternBtnRef = useRef<HTMLButtonElement>(null);
  const [patternMenuPos, setPatternMenuPos] = useState({ top: 0, left: 0 });

  const openPatternMenu = () => {
    if (patternBtnRef.current) {
      const r = patternBtnRef.current.getBoundingClientRect();
      setPatternMenuPos({ top: r.bottom + 4, left: r.left });
    }
    setShowPatternMenu(v => !v);
  };

  useEffect(() => {
    if (!showPatternMenu) return;
    const close = (e: MouseEvent) => {
      if (patternBtnRef.current && !patternBtnRef.current.contains(e.target as Node)) setShowPatternMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showPatternMenu]);

  const selectedShape = selectedShapeIds.length === 1 ? shapes.find(s => s.id === selectedShapeIds[0]) : null;

  const toRgba = (color: string, opacity: number) => {
    if (color === 'transparent') return color;
    let r = 0, g = 0, b = 0;
    if (color.startsWith('#')) {
      const h = color.slice(1);
      if (h.length === 3) { r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16); }
      else { r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16); }
    } else if (color.startsWith('rgb')) {
      const m = color.match(/\d+(\.\d+)?/g);
      if (m) { r = +m[0]; g = +m[1]; b = +m[2]; }
    }
    return `rgba(${r},${g},${b},${Math.round(opacity*100)/100})`;
  };
  const getOpacity = (c: string) => { const m = c.match(/rgba\(.*?,\s*([\d.]+)\)/); return m ? parseFloat(m[1]) : 1; };
  const getHex = (c: string) => {
    if (c === 'transparent') return '#ffffff';
    if (c.startsWith('#')) return c.slice(0,7);
    const m = c.match(/\d+(\.\d+)?/g);
    return m ? '#' + [+m[0],+m[1],+m[2]].map(v => v.toString(16).padStart(2,'0')).join('') : '#ff0000';
  };

  const updateTableCellsStyle = (shapeId: string, updates: Partial<TableCell>) => {
    const s = shapes.find(x => x.id === shapeId);
    if (!s || s.type !== 'table' || !s.tableData) return;
    const cellIds = s.tableData.selectedCellIds || [];
    if (cellIds.length === 0) {
      updateShape(shapeId, updates as Partial<ShapeData>);
      return;
    }
    const newCells = { ...s.tableData.cells };
    cellIds.forEach(cid => {
      newCells[cid] = {
        ...(newCells[cid] || { text: '' }),
        ...updates
      };
    });
    updateShape(shapeId, {
      tableData: {
        ...s.tableData,
        cells: newCells
      }
    });
  };

  const updateTableLineThickness = (shapeId: string, v: number) => {
    const s = shapes.find(x => x.id === shapeId);
    if (!s || s.type !== 'table' || !s.tableData) return;
    const table = s.tableData;
    const cols = table.cols;
    const rows = table.rows;
    const colTh = table.colLineThicknesses ? [...table.colLineThicknesses] : Array(cols + 1).fill(table.borderThickness ?? s.strokeWidth ?? 1);
    const rowTh = table.rowLineThicknesses ? [...table.rowLineThicknesses] : Array(rows + 1).fill(table.borderThickness ?? s.strokeWidth ?? 1);
    
    if (table.selectedLine) {
      if (table.selectedLine.type === 'col') {
        colTh[table.selectedLine.index] = v;
      } else {
        rowTh[table.selectedLine.index] = v;
      }
    } else {
      colTh[0] = v;
      colTh[cols] = v;
      rowTh[0] = v;
      rowTh[rows] = v;
    }
    
    updateShape(shapeId, {
      strokeWidth: v,
      tableData: {
        ...table,
        borderThickness: v,
        colLineThicknesses: colTh,
        rowLineThicknesses: rowTh
      }
    });
  };

  const handleMergeCells = (shapeId: string) => {
    const s = shapes.find(x => x.id === shapeId);
    if (!s || s.type !== 'table' || !s.tableData) return;
    const table = s.tableData;
    const selectedIds = table.selectedCellIds || [];
    if (selectedIds.length <= 1) return;

    pushToHistory();

    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    selectedIds.forEach(cid => {
      const [rStr, cStr] = cid.split('_');
      const r = parseInt(rStr, 10);
      const c = parseInt(cStr, 10);
      const cell = table.cells[cid];
      const rSpan = cell?.rowSpan || 1;
      const cSpan = cell?.colSpan || 1;
      minRow = Math.min(minRow, r);
      maxRow = Math.max(maxRow, r + rSpan - 1);
      minCol = Math.min(minCol, c);
      maxCol = Math.max(maxCol, c + cSpan - 1);
    });

    const newRowSpan = maxRow - minRow + 1;
    const newColSpan = maxCol - minCol + 1;

    const sortedIds = [...selectedIds].sort((a, b) => {
      const [ar, ac] = a.split('_').map(Number);
      const [br, bc] = b.split('_').map(Number);
      if (ar !== br) return ar - br;
      return ac - bc;
    });

    const concatenatedText = sortedIds
      .map(cid => table.cells[cid]?.text || '')
      .filter(text => text.trim() !== '')
      .join(' ');

    const newCells = { ...table.cells };
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const targetId = `${r}_${c}`;
        if (r === minRow && c === minCol) {
          newCells[targetId] = {
            ...(newCells[targetId] || { text: '' }),
            colSpan: newColSpan,
            rowSpan: newRowSpan,
            isMerged: false,
            text: concatenatedText
          };
        } else {
          newCells[targetId] = {
            ...(newCells[targetId] || { text: '' }),
            isMerged: true,
            colSpan: 1,
            rowSpan: 1,
            text: ''
          };
        }
      }
    }

    const masterId = `${minRow}_${minCol}`;
    updateShape(shapeId, {
      tableData: {
        ...table,
        cells: newCells,
        selectedCellIds: [masterId]
      }
    });
  };

  const handleUnmergeCells = (shapeId: string) => {
    const s = shapes.find(x => x.id === shapeId);
    if (!s || s.type !== 'table' || !s.tableData) return;
    const table = s.tableData;
    const selectedIds = table.selectedCellIds || [];
    if (selectedIds.length === 0) return;

    pushToHistory();

    const newCells = { ...table.cells };
    const newSelectedIds: string[] = [];

    selectedIds.forEach(cid => {
      const cell = table.cells[cid];
      if (!cell) return;
      const rSpan = cell.rowSpan || 1;
      const cSpan = cell.colSpan || 1;
      if (rSpan > 1 || cSpan > 1) {
        const [startRStr, startCStr] = cid.split('_');
        const startR = parseInt(startRStr, 10);
        const startC = parseInt(startCStr, 10);

        for (let r = startR; r < startR + rSpan; r++) {
          for (let c = startC; c < startC + cSpan; c++) {
            const targetId = `${r}_${c}`;
            newCells[targetId] = {
              ...(newCells[targetId] || { text: '' }),
              colSpan: 1,
              rowSpan: 1,
              isMerged: false,
              text: (r === startR && c === startC) ? cell.text : ''
            };
            newSelectedIds.push(targetId);
          }
        }
      } else {
        newSelectedIds.push(cid);
      }
    });

    updateShape(shapeId, {
      tableData: {
        ...table,
        cells: newCells,
        selectedCellIds: newSelectedIds
      }
    });
  };

  const hStroke = (v: string) => { if (selectedShapeIds.length > 0) pushToHistory(); setStrokeColor(v); selectedShapeIds.forEach(id => updateShape(id, { strokeColor: v })); };
  const hWidth = (v: number) => { 
    if (selectedShapeIds.length > 0) pushToHistory(); 
    if (activeTool === 'brush') setBrushThickness(v);
    else setStrokeWidth(v); 
    selectedShapeIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (s?.type === 'table') {
        updateTableLineThickness(id, v);
      } else {
        updateShape(id, { strokeWidth: v });
      }
    }); 
  };
  const hDash = (v?: number[]) => { if (selectedShapeIds.length > 0) pushToHistory(); setActiveDash(v); selectedShapeIds.forEach(id => updateShape(id, { dash: v })); };
  const hFill = (v: string) => { 
    if (selectedShapeIds.length > 0) pushToHistory(); 
    setFillColor(v); 
    selectedShapeIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (s?.type === 'table' && s.tableData?.selectedCellIds && s.tableData.selectedCellIds.length > 0) {
        updateTableCellsStyle(id, { fillColor: v });
      } else {
        updateShape(id, { fillColor: v });
      }
    }); 
  };
  const hFont = (v: string) => { 
    if (selectedShapeIds.length > 0) pushToHistory(); 
    selectedShapeIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (s?.type === 'table' && s.tableData?.selectedCellIds && s.tableData.selectedCellIds.length > 0) {
        updateTableCellsStyle(id, { fontFamily: v });
      } else {
        updateShape(id, { fontFamily: v });
      }
    }); 
  };
  const hSize = (v: number) => { 
    if (selectedShapeIds.length > 0) pushToHistory(); 
    selectedShapeIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (s?.type === 'table' && s.tableData?.selectedCellIds && s.tableData.selectedCellIds.length > 0) {
        updateTableCellsStyle(id, { fontSize: v });
      } else {
        updateShape(id, { fontSize: v });
      }
    }); 
  };
  const hTextColor = (v: string) => { 
    if (selectedShapeIds.length > 0) pushToHistory(); 
    setStrokeColor(v); 
    selectedShapeIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (s?.type === 'table' && s.tableData?.selectedCellIds && s.tableData.selectedCellIds.length > 0) {
        updateTableCellsStyle(id, { strokeColor: v });
      } else {
        updateShape(id, { strokeColor: v });
      }
    }); 
  };
  const hToggle = (prop: 'isBold'|'isItalic'|'isUnderline'|'isStrike') => {
    if (selectedShapeIds.length > 0) pushToHistory();
    selectedShapeIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (s) {
        if (s.type === 'table' && s.tableData?.selectedCellIds && s.tableData.selectedCellIds.length > 0) {
          const newCells = { ...s.tableData.cells };
          s.tableData.selectedCellIds.forEach(cid => {
            const cell = newCells[cid];
            const curVal = cell?.[prop] !== undefined ? cell[prop] : (s[prop] || false);
            newCells[cid] = {
              ...(cell || { text: '' }),
              [prop]: !curVal
            };
          });
          updateShape(id, { tableData: { ...s.tableData, cells: newCells } });
        } else {
          updateShape(id, { [prop]: !s[prop] });
        }
      }
    });
  };
  const hPattern = (patternId: string | 'NO_FILL' | null) => {
    if (patternId === 'NO_FILL') {
      selectedShapeIds.forEach(id => updateShape(id, { fillColor: 'transparent', fillPatternId: undefined }));
      setFillColor('transparent');
    } else if (patternId === null) {
      // Solid Fill: promote transparent to strokeColor if needed
      const newFill = fillColor === 'transparent' ? strokeColor : fillColor;
      selectedShapeIds.forEach(id => updateShape(id, { fillColor: newFill, fillPatternId: undefined }));
      setFillColor(newFill);
    } else {
      // Pattern Fill
      const idealScale = 1.0; // Default hatch scale should be 1
      const hatchThickness = 1; // Default hatch thickness should be 1
      const curFill = selectedShape?.fillColor || fillColor;
      const newFill = (curFill === 'transparent') ? strokeColor : curFill;
      selectedShapeIds.forEach(id => updateShape(id, { 
        fillPatternId: patternId || undefined, 
        fillPatternScale: idealScale, 
        fillPatternStrokeWidth: hatchThickness, 
        fillColor: newFill 
      }));
      setFillColor(newFill);
    }
    setShowPatternMenu(false);
  };

  const isText = selectedShape?.type === 'text' || selectedShape?.type === 'callout';
  const isLineWithText = !!selectedShape && ['arrow','spline'].includes(selectedShape.type) && selectedShape.text !== undefined;
  const drawTools = ['line','rect','circle','freehand','arrow','cloud','measure_area','measure_length','polyline','polygon','spline','arc','highlight','brush'];
  const showDraw = (drawTools.includes(activeTool) || (selectedShapeIds.length > 0 && selectedShape && !isMarkType(selectedShape.type))) && !isText;
  const showText = activeTool === 'text' || isText || isLineWithText || activeTool === 'table' || selectedShape?.type === 'table';
  const hasFill = ['rect','circle','cloud','measure_area','polygon','table','polyline'].includes(activeTool) ||
    (!!selectedShape && ['rect','circle','cloud','measure_area','polygon','table','polyline'].includes(selectedShape.type));
  const isPolygon = activeTool === 'polygon' || selectedShape?.type === 'polygon';

  // Marks
  const MARK_TYPE_SET = new Set(['mark_section','mark_level','mark_grid','mark_elevation','mark_single_elevation','mark_hat_channel','mark_masonry_ties','mark_t_section','mark_cfmf_stud','mark_break_line','mark_callout','mark_block','mark_w_section','mark_insulation','mark_sealant','mark_angle','mark_bolt','mark_thermal_spacer', 'mark_metal_deck']);
  const showMarks = MARK_TYPE_SET.has(activeTool) || (!!selectedShape && MARK_TYPE_SET.has(selectedShape.type));
  const markShape = showMarks ? (selectedShape && MARK_TYPE_SET.has(selectedShape.type) ? selectedShape : null) : null;
  const activeMark = markShape?.type || (MARK_TYPE_SET.has(activeTool) ? activeTool : null);

  // Helper: update markerData field on selected marks
  const hMarkerData = (key: string, val: string) => {
    if (selectedShapeIds.length > 0) pushToHistory();
    selectedShapeIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (s && MARK_TYPE_SET.has(s.type)) {
        updateShape(id, { markerData: { ...(s.markerData || {}), [key]: val } });
      }
    });
  };
  // Helper: update fontSize on selected marks (also recomputes minWidth/minHeight)
  const hMarkFontSize = (val: number) => {
    if (selectedShapeIds.length > 0) pushToHistory();
    const safeVal = Math.max(6, val);
    selectedShapeIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (s && MARK_TYPE_SET.has(s.type)) {
        // Compute new min dimensions
        const maxLabel = Object.values(s.markerData || {}).reduce((a, b) => (b.length > a.length ? b : a), '');
        const minDim = Math.max(safeVal * Math.max(maxLabel.length * 0.65, 2), 40);
        updateShape(id, { fontSize: safeVal, minWidth: minDim, minHeight: minDim });
      }
    });
  };
  const hMarkStroke = (v: string) => {
    if (selectedShapeIds.length > 0) pushToHistory();
    setStrokeColor(v);
    selectedShapeIds.forEach(id => updateShape(id, { strokeColor: v }));
  };
  const hMarkWidth = (v: number) => {
    if (selectedShapeIds.length > 0) pushToHistory();
    setStrokeWidth(v);
    selectedShapeIds.forEach(id => updateShape(id, { strokeWidth: v }));
  };

  const Lbl = ({ children }: { children: React.ReactNode }) => (
    <span style={{ fontSize: 9, color: '#888', display: 'block', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.7px', fontWeight: 600 }}>{children}</span>
  );
  // Get active style values for shape/cell properties
  let activeFontFamily = selectedShape?.fontFamily || 'Inter';
  let activeFontSize = selectedShape?.fontSize || 16;
  let activeTextColor = selectedShape?.strokeColor || strokeColor;
  let activeIsBold = selectedShape?.isBold || false;
  let activeIsItalic = selectedShape?.isItalic || false;
  let activeIsUnderline = selectedShape?.isUnderline || false;
  let activeIsStrike = selectedShape?.isStrike || false;
  let activeFillColor = selectedShape?.fillColor || fillColor;

  if (selectedShape?.type === 'table' && selectedShape.tableData?.selectedCellIds && selectedShape.tableData.selectedCellIds.length > 0) {
    const firstCellId = selectedShape.tableData.selectedCellIds[0];
    const cell = selectedShape.tableData.cells[firstCellId];
    if (cell) {
      activeFontFamily = cell.fontFamily || selectedShape.fontFamily || 'Inter';
      activeFontSize = cell.fontSize || selectedShape.fontSize || 16;
      activeTextColor = cell.strokeColor || selectedShape.strokeColor || strokeColor;
      activeIsBold = cell.isBold !== undefined ? cell.isBold : (selectedShape.isBold || false);
      activeIsItalic = cell.isItalic !== undefined ? cell.isItalic : (selectedShape.isItalic || false);
      activeIsUnderline = cell.isUnderline !== undefined ? cell.isUnderline : (selectedShape.isUnderline || false);
      activeIsStrike = cell.isStrike !== undefined ? cell.isStrike : (selectedShape.isStrike || false);
      activeFillColor = cell.fillColor || selectedShape.fillColor || 'transparent';
    }
  }

  let activeWeight = selectedShape?.strokeWidth ?? (activeTool === 'brush' ? brushThickness : strokeWidth);
  if (selectedShape?.type === 'table' && selectedShape.tableData) {
    const table = selectedShape.tableData;
    if (table.selectedLine) {
      if (table.selectedLine.type === 'col') {
        activeWeight = table.colLineThicknesses?.[table.selectedLine.index] ?? table.borderThickness ?? selectedShape.strokeWidth;
      } else {
        activeWeight = table.rowLineThicknesses?.[table.selectedLine.index] ?? table.borderThickness ?? selectedShape.strokeWidth;
      }
    } else {
      activeWeight = table.borderThickness ?? selectedShape.strokeWidth;
    }
  }

  const Sep = () => <div style={{ width: 1, height: 28, background: '#2a2a2e', flexShrink: 0 }} />;

  if (!activeTabId) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 14px', background: '#16171a', borderTop: '1px solid #111', minHeight: 44, overflowX: 'auto', overflowY: 'visible', flexShrink: 0 }}>
      {showDraw && (
        <>
          {/* Stroke */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div>
              <Lbl>Stroke</Lbl>
              <input type="color" value={(selectedShape?.strokeColor || strokeColor).slice(0,7)} onChange={e => hStroke(e.target.value)}
                style={{ width: 30, height: 22, padding: 0, border: '1px solid #333', borderRadius: 4, cursor: 'pointer' }} />
            </div>
            <div>
              <Lbl>Weight</Lbl>
              <input type="number" min="1" max="150" value={activeWeight} onChange={e => hWidth(+e.target.value)}
                style={{ width: 42, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
            </div>
            {activeTool === 'brush' && (
              <div>
                <Lbl>Opacity</Lbl>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 1 }}>
                  <input type="range" min="5" max="100" value={Math.round(getOpacity(selectedShape?.strokeColor || strokeColor)*100)} onChange={e => hStroke(toRgba(getHex(selectedShape?.strokeColor || strokeColor), +e.target.value/100))} style={{ width: 48, accentColor: '#4da6ff' }} />
                  <span style={{ fontSize: 9, color: '#888', width: 22, textAlign: 'right' }}>{Math.round(getOpacity(selectedShape?.strokeColor || strokeColor)*100)}%</span>
                </div>
              </div>
            )}
          </div>
          <Sep />

          {/* Line style */}
          <div>
            <Lbl>Style</Lbl>
            <div style={{ display: 'flex', gap: 3 }}>
              {[
                { v: undefined, title: 'Solid', el: <div style={{ width: 20, height: 2, background: '#ccc' }} />, active: (selectedShape?.dash ?? activeDash) === undefined },
                { v: [10,10], title: 'Dashed', el: <div style={{ width: 20, height: 2, borderBottom: '2px dashed #ccc' }} />, active: (selectedShape?.dash ?? activeDash)?.length === 2 && (selectedShape?.dash ?? activeDash)![0] === 10 },
                { v: [15,5,5,5], title: 'Center', el: <div style={{ width: 20, height: 2, borderBottom: '2px dotted #ccc' }} />, active: (selectedShape?.dash ?? activeDash)?.length === 4 },
              ].map(({ v, title, el, active }) => (
                <button key={title} onClick={() => hDash(v)} title={title}
                  style={{ width: 28, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: active ? 'rgba(77,166,255,0.2)' : '#1e1f23', border: `1px solid ${active ? 'rgba(77,166,255,0.5)' : '#2a2a2e'}`, borderRadius: 4, cursor: 'pointer' }}>
                  {el}
                </button>
              ))}
            </div>
          </div>

          {/* Arrow / Spline Options */}
          {(['spline', 'arrow'].includes(activeTool) || (selectedShapeIds.length === 1 && ['spline', 'arrow'].includes(selectedShape?.type || ''))) && (
            <>
              <Sep />
              <div>
                <Lbl>Arrow Head</Lbl>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <select
                    value={selectedShape?.arrowHeadType ?? arrowHeadType}
                    onChange={e => {
                      const val = e.target.value as any;
                      setArrowHeadType(val);
                      if (selectedShapeIds.length > 0) {
                        pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { arrowHeadType: val }));
                      }
                    }}
                    style={{ background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', padding: '2px 4px', borderRadius: 4, fontSize: 11 }}
                  >
                    <option value="none">None</option>
                    <option value="arrow">Arrow</option>
                    <option value="circle">Circle</option>
                    <option value="greater_than">&gt; (Greater Than)</option>
                  </select>

                  {(selectedShape?.arrowHeadType ?? arrowHeadType) !== 'none' && (
                    <>
                      <input
                        type="number" min="5" max="100"
                        value={selectedShape?.arrowHeadSize ?? arrowHeadSize}
                        onChange={e => {
                          const val = +e.target.value;
                          setArrowHeadSize(val);
                          if (selectedShapeIds.length > 0) {
                            pushToHistory();
                            selectedShapeIds.forEach(id => updateShape(id, { arrowHeadSize: val }));
                          }
                        }}
                        style={{ width: 40, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }}
                        title="Size"
                      />
                      
                      {['arrow', 'greater_than'].includes(selectedShape?.arrowHeadType ?? arrowHeadType) && (
                        <select
                          value={selectedShape?.arrowHeadAngle ?? arrowHeadAngle}
                          onChange={e => {
                            const val = +e.target.value;
                            setArrowHeadAngle(val);
                            if (selectedShapeIds.length > 0) {
                              pushToHistory();
                              selectedShapeIds.forEach(id => updateShape(id, { arrowHeadAngle: val }));
                            }
                          }}
                          style={{ background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', padding: '2px 2px', borderRadius: 4, fontSize: 11 }}
                          title="Angle"
                        >
                          <option value="15">15°</option>
                          <option value="30">30°</option>
                          <option value="45">45°</option>
                          <option value="60">60°</option>
                        </select>
                      )}

                      {(selectedShape?.arrowHeadType ?? arrowHeadType) === 'arrow' && (
                        <button
                          onClick={() => {
                            const currentVal = selectedShape?.arrowHeadFilled ?? arrowHeadFilled;
                            const next = !currentVal;
                            setArrowHeadFilled(next);
                            if (selectedShapeIds.length > 0) {
                              pushToHistory();
                              selectedShapeIds.forEach(id => updateShape(id, { arrowHeadFilled: next }));
                            }
                          }}
                          style={{
                            padding: '2px 6px', fontSize: 10, fontWeight: 600,
                            color: (selectedShape?.arrowHeadFilled ?? arrowHeadFilled) ? '#4da6ff' : '#aaa',
                            background: (selectedShape?.arrowHeadFilled ?? arrowHeadFilled) ? 'rgba(77,166,255,0.18)' : '#1e1f23',
                            border: `1px solid ${(selectedShape?.arrowHeadFilled ?? arrowHeadFilled) ? 'rgba(77,166,255,0.45)' : '#2a2a2e'}`,
                            borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s'
                          }}
                          title="Toggle Fill"
                        >
                          {(selectedShape?.arrowHeadFilled ?? arrowHeadFilled) ? 'Solid' : 'Hollow'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              <Sep />
              <div>
                <Lbl>Label</Lbl>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    onClick={() => {
                      if (selectedShapeIds.length > 0) {
                        const nextText = selectedShape?.text !== undefined ? undefined : 'Double click to edit...';
                        pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { text: nextText }));
                      } else {
                        setAddLabelMode(!addLabelMode);
                      }
                    }}
                    style={{
                      padding: '2px 6px', fontSize: 10, fontWeight: 600,
                      color: (selectedShapeIds.length > 0 ? selectedShape?.text !== undefined : addLabelMode) ? '#4da6ff' : '#aaa',
                      background: (selectedShapeIds.length > 0 ? selectedShape?.text !== undefined : addLabelMode) ? 'rgba(77,166,255,0.18)' : '#1e1f23',
                      border: `1px solid ${(selectedShapeIds.length > 0 ? selectedShape?.text !== undefined : addLabelMode) ? 'rgba(77,166,255,0.45)' : '#2a2a2e'}`,
                      borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s'
                    }}
                    title="Toggle Text Label"
                  >
                    {(selectedShapeIds.length > 0 ? selectedShape?.text !== undefined : addLabelMode) ? (selectedShapeIds.length > 0 ? 'Remove Label' : 'Label Enabled') : '+ Add Label'}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Cloud Mode */}
          {activeTool === 'cloud' && (
            <>
              <Sep />
              <div>
                <Lbl>Cloud Mode</Lbl>
                <div style={{ display: 'flex', gap: 3 }}>
                  {[
                    { v: 'polygon', title: 'Polygon' },
                    { v: 'rect', title: 'Rectangle' },
                    { v: 'circle', title: 'Circle' },
                  ].map(({ v, title }) => (
                    <button key={v} onClick={() => setCloudMode(v as any)} title={title}
                      style={{ 
                        padding: '2px 8px', fontSize: 11, fontWeight: 600, color: cloudMode === v ? '#fff' : '#ccc',
                        background: cloudMode === v ? 'rgba(77,166,255,0.3)' : '#1e1f23', 
                        border: `1px solid ${cloudMode === v ? 'rgba(77,166,255,0.5)' : '#2a2a2e'}`, 
                        borderRadius: 4, cursor: 'pointer' 
                      }}>
                      {title}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Cloud Callout */}
          {selectedShape?.type === 'cloud' && (
            <>
              <Sep />
              <div>
                <Lbl>Annotation</Lbl>
                <button
                  style={{ 
                    padding: '2px 9px', fontSize: 11, fontWeight: 600, color: '#4da6ff',
                    background: 'rgba(77,166,255,0.1)', border: '1px solid rgba(77,166,255,0.3)', 
                    borderRadius: 4, cursor: 'pointer', height: 24, display: 'flex', alignItems: 'center'
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.2)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(77,166,255,0.1)'; }}
                  onClick={() => {
                    const id = Math.random().toString(36).substring(7);
                    const width = 150, height = 60;
                    
                    let minX = selectedShape.x;
                    let minY = selectedShape.y;
                    let maxX = selectedShape.x;
                    let maxY = selectedShape.y;
                    
                    if (selectedShape.points && selectedShape.points.length > 0) {
                        minX = Math.min(...selectedShape.points.filter((_: number, i: number) => i % 2 === 0));
                        minY = Math.min(...selectedShape.points.filter((_: number, i: number) => i % 2 !== 0));
                        maxX = Math.max(...selectedShape.points.filter((_: number, i: number) => i % 2 === 0));
                        maxY = Math.max(...selectedShape.points.filter((_: number, i: number) => i % 2 !== 0));
                    }
                    
                    const boxX = maxX + 40;
                    const boxY = minY + (maxY - minY) / 2 - height / 2;
                    
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
                        const xx = param < 0 ? x1 : param > 1 ? x2 : x1 + param * C;
                        const yy = param < 0 ? y1 : param > 1 ? y2 : y1 + param * D;
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
                    
                    useStore.getState().addShape({
                      id, type: 'callout', parentId: selectedShape.id,
                      x: boxX, y: boxY,
                      points: [startX, startY, elbowX, elbowY],
                      width, height,
                      text: 'Double click to edit...',
                      fontSize: 16, fontFamily: 'Inter',
                      strokeColor: useStore.getState().strokeColor, strokeWidth: useStore.getState().strokeWidth,
                      page: selectedShape.page,
                      author: 'Drafting User',
                      date: new Date().toLocaleDateString(),
                    } as any);
                    useStore.getState().pushToHistory();
                  }}
                >
                  + Add Callout
                </button>
              </div>
            </>
          )}

          {/* Fill — only for fillable shapes */}
          {hasFill && (
            <>
              <Sep />
              <div>
                <Lbl>Fill</Lbl>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="color" value={getHex(activeFillColor)} onChange={e => hFill(toRgba(e.target.value, getOpacity(activeFillColor)))}
                    style={{ width: 30, height: 22, padding: 0, border: '1px solid #333', borderRadius: 4, cursor: 'pointer' }} />
                  <button onClick={() => hFill('transparent')} disabled={!!selectedShape?.fillPatternId} title={selectedShape?.fillPatternId ? 'Remove pattern first' : 'No fill'}
                    style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: activeFillColor === 'transparent' ? 'rgba(77,166,255,0.2)' : '#1e1f23', border: `1px solid ${activeFillColor === 'transparent' ? 'rgba(77,166,255,0.5)' : '#2a2a2e'}`, borderRadius: 4, cursor: selectedShape?.fillPatternId ? 'not-allowed' : 'pointer', opacity: selectedShape?.fillPatternId ? 0.3 : 1, color: '#aaa' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 3 }}>
                  <span style={{ fontSize: 8, color: '#555', width: 26 }}>Alpha</span>
                  <input type="range" min="0" max="100" value={Math.round(getOpacity(activeFillColor)*100)} onChange={e => hFill(toRgba(getHex(activeFillColor), +e.target.value/100))} style={{ width: 48, accentColor: '#4da6ff' }} />
                  <button onClick={() => hPattern('NO_FILL')}
                    style={{ background: activeFillColor === 'transparent' ? 'rgba(239,68,68,0.15)' : '#1e1f23', border: `1px solid ${activeFillColor === 'transparent' ? '#ef444455' : '#2a2a2e'}`, color: activeFillColor === 'transparent' ? '#ef4444' : '#888', borderRadius: 4, padding: '2px 5px', fontSize: 9, cursor: 'pointer', marginLeft: 4 }}>
                    None
                  </button>
                </div>
              </div>
              <Sep />

              {/* Pattern */}
              <div style={{ position: 'relative' }}>
                <Lbl>Pattern</Lbl>
                <button ref={patternBtnRef} onClick={openPatternMenu}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, background: selectedShape?.fillPatternId ? 'rgba(77,166,255,0.12)' : '#1e1f23', border: `1px solid ${selectedShape?.fillPatternId ? 'rgba(77,166,255,0.4)' : '#333'}`, color: selectedShape?.fillPatternId ? '#4da6ff' : '#999', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontSize: 11, minWidth: 108 }}>
                  {selectedShape?.fillPatternId
                    ? <><img src={PatternEngine.getPatternPreview(selectedShape.fillPatternId)} style={{ width: 18, height: 13, borderRadius: 2 }} /><span>{selectedShape.fillPatternId}</span></>
                    : <span>{activeFillColor === 'transparent' ? 'No Fill' : 'Solid Fill'}</span>}
                  <span style={{ marginLeft: 'auto', color: '#555' }}>▾</span>
                </button>
                {selectedShape?.fillPatternId && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ fontSize: 9, color: '#666', width: 34 }}>Scale</span>
                      <input 
                        key={selectedShape.id + '_scale_' + (selectedShape.fillPatternScale || 1)}
                        type="number" min="0.01" step="0.01" 
                        defaultValue={selectedShape.fillPatternScale || 1}
                        onBlur={e => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) selectedShapeIds.forEach(id => updateShape(id, { fillPatternScale: Math.max(0.01, val) }));
                        }}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        style={{ width: 50, background: '#1e1f23', border: '1px solid #333', color: '#4da6ff', borderRadius: 4, padding: '2px 4px', fontSize: 10 }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ fontSize: 9, color: '#666', width: 34 }}>Thick</span>
                      <input 
                        key={selectedShape.id + '_thick_' + (selectedShape.fillPatternStrokeWidth ?? selectedShape.strokeWidth ?? 1)}
                        type="number" min="0.1" step="0.1" 
                        defaultValue={selectedShape.fillPatternStrokeWidth ?? selectedShape.strokeWidth ?? 1}
                        onBlur={e => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) selectedShapeIds.forEach(id => updateShape(id, { fillPatternStrokeWidth: Math.max(0.1, val) }));
                        }}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        style={{ width: 50, background: '#1e1f23', border: '1px solid #333', color: '#4da6ff', borderRadius: 4, padding: '2px 4px', fontSize: 10 }} />
                    </div>
                  </div>
                )}

                {showPatternMenu && createPortal(
                  <div onMouseDown={e => e.stopPropagation()}
                    style={{ position: 'fixed', top: patternMenuPos.top, left: patternMenuPos.left, zIndex: 999999, background: '#18191d', border: '1px solid #2a2a2e', borderRadius: 8, width: 320, maxHeight: 440, overflowY: 'auto', boxShadow: '0 12px 32px rgba(0,0,0,0.8)', padding: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    <div onClick={() => hPattern('NO_FILL')}
                      style={{ width: '100%', padding: '7px 10px', cursor: 'pointer', borderRadius: 5, background: (selectedShape?.fillColor === 'transparent' && !selectedShape?.fillPatternId) ? 'rgba(77,166,255,0.15)' : 'transparent', color: (selectedShape?.fillColor === 'transparent' && !selectedShape?.fillPatternId) ? '#4da6ff' : '#888', border: `1px solid ${(selectedShape?.fillColor === 'transparent' && !selectedShape?.fillPatternId) ? 'rgba(77,166,255,0.3)' : '#222'}`, fontSize: 12, marginBottom: 4 }}>
                      🚫 No Fill
                    </div>
                    <div onClick={() => hPattern(null)}
                      style={{ width: '100%', padding: '7px 10px', cursor: 'pointer', borderRadius: 5, background: (selectedShape?.fillColor !== 'transparent' && !selectedShape?.fillPatternId) ? 'rgba(77,166,255,0.15)' : 'transparent', color: (selectedShape?.fillColor !== 'transparent' && !selectedShape?.fillPatternId) ? '#4da6ff' : '#888', border: `1px solid ${(selectedShape?.fillColor !== 'transparent' && !selectedShape?.fillPatternId) ? 'rgba(77,166,255,0.3)' : '#222'}`, fontSize: 12, marginBottom: 8 }}>
                      ⬜ Solid Fill
                    </div>
                    {PatternEngine.getPatternNames().map(p => {
                      const isActive = selectedShape?.fillPatternId === p.id;
                      return (
                        <div key={p.id} onClick={() => hPattern(p.id)}
                          style={{ width: 140, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 6, borderRadius: 6, cursor: 'pointer', background: isActive ? 'rgba(77,166,255,0.15)' : '#1e1f23', border: `1px solid ${isActive ? 'rgba(77,166,255,0.4)' : '#2a2a2e'}` }}
                          onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = '#25262a'; }}
                          onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = '#1e1f23'; }}>
                          <img src={PatternEngine.getPatternPreview(p.id)} style={{ width: 64, height: 42, borderRadius: 4, border: '1px solid #111', objectFit: 'none' }} />
                          <span style={{ fontSize: 10, color: isActive ? '#4da6ff' : '#888', marginTop: 4, textAlign: 'center', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        </div>
                      );
                    })}
                  </div>,
                  document.body
                )}
              </div>
            </>
          )}



          {/* Polygon sides */}
          {isPolygon && (
            <>
              <Sep />
              <div>
                <Lbl>Sides</Lbl>
                <input
                  type="number" min="3" max="64"
                  value={polygonSides}
                  onChange={e => setPolygonSides(Math.max(3, Math.min(64, +e.target.value)))}
                  style={{ width: 52, background: '#1e1f23', border: '1px solid #4da6ff55', color: '#4da6ff', borderRadius: 4, padding: '2px 5px', fontSize: 11, fontWeight: 700 }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 0 }}>
                {[3,4,5,6,8,12].map(n => (
                  <button key={n} onClick={() => setPolygonSides(n)}
                    style={{ width: 24, height: 22, border: `1px solid ${polygonSides === n ? 'rgba(77,166,255,0.6)' : '#2a2a2e'}`, background: polygonSides === n ? 'rgba(77,166,255,0.2)' : '#1e1f23', color: polygonSides === n ? '#4da6ff' : '#888', borderRadius: 4, cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
                    {n}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Shift-constrain hint */}
          {['line','arrow','polyline'].includes(activeTool) && (
            <>
              <Sep />
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 9, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', lineHeight: 1.4 }}>
                  Hold <kbd style={{ background: '#26272c', border: '1px solid #333', borderRadius: 3, padding: '1px 4px', fontSize: 9, color: '#888' }}>Shift</kbd> to constrain
                </span>
              </div>
            </>
          )}

          {/* Measure Area: system + scale + instructions */}
          {(activeTool === 'measure_area' || selectedShape?.type === 'measure_area') && (
            <>
              <Sep />
              <div>
                <Lbl>System</Lbl>
                <select
                  value={selectedShape?.measurementSystem || 'metric'}
                  onChange={e => {
                    if (selectedShapeIds.length > 0) {
                      pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { measurementSystem: e.target.value as any, measurementScale: 1 }));
                    }
                  }}
                  style={{ background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', padding: '2px 4px', borderRadius: 4, fontSize: 11 }}
                >
                  <option value="metric">Metric</option>
                  <option value="imperial">Imperial</option>
                </select>
              </div>
              <div>
                <Lbl>Scale</Lbl>
                <select
                  value={selectedShape?.measurementScale || 1}
                  onChange={e => {
                    if (selectedShapeIds.length > 0) {
                      pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { measurementScale: parseFloat(e.target.value) }));
                    }
                  }}
                  style={{ background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', padding: '2px 4px', borderRadius: 4, fontSize: 11, maxWidth: 120 }}
                >
                  {((selectedShape?.measurementSystem || 'metric') === 'imperial' ? IMPERIAL_SCALES : METRIC_SCALES).map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              {activeTool === 'measure_area' && (
                <>
                  <Sep />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 9, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', lineHeight: 1.4 }}>
                      Click to add vertices • click near start to close
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {showDraw && showText && <Sep />}

      {showText && (
        <>
          <div>
            <Lbl>Font</Lbl>
            <select value={activeFontFamily} onChange={e => hFont(e.target.value)}
              style={{ background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', padding: '2px 6px', borderRadius: 4, fontSize: 11, maxWidth: 130 }}>
              {[
                'Inter', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 
                'Century Gothic', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 
                'Franklin Gothic Medium', 'Gabriola', 'Garamond', 'Georgia', 'Impact', 'Ink Free', 
                'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif', 'MS Gothic', 'MV Boli', 
                'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'SimSun', 'Sylfaen', 
                'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'
              ].map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <Sep />
          <div>
            <Lbl>Size</Lbl>
            <input type="number" min="8" max="200" value={activeFontSize} onChange={e => hSize(+e.target.value)}
              style={{ width: 48, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
          </div>
          <Sep />
          <div>
            <Lbl>Color</Lbl>
            <input type="color" value={activeTextColor.slice(0,7)} onChange={e => hTextColor(e.target.value)}
              style={{ width: 30, height: 22, padding: 0, border: '1px solid #333', borderRadius: 4, cursor: 'pointer' }} />
          </div>
          <Sep />
          <div>
            <Lbl>Style</Lbl>
            <div style={{ display: 'flex', gap: 3 }}>
              {[
                { prop: 'isBold' as const, label: 'B', active: activeIsBold, extra: { fontWeight: 700 } },
                { prop: 'isItalic' as const, label: 'I', active: activeIsItalic, extra: { fontStyle: 'italic' } },
                { prop: 'isUnderline' as const, label: 'U', active: activeIsUnderline, extra: { textDecoration: 'underline' } },
                { prop: 'isStrike' as const, label: 'S', active: activeIsStrike, extra: { textDecoration: 'line-through' } },
              ].map(({ prop, label, active, extra }) => (
                <button key={prop} onClick={() => hToggle(prop)}
                  style={{ width: 24, height: 22, border: `1px solid ${active ? 'rgba(77,166,255,0.5)' : '#2a2a2e'}`, background: active ? 'rgba(77,166,255,0.2)' : '#1e1f23', color: active ? '#4da6ff' : '#aaa', borderRadius: 4, cursor: 'pointer', fontSize: 11, ...extra }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Table properties & actions ── */}
      {selectedShape?.type === 'table' && (
        <>
          <Sep />
          <div>
            <Lbl>Table Actions</Lbl>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                disabled={!(selectedShape.tableData?.selectedCellIds && selectedShape.tableData.selectedCellIds.length > 1)}
                onClick={() => handleMergeCells(selectedShape.id)}
                style={{
                  background: '#1e1f23',
                  border: '1px solid #2a2a2e',
                  color: (selectedShape.tableData?.selectedCellIds && selectedShape.tableData.selectedCellIds.length > 1) ? '#4da6ff' : '#666',
                  padding: '4px 8px',
                  borderRadius: 4,
                  fontSize: 11,
                  cursor: (selectedShape.tableData?.selectedCellIds && selectedShape.tableData.selectedCellIds.length > 1) ? 'pointer' : 'default',
                  height: 22,
                  display: 'flex',
                  alignItems: 'center',
                  fontWeight: 600
                }}
              >
                Merge Cells
              </button>
              <button
                disabled={!(selectedShape.tableData?.selectedCellIds && selectedShape.tableData.selectedCellIds.some(cid => {
                  const cell = selectedShape.tableData!.cells[cid];
                  return cell && ((cell.colSpan || 1) > 1 || (cell.rowSpan || 1) > 1);
                }))}
                onClick={() => handleUnmergeCells(selectedShape.id)}
                style={{
                  background: '#1e1f23',
                  border: '1px solid #2a2a2e',
                  color: (selectedShape.tableData?.selectedCellIds && selectedShape.tableData.selectedCellIds.some(cid => {
                    const cell = selectedShape.tableData!.cells[cid];
                    return cell && ((cell.colSpan || 1) > 1 || (cell.rowSpan || 1) > 1);
                  })) ? '#4da6ff' : '#666',
                  padding: '4px 8px',
                  borderRadius: 4,
                  fontSize: 11,
                  cursor: (selectedShape.tableData?.selectedCellIds && selectedShape.tableData.selectedCellIds.some(cid => {
                    const cell = selectedShape.tableData!.cells[cid];
                    return cell && ((cell.colSpan || 1) > 1 || (cell.rowSpan || 1) > 1);
                  })) ? 'pointer' : 'default',
                  height: 22,
                  display: 'flex',
                  alignItems: 'center',
                  fontWeight: 600
                }}
              >
                Unmerge Cells
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Marks properties ── */}
      {showMarks && (
        <>
          {/* Stroke color + weight */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div>
              <Lbl>Color</Lbl>
              <input type="color"
                value={(markShape?.strokeColor || strokeColor).slice(0,7)}
                onChange={e => hMarkStroke(e.target.value)}
                style={{ width: 30, height: 22, padding: 0, border: '1px solid #333', borderRadius: 4, cursor: 'pointer' }} />
            </div>
            <div>
              <Lbl>Weight</Lbl>
              <input type="number" min="1" max="10"
                value={markShape?.strokeWidth ?? strokeWidth}
                onChange={e => hMarkWidth(+e.target.value)}
                style={{ width: 42, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
            </div>
            <div>
              <Lbl>Font size</Lbl>
              <input type="number" min="6" max="72"
                value={markShape?.fontSize ?? 11}
                onChange={e => hMarkFontSize(+e.target.value)}
                style={{ width: 42, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
            </div>
            {(activeMark === 'mark_level' || activeMark === 'mark_grid' || activeMark === 'mark_block' || activeMark === 'mark_section') && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Line Style</Lbl>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {[
                      { v: undefined, title: 'Solid', el: <div style={{ width: 16, height: 2, background: '#ccc' }} /> },
                      { v: [10,10], title: 'Dashed', el: <div style={{ width: 16, height: 2, borderBottom: '2px dashed #ccc' }} /> },
                      { v: [15,5,5,5], title: 'Center', el: <div style={{ width: 16, height: 2, borderBottom: '2px dotted #ccc' }} /> },
                    ].map(({ v, title, el }) => {
                      const isActive = markShape ? (markShape.dash?.join(',') === v?.join(',')) : false;
                      return (
                        <button key={title} onClick={() => hDash(v)} title={title}
                          style={{ width: 24, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: isActive ? 'rgba(77,166,255,0.2)' : '#1e1f23', border: `1px solid ${isActive ? 'rgba(77,166,255,0.5)' : '#2a2a2e'}`, borderRadius: 4, cursor: 'pointer' }}>
                          {el}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
            
            {activeMark === 'mark_block' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Width</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.width || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { width: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Length</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.height || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { height: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Rotation</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={Math.round(markShape.rotation || 0)}
                      onChange={e => {
                        const val = +e.target.value;
                        if (selectedShapeIds.length > 0) pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { rotation: val }));
                      }}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
              </>
            )}

            {activeMark === 'mark_w_section' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Width</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.width || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { width: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Depth</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.height || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { height: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Thickness</Lbl>
                  <input type="number" min="1"
                    value={parseFloat(markShape.markerData?.thickness || '5')}
                    onChange={e => hMarkerData('thickness', e.target.value)}
                    style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Rotation</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={Math.round(markShape.rotation || 0)}
                      onChange={e => {
                        const val = +e.target.value;
                        if (selectedShapeIds.length > 0) pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { rotation: val }));
                      }}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
              </>
            )}

            {activeMark === 'mark_sealant' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Width</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.width || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { width: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Height</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.height || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { height: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Thickness</Lbl>
                  <input type="number" min="1"
                    value={parseFloat(markShape.markerData?.thickness || '2')}
                    onChange={e => hMarkerData('thickness', e.target.value)}
                    style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Rotation</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={Math.round(markShape.rotation || 0)}
                      onChange={e => {
                        const val = +e.target.value;
                        if (selectedShapeIds.length > 0) pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { rotation: val }));
                      }}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
              </>
            )}

            {activeMark === 'mark_angle' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Leg 1</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.width || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { width: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Leg 2</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.height || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { height: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Degrees</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={parseFloat(markShape.markerData?.angle || '90')}
                      onChange={e => hMarkerData('angle', e.target.value)}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
                <div>
                  <Lbl>Rotation</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={Math.round(markShape.rotation || 0)}
                      onChange={e => {
                        const val = +e.target.value;
                        if (selectedShapeIds.length > 0) pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { rotation: val }));
                      }}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
              </>
            )}

            {activeMark === 'mark_bolt' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Head Width</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.width || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { width: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Depth</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.height || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { height: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Rotation</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={Math.round(markShape.rotation || 0)}
                      onChange={e => {
                        const val = +e.target.value;
                        if (selectedShapeIds.length > 0) pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { rotation: val }));
                      }}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
              </>
            )}

            {activeMark === 'mark_thermal_spacer' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Width</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.width || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { width: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Height</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.height || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { height: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Rotation</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={Math.round(markShape.rotation || 0)}
                      onChange={e => {
                        const val = +e.target.value;
                        if (selectedShapeIds.length > 0) pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { rotation: val }));
                      }}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
                <div style={{ width: 1, height: 20, background: '#2a2a2e', margin: '0 4px' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Lbl>Flip</Lbl>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button 
                      onClick={() => hMarkerData('flipH', markShape.markerData?.flipH === 'true' ? 'false' : 'true')}
                      style={{ ...btnBase, background: markShape.markerData?.flipH === 'true' ? '#4da6ff33' : 'transparent', border: '1px solid #2a2a2e', fontSize: 10, padding: '2px 4px' }}>
                      Horiz
                    </button>
                    <button 
                      onClick={() => hMarkerData('flipV', markShape.markerData?.flipV === 'true' ? 'false' : 'true')}
                      style={{ ...btnBase, background: markShape.markerData?.flipV === 'true' ? '#4da6ff33' : 'transparent', border: '1px solid #2a2a2e', fontSize: 10, padding: '2px 4px' }}>
                      Vert
                    </button>
                  </div>
                </div>
              </>
            )}

            {activeMark === 'mark_insulation' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Thickness</Lbl>
                  <input type="number" min="2"
                    value={parseFloat(markShape.markerData?.thickness || '20')}
                    onChange={e => hMarkerData('thickness', e.target.value)}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
              </>
            )}

            {activeMark === 'mark_metal_deck' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Scale</Lbl>
                  <input type="number" min="1" step="1"
                    value={parseFloat(markShape.markerData?.scale || '20')}
                    onChange={e => hMarkerData('scale', e.target.value)}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Rotation</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={(() => {
                        const pts = markShape.points || [0, 0, 200, 0];
                        const dx = pts[2], dy = pts[3];
                        let deg = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
                        if (deg < 0) deg += 360;
                        return deg;
                      })()}
                      onChange={e => {
                        const val = +e.target.value;
                        if (selectedShapeIds.length > 0) pushToHistory();
                        selectedShapeIds.forEach(id => {
                          const s = shapes.find(x => x.id === id);
                          if (s && s.points && s.points.length >= 4) {
                            const pts = s.points;
                            const dx = pts[2], dy = pts[3];
                            const len = Math.sqrt(dx * dx + dy * dy) || 1;
                            const rad = val * Math.PI / 180;
                            const newDx = len * Math.cos(rad);
                            const newDy = len * Math.sin(rad);
                            updateShape(id, { points: [0, 0, newDx, newDy] });
                          }
                        });
                      }}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
              </>
            )}

            {activeMark === 'mark_masonry_ties' && markShape && (
              <>
                <div style={{ width: 1, height: 28, background: '#2a2a2e', margin: '0 4px' }} />
                <div>
                  <Lbl>Width</Lbl>
                  <input type="number" min="1"
                    value={Math.round(markShape.width || 0)}
                    onChange={e => {
                      const val = +e.target.value;
                      if (selectedShapeIds.length > 0) pushToHistory();
                      selectedShapeIds.forEach(id => updateShape(id, { width: val }));
                    }}
                    style={{ width: 50, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                </div>
                <div>
                  <Lbl>Rotation</Lbl>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input type="number"
                      value={Math.round(markShape.rotation || 0)}
                      onChange={e => {
                        const val = +e.target.value;
                        if (selectedShapeIds.length > 0) pushToHistory();
                        selectedShapeIds.forEach(id => updateShape(id, { rotation: val }));
                      }}
                      style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
                    <span style={{ fontSize: 11, color: '#888' }}>°</span>
                  </div>
                </div>
              </>
            )}
          </div>
          <Sep />

          {/* Per-type label fields */}
          {(activeMark === 'mark_section' || activeMark === 'mark_callout') && markShape && (
            <>
              <div>
                <Lbl>View #</Lbl>
                <input
                  value={markShape.markerData?.top ?? ''}
                  onChange={e => hMarkerData('top', e.target.value)}
                  placeholder="1"
                  style={{ width: 52, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              <div>
                <Lbl>Sheet #</Lbl>
                <input
                  value={markShape.markerData?.bottom ?? ''}
                  onChange={e => hMarkerData('bottom', e.target.value)}
                  placeholder="A100"
                  style={{ width: 64, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              {activeMark === 'mark_section' && (
                <div>
                  <Lbl>Flip Arrow</Lbl>
                  <button
                    onClick={() => hMarkerData('flipArrow', markShape.markerData?.flipArrow === 'true' ? 'false' : 'true')}
                    style={{ 
                      padding: '2px 6px', fontSize: 10, fontWeight: 600, height: 22,
                      color: markShape.markerData?.flipArrow === 'true' ? '#4da6ff' : '#aaa',
                      background: markShape.markerData?.flipArrow === 'true' ? 'rgba(77,166,255,0.18)' : '#1e1f23',
                      border: `1px solid ${markShape.markerData?.flipArrow === 'true' ? 'rgba(77,166,255,0.45)' : '#2a2a2e'}`,
                      borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s'
                    }}
                  >
                    Flip
                  </button>
                </div>
              )}
            </>
          )}
          {activeMark === 'mark_level' && markShape && (
            <>
              <div>
                <Lbl>Floor name</Lbl>
                <input
                  value={markShape.markerData?.name ?? ''}
                  onChange={e => hMarkerData('name', e.target.value)}
                  placeholder="First Floor"
                  style={{ width: 90, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              <div>
                <Lbl>Elevation</Lbl>
                <input
                  value={markShape.markerData?.elevation ?? ''}
                  onChange={e => hMarkerData('elevation', e.target.value)}
                  placeholder="100'-0"
                  style={{ width: 68, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
            </>
          )}
          {activeMark === 'mark_grid' && markShape && (
            <div>
              <Lbl>Label</Lbl>
              <input
                value={markShape.markerData?.label ?? ''}
                onChange={e => hMarkerData('label', e.target.value)}
                placeholder="A"
                style={{ width: 64, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
            </div>
          )}
          {activeMark === 'mark_elevation' && markShape && (
            <>
              <div>
                <Lbl>Center</Lbl>
                <input
                  value={markShape.markerData?.label ?? ''}
                  onChange={e => hMarkerData('label', e.target.value)}
                  placeholder="A5.10"
                  style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              <div>
                <Lbl>Top</Lbl>
                <input
                  value={markShape.markerData?.top ?? ''}
                  onChange={e => hMarkerData('top', e.target.value)}
                  placeholder="N"
                  style={{ width: 32, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              <div>
                <Lbl>Bottom</Lbl>
                <input
                  value={markShape.markerData?.bottom ?? ''}
                  onChange={e => hMarkerData('bottom', e.target.value)}
                  placeholder="S"
                  style={{ width: 32, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              <div>
                <Lbl>Left</Lbl>
                <input
                  value={markShape.markerData?.left ?? ''}
                  onChange={e => hMarkerData('left', e.target.value)}
                  placeholder="W"
                  style={{ width: 32, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              <div>
                <Lbl>Right</Lbl>
                <input
                  value={markShape.markerData?.right ?? ''}
                  onChange={e => hMarkerData('right', e.target.value)}
                  placeholder="E"
                  style={{ width: 32, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
            </>
          )}
          {activeMark === 'mark_break_line' && markShape && (
            <>
              <div>
                <Lbl>Kink Size</Lbl>
                <input
                  type="number"
                  value={markShape.markerData?.kinkSize || '10'}
                  onChange={e => hMarkerData('kinkSize', e.target.value)}
                  style={{ width: 44, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              <div>
                <Lbl>Mask Side</Lbl>
                <select
                  value={markShape.markerData?.maskSide || 'bottom'}
                  onChange={e => hMarkerData('maskSide', e.target.value)}
                  style={{ width: 74, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }}
                >
                  <option value="top">Top/Left</option>
                  <option value="bottom">Bottom/Right</option>
                </select>
              </div>
              <div>
                <Lbl>Mask</Lbl>
                <select
                  value={markShape.markerData?.showMask || 'true'}
                  onChange={e => hMarkerData('showMask', e.target.value)}
                  style={{ width: 54, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }}
                >
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </select>
              </div>
            </>
          )}
          {activeMark === 'mark_single_elevation' && markShape && (
            <>
              <div>
                <Lbl>Circle Text</Lbl>
                <input
                  value={markShape.markerData?.top ?? ''}
                  onChange={e => hMarkerData('top', e.target.value)}
                  placeholder="-"
                  style={{ width: 64, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
              <div>
                <Lbl>Tail Text</Lbl>
                <input
                  value={markShape.markerData?.bottom ?? ''}
                  onChange={e => hMarkerData('bottom', e.target.value)}
                  placeholder="-"
                  style={{ width: 64, background: '#1e1f23', border: '1px solid #2a2a2e', color: '#ddd', borderRadius: 4, padding: '2px 5px', fontSize: 11 }} />
              </div>
            </>
          )}
          {!markShape && (
            <span style={{ fontSize: 10, color: '#555', fontStyle: 'italic' }}>
              Click to place — select a mark to edit its labels
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// useStore.ts — Normalized Multi-Tab Zustand Store
//
// Phase 1 of the multi-tab architecture refactor.
//
// Architecture: "Root-as-Active-Copy"
//   - Root-level proxy fields (shapes, scale, etc.) are the LIVE, writable
//     copy for the currently active tab.
//   - `documents[tabId]` is the PERSISTED copy, flushed from root at tab-
//     switch boundaries by `saveRootToActiveDoc()`.
//   - All existing mutation actions (addShape, setScale, undo, etc.) operate
//     on root-level state and are UNCHANGED from the pre-refactor store.
//     This keeps all 6 existing consumer components working with zero edits.
//   - `setPdfBytes` and `setPageNum` are the exception: they write to BOTH
//     root AND documents[activeTabId] immediately, because the save/export
//     pipeline in TopCommandCenter needs current bytes without a tab switch.
//
// Tab Switch Lifecycle:
//   openTab / setActiveTab / closeTab all call saveRootToActiveDoc() first
//   to snapshot the current root state into documents[oldTabId], then splat
//   the new tab's DocumentState onto the root proxy fields.
//
// Removal plan: In Phase 4, once DocumentViewer reads directly from
//   documents[tabId] and all consumers are migrated, the root proxy fields
//   and saveRootToActiveDoc() are deleted. TypeScript will surface any
//   remaining stragglers at compile time.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type {
  MarkupState,
  DocumentState,
  Guide,
  ShapeData,
  HistoryEntry,
} from './types';

// Re-export everything from types.ts so that existing imports like:
//   import { useStore, type ShapeData } from './store/useStore'
// continue to work without modification across all consumer files.
export type { ToolType, ShapeData, MarkupState, DocumentState, TabMeta, Guide, MasterPage } from './types';

// ─── History bounds ───────────────────────────────────────────────────────────
// Undo/redo stacks were unbounded and each page-change entry pins a full copy of
// the PDF. Cap total depth and the number of PDF-carrying (page insert/delete)
// entries. We cut at a snapshot boundary instead of stripping bytes, so an undo
// never restores shapes that don't match the PDF.
const MAX_HISTORY_ENTRIES = 50;
const MAX_PAGE_SNAPSHOTS = 5;

/**
 * Trim a history list. `newestFirst` = true for `future` (index 0 is newest),
 * false for `past` (last index is newest).
 */
function trimHistory<T extends { pdfBytes?: Uint8Array }>(entries: T[], newestFirst = false): T[] {
  let list = newestFirst ? entries.slice().reverse() : entries.slice(); // oldest -> newest
  if (list.length > MAX_HISTORY_ENTRIES) list = list.slice(list.length - MAX_HISTORY_ENTRIES);
  let snapshots = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].pdfBytes) {
      snapshots++;
      if (snapshots > MAX_PAGE_SNAPSHOTS) { list = list.slice(i + 1); break; }
    }
  }
  return newestFirst ? list.reverse() : list;
}

// ─── Default Document State ───────────────────────────────────────────────────

const DEFAULT_DOC_STATE: DocumentState = {
  pdfBytes: null,
  pageNum: 1,
  numPages: 0,
  shapes: [],
  past: [],
  future: [],
  selectedShapeIds: [],
  scale: 1.0,
  scaleCalibration: 1.0,
  panOffset: { x: 0, y: 0 },
  layersVisible: { base: true, active: true, chest: true },
  // Spread layout defaults
  isSpread: false,
  activeSpreadIndex: 0,
  activeSide: 1,
  hasFrontCover: false,
  hasBackCover: false,
  // Master page assignments — empty by default
  masterPageAssignments: {},
  // Bleed & CMYK Exporter configurations
  bleedOffset: 0,
  showBleedGuides: true,
  colorSpaceMode: 'srgb',
  // Guidelines for this document
  guides: [],
  pageWidth: 612,
  pageHeight: 792,
};

// No initial tab — the app boots empty. A tab is created when the user
// opens a file or clicks '+'.

// ─── Internal Helpers ─────────────────────────────────────────────────────────
// Shims removed in Phase 4

// ─── Store ────────────────────────────────────────────────────────────────────

export const useStore = create<MarkupState>((set, get) => ({

  // ── Tab Registry ─────────────────────────────────────────────────────────────

  documents: {},
  tabMetas: {},
  savingStatus: {},
  notifications: [],
  activeTabId: null,
  pdfBytes: null,
  pageNum: 1,
  numPages: 0,
  documentTool: 'select',
  masterTool: 'select',
  previousActiveTabId: null,

  openTab: (tabId, meta, initialState) =>
    set((state) => {
      const defaultMasterId = `master-a-${tabId}`;
      const defaultMasterTabId = `__master__${defaultMasterId}`;

      const initialMasterPages = [
        {
          id: defaultMasterId,
          name: 'A-Master',
          backgroundPdfBytes: null,
          backgroundPageNum: 1,
          shapes: [],
          pageWidth: 612,
          pageHeight: 792,
          isSpread: false,
          guides: [],
        }
      ];

      const newDoc: DocumentState = {
        ...DEFAULT_DOC_STATE,
        masterPages: initialMasterPages,
        ...initialState,
      };

      const updatedDocuments = {
        ...state.documents,
        [tabId]: newDoc,
        [defaultMasterTabId]: {
          ...DEFAULT_DOC_STATE,
          pdfBytes: null,
          pageNum: 1,
          numPages: 1,
          shapes: [],
          scale: 0.75,
          panOffset: { x: 40, y: 60 },
          isSpread: false,
        }
      };

      return {
        documents: updatedDocuments,
        tabMetas: {
          ...state.tabMetas,
          [tabId]: { id: tabId, ...meta },
        },
        activeTabId: tabId,
        masterPages: initialMasterPages,
        activeMasterPageId: defaultMasterId,
        guides: newDoc.guides || [],
      };
    }),

  closeTab: (tabId) =>
    set((state) => {
      const updatedDocuments = { ...state.documents };
      delete updatedDocuments[tabId];

      const closedDoc = state.documents[tabId];
      if (closedDoc && closedDoc.masterPages) {
        closedDoc.masterPages.forEach(m => {
          delete updatedDocuments[`__master__${m.id}`];
        });
      }
      
      const updatedMetas = { ...state.tabMetas };
      delete updatedMetas[tabId];
      
      let newActiveTabId: string | null = state.activeTabId;
      let nextMasterPages = state.masterPages;
      let nextActiveMasterPageId = state.activeMasterPageId;

      if (state.activeTabId === tabId) {
        const remainingIds = Object.keys(updatedDocuments).filter(id => !id.startsWith('__master__'));
        newActiveTabId = remainingIds.length > 0 ? remainingIds[remainingIds.length - 1] : null;

        if (newActiveTabId) {
          const nextDoc = updatedDocuments[newActiveTabId];
          nextMasterPages = nextDoc.masterPages || [];
          nextActiveMasterPageId = nextMasterPages.length > 0 ? nextMasterPages[0].id : null;
        } else {
          nextMasterPages = [];
          nextActiveMasterPageId = null;
        }
      }

      return {
        documents: updatedDocuments,
        tabMetas: updatedMetas,
        activeTabId: newActiveTabId,
        masterPages: nextMasterPages,
        activeMasterPageId: nextActiveMasterPageId,
        guides: newActiveTabId && updatedDocuments[newActiveTabId] ? updatedDocuments[newActiveTabId].guides || [] : [],
      };
    }),

  setActiveTab: (newTabId) =>
    set((state) => {
      if (state.activeTabId === newTabId) return {};
      if (!state.documents[newTabId]) return {};
      
      const doc = state.documents[newTabId];
      let docMasterPages = doc.masterPages;
      const updatedDocuments = { ...state.documents };

      if (!docMasterPages || docMasterPages.length === 0) {
        const defaultMasterId = `master-a-${newTabId}`;
        const defaultMasterTabId = `__master__${defaultMasterId}`;
        docMasterPages = [
          {
            id: defaultMasterId,
            name: 'A-Master',
            backgroundPdfBytes: null,
            backgroundPageNum: 1,
            shapes: [],
            pageWidth: 612,
            pageHeight: 792,
            isSpread: false,
            guides: [],
          }
        ];
        updatedDocuments[newTabId] = { ...doc, masterPages: docMasterPages };
        updatedDocuments[defaultMasterTabId] = {
          ...DEFAULT_DOC_STATE,
          pdfBytes: null,
          pageNum: 1,
          numPages: 1,
          shapes: [],
          scale: 0.75,
          panOffset: { x: 40, y: 60 },
          isSpread: false,
        };
      }

      const firstMasterId = docMasterPages.length > 0 ? docMasterPages[0].id : null;

      return {
        activeTabId: newTabId,
        masterPages: docMasterPages,
        activeMasterPageId: firstMasterId,
        documents: updatedDocuments,
        guides: doc.guides || [],
      };
    }),

  updateTabMeta: (tabId, updates) =>
    set((state) => {
      if (!state.tabMetas[tabId]) return {};
      return {
        tabMetas: {
          ...state.tabMetas,
          [tabId]: { ...state.tabMetas[tabId], ...updates },
        },
      };
    }),

  // ── Global Tool State ─────────────────────────────────────────────────────────
  // Shared across all tabs. Unchanged from pre-refactor store.

  activeTool: 'select',
  setActiveTool: (tool) => set((state) => {
    const updates: Partial<MarkupState> = { activeTool: tool };
    if (state.editorMode === 'master') {
      updates.masterTool = tool;
    } else {
      updates.documentTool = tool;
    }
    if (tool === 'highlight') {
      return { ...updates, strokeColor: '#fbff00', strokeWidth: 24 };
    }
    // Optional: Restore standard defaults when switching back from highlight
    if (state.activeTool === 'highlight') {
      return { ...updates, strokeColor: '#000000', strokeWidth: 1 };
    }
    return updates;
  }),

  strokeColor: '#000000',
  setStrokeColor: (color) => set({ strokeColor: color }),

  strokeWidth: 1,
  setStrokeWidth: (width) => set({ strokeWidth: width }),

  fillColor: 'transparent',
  setFillColor: (color) => set({ fillColor: color }),

  activeDash: undefined,
  setActiveDash: (dash) => set({ activeDash: dash }),

  activeStamp: 'APPROVED',
  setActiveStamp: (stamp) => set({ activeStamp: stamp }),

  polygonSides: 6,
  setPolygonSides: (sides) => set({ polygonSides: sides }),

  cloudMode: 'rect',
  setCloudMode: (mode) => set({ cloudMode: mode }),

  showArrowHead: true,
  setShowArrowHead: (show) => set({ showArrowHead: show }),

  arrowHeadType: 'arrow',
  setArrowHeadType: (type) => set({ arrowHeadType: type }),

  arrowHeadSize: 15,
  setArrowHeadSize: (size) => set({ arrowHeadSize: size }),

  arrowHeadAngle: 30,
  setArrowHeadAngle: (angle) => set({ arrowHeadAngle: angle }),

  arrowHeadFilled: true,
  setArrowHeadFilled: (filled) => set({ arrowHeadFilled: filled }),

  addLabelMode: false,
  setAddLabelMode: (enabled) => set({ addLabelMode: enabled }),

  customAssets: [],
  addCustomAsset: (url) =>
    set((state) => ({ customAssets: [...state.customAssets, url] })),
  removeCustomAsset: (index) => set((state) => ({ customAssets: state.customAssets.filter((_, i) => i !== index) })),

  customStamps: [],
  addCustomStamp: (url) => set((state) => ({ customStamps: [...state.customStamps, url] })),
  removeCustomStamp: (index) => set((state) => ({ customStamps: state.customStamps.filter((_, i) => i !== index) })),

  isScaleMode: false,
  setIsScaleMode: (val) => set({ isScaleMode: val }),

  draggingAssetIndex: null,
  setDraggingAssetIndex: (index) => set({ draggingAssetIndex: index }),

  pendingTableDimensions: null,
  setPendingTableDimensions: (dims) => set({ pendingTableDimensions: dims }),

  brushThickness: 12,
  setBrushThickness: (thickness) => set({ brushThickness: thickness }),

  // ── Guide / Snap System ──────────────────────────────────────────────────────────────

  guides: [],
  addGuide: (guide: Guide) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      const newGuides = [...(doc.guides || []), guide];
      return {
        guides: newGuides,
        documents: {
          ...state.documents,
          [state.activeTabId]: { ...doc, guides: newGuides }
        },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: { ...state.tabMetas, [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true } }
        } : {})
      };
    }),
  updateGuide: (id, position, extra) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      const newGuides = (doc.guides || []).map(g => g.id === id ? { ...g, position, ...extra } : g);
      return {
        guides: newGuides,
        documents: {
          ...state.documents,
          [state.activeTabId]: { ...doc, guides: newGuides }
        },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: { ...state.tabMetas, [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true } }
        } : {})
      };
    }),
  removeGuide: (id) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      const newGuides = (doc.guides || []).filter(g => g.id !== id);
      return {
        guides: newGuides,
        documents: {
          ...state.documents,
          [state.activeTabId]: { ...doc, guides: newGuides }
        },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: { ...state.tabMetas, [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true } }
        } : {})
      };
    }),

  showGuides: true,
  toggleShowGuides: () => set((state) => ({ showGuides: !state.showGuides })),

  snapEnabled: true,
  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),

  vectorSnapEnabled: true,
  toggleVectorSnap: () => set((state) => ({ vectorSnapEnabled: !state.vectorSnapEnabled })),

  centerSnapEnabled: true,
  toggleCenterSnap: () => set((state) => ({ centerSnapEnabled: !state.centerSnapEnabled })),

  selectedGuideId: null,
  setSelectedGuideId: (id) => set({ selectedGuideId: id }),

  guideSelectionEnabled: false,
  toggleGuideSelection: () => set((state) => {
    const newEnabled = !state.guideSelectionEnabled;
    // Clear guide selection when turning off guide-select mode
    return { guideSelectionEnabled: newEnabled, selectedGuideId: newEnabled ? state.selectedGuideId : null };
  }),

  snapSensitivity: 10,
  setSnapSensitivity: (val) => set({ snapSensitivity: Math.max(1, Math.min(100, val)) }),

  // ── Root-Level Proxy Defaults ────────────────────────────────────────────────
  // Removed in Phase 4.

  // ── Per-Document Setters ──────────────────────────────────────────────────────

  setPageDimensions: (width, height) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...state.documents[aid],
            pageWidth: width,
            pageHeight: height,
          },
        },
      };
    }),

  setScale: (update) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const curr = state.documents[state.activeTabId].scale;
      return { documents: { ...state.documents, [state.activeTabId]: { ...state.documents[state.activeTabId], scale: typeof update === 'function' ? update(curr) : update } } };
    }),

  setScaleCalibration: (val) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      return { documents: { ...state.documents, [state.activeTabId]: { ...state.documents[state.activeTabId], scaleCalibration: val } } };
    }),

  setLayerVisible: (layer, visible) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      return { documents: { ...state.documents, [state.activeTabId]: { ...state.documents[state.activeTabId], layersVisible: { ...state.documents[state.activeTabId].layersVisible, [layer]: visible } } } };
    }),

  setPanOffset: (update) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const curr = state.documents[state.activeTabId].panOffset || { x: 0, y: 0 };
      return { documents: { ...state.documents, [state.activeTabId]: { ...state.documents[state.activeTabId], panOffset: typeof update === 'function' ? update(curr) : update } } };
    }),

  // Atomically update both scale and panOffset in one Zustand set call.
  // This prevents an intermediate React render with scale changed but panOffset stale,
  // which was causing the zoom-pivot drift / page-jumping-to-top bug.
  zoomTo: (newScale, newPanOffset) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: { ...state.documents[aid], scale: newScale, panOffset: newPanOffset },
        },
      };
    }),

  /**
   * Sets PDF bytes for the active tab.
   *
   * Writes to BOTH the root proxy AND documents[activeTabId] immediately
   * (does not wait for a tab switch to flush). This is required because
   * TopCommandCenter's save/export pipeline reads documents[activeTabId].pdfBytes
   * after Phase 3 migration, and we want that to be accurate from Phase 1.
   */
  setPdfBytes: (bytes) =>
    set((state) => {
      const base: Partial<MarkupState> = { pdfBytes: bytes };
      if (!state.activeTabId || !state.documents[state.activeTabId]) {
        return base;
      }
      return {
        ...base,
        documents: {
          ...state.documents,
          [state.activeTabId]: {
            ...state.documents[state.activeTabId],
            pdfBytes: bytes,
          },
        },
      };
    }),

  /**
   * Sets the current page number for the active tab.
   * Same dual-write strategy as setPdfBytes for consistency.
   */
  setPageNum: (page) =>
    set((state) => {
      const base: Partial<MarkupState> = { pageNum: page };
      if (!state.activeTabId || !state.documents[state.activeTabId]) {
        return base;
      }
      return {
        ...base,
        documents: {
          ...state.documents,
          [state.activeTabId]: {
            ...state.documents[state.activeTabId],
            pageNum: page,
          },
        },
      };
    }),

  setNumPages: (n) =>
    set((state) => {
      const base: Partial<MarkupState> = { numPages: n };
      if (!state.activeTabId || !state.documents[state.activeTabId]) {
        return base;
      }
      return {
        ...base,
        documents: {
          ...state.documents,
          [state.activeTabId]: {
            ...state.documents[state.activeTabId],
            numPages: n,
          },
        },
      };
    }),

  // ── Spread Layout Setters ────────────────────────────────────────────────

  setIsSpread: (val) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...state.documents[aid],
            isSpread: val,
            // When switching to spread mode reset to spread 0 / page 1
            activeSpreadIndex: val ? 0 : state.documents[aid].activeSpreadIndex,
            pageNum: val ? 1 : state.documents[aid].pageNum,
            activeSide: 1,
          },
        },
      };
    }),

  setActiveSpreadIndex: (idx) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      const hasFrontCover = state.documents[aid].hasFrontCover ?? false;
      // Front cover: spread 0 = page 1 (solo), spread N = page 2N
      // Normal: spread N = page 2N + 1
      const leftPage = hasFrontCover
        ? (idx === 0 ? 1 : idx * 2)
        : idx * 2 + 1;
      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...state.documents[aid],
            activeSpreadIndex: idx,
            pageNum: leftPage,
            activeSide: 1,
          },
        },
      };
    }),

  setActiveSide: (side) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: { ...state.documents[aid], activeSide: side },
        },
      };
    }),

  setHasFrontCover: (val) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...state.documents[aid],
            hasFrontCover: val,
            activeSpreadIndex: 0,
            pageNum: 1,
            activeSide: 1,
          },
        },
      };
    }),

  setHasBackCover: (val) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...state.documents[aid],
            hasBackCover: val,
          },
        },
      };
    }),

  // ── History ───────────────────────────────────────────────────────────────────
  // Operates on root-level `shapes`, `past`, `future` (the active-tab proxies).
  // Unchanged from pre-refactor store.

  pushToHistory: () =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      return {
        documents: {
          ...state.documents,
          [state.activeTabId]: { ...doc, past: trimHistory<HistoryEntry>([...doc.past, { shapes: JSON.parse(JSON.stringify(doc.shapes)) }]), future: [] }
        },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: {
            ...state.tabMetas,
            [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true }
          }
        } : {})
      };
    }),

  pushPageChangeToHistory: () =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      const entry = {
        shapes: JSON.parse(JSON.stringify(doc.shapes)),
        pdfBytes: doc.pdfBytes ?? undefined, // immutable — share by reference, no copy
        pageNum: doc.pageNum
      };
      return {
        documents: {
          ...state.documents,
          [state.activeTabId]: { ...doc, past: trimHistory([...doc.past, entry]), future: [] }
        },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: {
            ...state.tabMetas,
            [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true }
          }
        } : {})
      };
    }),

  undo: () =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      if (doc.past.length === 0) return {};
      const previous = doc.past[doc.past.length - 1];
      const newPast = doc.past.slice(0, doc.past.length - 1);

      const currentEntry = {
        shapes: JSON.parse(JSON.stringify(doc.shapes)),
        pdfBytes: doc.pdfBytes ?? undefined,
        pageNum: doc.pageNum
      };

      const updates: any = {
        shapes: previous.shapes,
        past: newPast,
        future: trimHistory([currentEntry, ...doc.future], true)
      };

      const rootProxyUpdates: any = {};
      if (previous.pdfBytes) {
        updates.pdfBytes = previous.pdfBytes;
        rootProxyUpdates.pdfBytes = previous.pdfBytes;
      }
      if (previous.pageNum) {
        updates.pageNum = previous.pageNum;
        rootProxyUpdates.pageNum = previous.pageNum;
      }

      return {
        ...rootProxyUpdates,
        documents: {
          ...state.documents,
          [state.activeTabId]: { ...doc, ...updates }
        },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: {
            ...state.tabMetas,
            [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true }
          }
        } : {})
      };
    }),

  redo: () =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      if (doc.future.length === 0) return {};
      const next = doc.future[0];
      const newFuture = doc.future.slice(1);

      const currentEntry = {
        shapes: JSON.parse(JSON.stringify(doc.shapes)),
        pdfBytes: doc.pdfBytes ?? undefined,
        pageNum: doc.pageNum
      };

      const updates: any = {
        shapes: next.shapes,
        past: trimHistory([...doc.past, currentEntry]),
        future: newFuture
      };

      const rootProxyUpdates: any = {};
      if (next.pdfBytes) {
        updates.pdfBytes = next.pdfBytes;
        rootProxyUpdates.pdfBytes = next.pdfBytes;
      }
      if (next.pageNum) {
        updates.pageNum = next.pageNum;
        rootProxyUpdates.pageNum = next.pageNum;
      }

      return {
        ...rootProxyUpdates,
        documents: {
          ...state.documents,
          [state.activeTabId]: { ...doc, ...updates }
        },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: {
            ...state.tabMetas,
            [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true }
          }
        } : {})
      };
    }),

  insertPagesAt: (afterIndex, numInserted) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];

      const shiftedShapes = doc.shapes.map((s) => {
        if (s.page > afterIndex) {
          return { ...s, page: s.page + numInserted };
        }
        return s;
      });

      const newAssignments: Record<number, string | null> = {};
      const origAssignments = doc.masterPageAssignments || {};

      Object.entries(origAssignments).forEach(([key, val]) => {
        const pNum = Number(key);
        if (pNum > afterIndex) {
          newAssignments[pNum + numInserted] = val;
        } else {
          newAssignments[pNum] = val;
        }
      });

      for (let i = 1; i <= numInserted; i++) {
        newAssignments[afterIndex + i] = null;
      }

      return {
        documents: {
          ...state.documents,
          [state.activeTabId]: {
            ...doc,
            shapes: shiftedShapes,
            masterPageAssignments: newAssignments
          }
        }
      };
    }),

  deletePageAt: (pageIndex) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      const deletedPageNum = pageIndex + 1;

      const updatedShapes = doc.shapes
        .filter((s) => s.page !== deletedPageNum)
        .map((s) => {
          if (s.page > deletedPageNum) {
            return { ...s, page: s.page - 1 };
          }
          return s;
        });

      const newAssignments: Record<number, string | null> = {};
      const origAssignments = doc.masterPageAssignments || {};
      Object.entries(origAssignments).forEach(([key, val]) => {
        const pNum = Number(key);
        if (pNum > deletedPageNum) {
          newAssignments[pNum - 1] = val;
        } else if (pNum < deletedPageNum) {
          newAssignments[pNum] = val;
        }
      });

      return {
        documents: {
          ...state.documents,
          [state.activeTabId]: {
            ...doc,
            shapes: updatedShapes,
            masterPageAssignments: newAssignments
          }
        }
      };
    }),

  // ── Shape Mutations ───────────────────────────────────────────────────────────
  // All operate on root-level `shapes`. Unchanged from pre-refactor store.

  setShapes: (update) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const curr = state.documents[state.activeTabId].shapes;
      return {
        documents: { ...state.documents, [state.activeTabId]: { ...state.documents[state.activeTabId], shapes: typeof update === 'function' ? update(curr) : update } },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: { ...state.tabMetas, [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true } }
        } : {})
      };
    }),

  addShape: (shape) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      return {
        documents: { ...state.documents, [state.activeTabId]: { ...state.documents[state.activeTabId], shapes: [...state.documents[state.activeTabId].shapes, shape] } },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: { ...state.tabMetas, [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true } }
        } : {})
      };
    }),

  updateShape: (id, updates) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      return {
        documents: { ...state.documents, [state.activeTabId]: { ...state.documents[state.activeTabId], shapes: state.documents[state.activeTabId].shapes.map(s => s.id === id ? { ...s, ...updates } : s) } },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: { ...state.tabMetas, [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true } }
        } : {})
      };
    }),

  deleteShape: (id: string) => {
    get().pushToHistory();
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      return {
        documents: { ...state.documents, [state.activeTabId]: { ...doc, shapes: doc.shapes.filter(s => s.id !== id && s.parentId !== id), selectedShapeIds: doc.selectedShapeIds.filter(sid => sid !== id) } },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: { ...state.tabMetas, [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true } }
        } : {})
      };
    });
  },

  deleteShapes: (ids: string[]) => {
    get().pushToHistory();
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      const doc = state.documents[state.activeTabId];
      return {
        documents: { ...state.documents, [state.activeTabId]: { ...doc, shapes: doc.shapes.filter(s => !ids.includes(s.id) && (!s.parentId || !ids.includes(s.parentId))), selectedShapeIds: doc.selectedShapeIds.filter(sid => !ids.includes(sid)) } },
        ...(!state.activeTabId.startsWith('__master__') ? {
          tabMetas: { ...state.tabMetas, [state.activeTabId]: { ...state.tabMetas[state.activeTabId], isDirty: true } }
        } : {})
      };
    });
  },

  setSelectedShapeIds: (ids) =>
    set((state) => {
      if (!state.activeTabId || !state.documents[state.activeTabId]) return {};
      return { documents: { ...state.documents, [state.activeTabId]: { ...state.documents[state.activeTabId], selectedShapeIds: ids } } };
    }),

  bringToFront: () => {
    const state = get();
    const aid = state.activeTabId;
    if (!aid || !state.documents[aid]) return;
    const doc = state.documents[aid];
    const selectedIds = doc.selectedShapeIds || [];
    if (selectedIds.length === 0) return;

    state.pushToHistory();
    set((state) => {
      const doc = state.documents[aid];
      const selectedShapes = doc.shapes.filter(s => selectedIds.includes(s.id) || (s.parentId && selectedIds.includes(s.parentId)));
      const otherShapes = doc.shapes.filter(s => !selectedIds.includes(s.id) && !(s.parentId && selectedIds.includes(s.parentId)));
      const newShapes = [...otherShapes, ...selectedShapes];

      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...doc,
            shapes: newShapes,
          }
        },
        ...(!aid.startsWith('__master__') ? {
          tabMetas: {
            ...state.tabMetas,
            [aid]: { ...state.tabMetas[aid], isDirty: true }
          }
        } : {})
      };
    });
  },

  sendToBack: () => {
    const state = get();
    const aid = state.activeTabId;
    if (!aid || !state.documents[aid]) return;
    const doc = state.documents[aid];
    const selectedIds = doc.selectedShapeIds || [];
    if (selectedIds.length === 0) return;

    state.pushToHistory();
    set((state) => {
      const doc = state.documents[aid];
      const selectedShapes = doc.shapes.filter(s => selectedIds.includes(s.id) || (s.parentId && selectedIds.includes(s.parentId)));
      const otherShapes = doc.shapes.filter(s => !selectedIds.includes(s.id) && !(s.parentId && selectedIds.includes(s.parentId)));
      const newShapes = [...selectedShapes, ...otherShapes];

      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...doc,
            shapes: newShapes,
          }
        },
        ...(!aid.startsWith('__master__') ? {
          tabMetas: {
            ...state.tabMetas,
            [aid]: { ...state.tabMetas[aid], isDirty: true }
          }
        } : {})
      };
    });
  },

  clipboard: [],
  setClipboard: (shapes) => set({ clipboard: shapes }),


  insertPagesInsideSpread: (afterIndex: number, numInserted: number) => set((state) => {
    const aid = state.activeTabId;
    if (!aid || !state.documents[aid]) return {};
    const doc = state.documents[aid];
    
    const leftPage = afterIndex;
    const rightPage = afterIndex + 1;
    
    // Resolve pageWidth
    let pageWidth = 612; // default
    const assignments = doc.masterPageAssignments || {};
    const leftMasterId = assignments[leftPage];
    const rightMasterId = assignments[rightPage];
    const masterPages = doc.masterPages || state.masterPages || [];
    const leftMaster = leftMasterId ? masterPages.find((m: any) => m.id === leftMasterId) : null;
    const rightMaster = rightMasterId ? masterPages.find((m: any) => m.id === rightMasterId) : null;
    if (leftMaster) {
      pageWidth = leftMaster.pageWidth;
    } else if (rightMaster) {
      pageWidth = rightMaster.pageWidth;
    } else if (masterPages.length > 0) {
      pageWidth = masterPages[0].pageWidth;
    }

    const isLineMark = (type: string): boolean => {
      return type === 'mark_section' || type === 'mark_level' || type === 'mark_grid' || type === 'mark_insulation' || type === 'mark_metal_deck';
    };

    const adjustShapeForTargetPage = (
      s: ShapeData,
      sourcePage: number,
      targetPage: number,
    ): ShapeData => {
      const isLine = isLineMark(s.type);
      
      // Calculate visual offset of source on the original spread
      const sourceOffset = sourcePage === rightPage ? pageWidth : 0;
      // Calculate visual offset of target on the new spreads
      const targetOffset = targetPage === (rightPage + numInserted) ? pageWidth : 0;
      
      // The coordinate conversion shift is: sourceOffset - targetOffset
      const shift = sourceOffset - targetOffset;
      
      if (shift === 0) {
        return { ...s, page: targetPage };
      }
      
      const updated: ShapeData = {
        ...s,
        page: targetPage,
        x: s.x + shift
      };
      
      if (s.points) {
        if (isLine) {
          // Relative points don't change
          updated.points = s.points;
        } else {
          // Absolute points get shifted
          updated.points = s.points.map((pt, idx) => idx % 2 === 0 ? pt + shift : pt);
        }
      }
      
      return updated;
    };

    const idMapping: Record<string, string> = {};
    const tempShapes: ShapeData[] = [];
    
    doc.shapes.forEach(s => {
      if (s.page > rightPage) {
        // Shift pages after the target spread
        tempShapes.push({ ...s, page: s.page + numInserted });
      } else if (s.page < leftPage) {
        // Leave pages before the target spread unchanged
        tempShapes.push(s);
      } else {
        // Shape is on the target spread (s.page === leftPage || s.page === rightPage)
        // 1. Calculate boundaries in unified spread space
        let minX = s.x;
        let maxX = s.x + (s.width ?? 0);
        if (s.points && s.points.length > 0) {
          const xs = s.points.filter((_, idx) => idx % 2 === 0);
          const pMinX = Math.min(...xs);
          const pMaxX = Math.max(...xs);
          if (isLineMark(s.type)) {
            minX = s.x + pMinX;
            maxX = s.x + pMaxX;
          } else {
            minX = pMinX;
            maxX = pMaxX;
          }
        }
        
        const offsetX = s.page === rightPage ? pageWidth : 0;
        const visualMinX = minX + offsetX;
        const visualMaxX = maxX + offsetX;
        
        // 2. Classify shape
        if (visualMaxX <= pageWidth) {
          // Entirely on left page
          tempShapes.push(adjustShapeForTargetPage(s, s.page, leftPage));
        } else if (visualMinX >= pageWidth) {
          // Entirely on right page
          tempShapes.push(adjustShapeForTargetPage(s, s.page, rightPage + numInserted));
        } else {
          // Spine crossing: duplicate to both left page and shifted right page
          // Left copy stays on leftPage
          const leftCopy = adjustShapeForTargetPage(s, s.page, leftPage);
          leftCopy.clippedToPage = true;
          tempShapes.push(leftCopy);
          
          // Right copy moves to rightPage + numInserted (with new unique ID)
          const rightCopy = adjustShapeForTargetPage(s, s.page, rightPage + numInserted);
          const newId = Math.random().toString(36).substring(2, 9);
          idMapping[s.id] = newId;
          rightCopy.id = newId;
          rightCopy.clippedToPage = true;
          tempShapes.push(rightCopy);
        }
      }
    });

    // Pass 2: Update parentId for the duplicated children on the shifted right page
    const newShapes = tempShapes.map(s => {
      if (s.parentId && idMapping[s.parentId]) {
        if (s.page === rightPage + numInserted) {
          return { ...s, parentId: idMapping[s.parentId] };
        }
      }
      return s;
    });
    
    // Shift master assignments
    const newAssignments: Record<number, string | null> = {};
    const assignLeftMasterId = doc.masterPageAssignments?.[leftPage] ?? null;
    const assignRightMasterId = doc.masterPageAssignments?.[rightPage] ?? null;
    const spreadMasterId = assignLeftMasterId ?? assignRightMasterId;

    for (const [pStr, mId] of Object.entries(doc.masterPageAssignments || {})) {
      const pNum = parseInt(pStr);
      if (pNum > afterIndex) newAssignments[pNum + numInserted] = mId;
      else newAssignments[pNum] = mId;
    }

    if (spreadMasterId) {
      for (let i = 1; i <= numInserted; i++) {
        newAssignments[afterIndex + i] = spreadMasterId;
      }
    }

    // Show a notification about Master Pages resetting if applicable
    setTimeout(() => {
      useStore.getState().addNotification('Master pages may have shifted due to spread insertion.', 'warning');
    }, 100);

    return {
      documents: { ...state.documents, [aid]: { ...doc, shapes: newShapes, masterPageAssignments: newAssignments } }
    };
  }),


  // ── Master Page System ────────────────────────────────────────────────────

  masterPages: [],

  addMasterPage: (name, pageWidth, pageHeight, isSpread) => {
    const id = `master-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const masterTabId = `__master__${id}`;
    set((state) => {
      const docId = (state.editorMode === 'master' ? state.previousActiveTabId : state.activeTabId);
      const newMaster = { id, name, backgroundPdfBytes: null, backgroundPageNum: 1, shapes: [], pageWidth, pageHeight, isSpread, guides: [] };

      const updatedDocuments = {
        ...state.documents,
        [masterTabId]: {
          ...DEFAULT_DOC_STATE,
          pdfBytes: null,
          pageNum: 1,
          numPages: 1,
          shapes: [],
          guides: [],
          scale: 0.75,
          panOffset: { x: 40, y: 60 },
          isSpread: isSpread,
        },
      };

      const nextMasterPages = [...state.masterPages, newMaster];

      if (docId && updatedDocuments[docId]) {
        updatedDocuments[docId] = {
          ...updatedDocuments[docId],
          masterPages: [...(updatedDocuments[docId].masterPages || []), newMaster],
        };
      }

      return {
        masterPages: nextMasterPages,
        documents: updatedDocuments,
      };
    });
    return id;
  },

  updateMasterPage: (id, updates) =>
    set((state) => {
      const masterTabId = `__master__${id}`;
      const doc = state.documents[masterTabId];
      const updatedDoc = doc
        ? {
            ...doc,
            ...(updates.shapes !== undefined ? { shapes: updates.shapes } : {}),
            ...(updates.backgroundPdfBytes !== undefined ? { pdfBytes: updates.backgroundPdfBytes } : {}),
            ...(updates.backgroundPageNum !== undefined ? { pageNum: updates.backgroundPageNum } : {}),
            ...(updates.isSpread !== undefined ? { isSpread: updates.isSpread } : {}),
            ...(updates.guides !== undefined ? { guides: updates.guides } : {}),
          }
        : null;

      const docId = (state.editorMode === 'master' ? state.previousActiveTabId : state.activeTabId);
      const nextMasterPages = state.masterPages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      );

      const updatedDocuments = { ...state.documents };
      if (updatedDoc) {
        updatedDocuments[masterTabId] = updatedDoc;
      }

      if (docId && updatedDocuments[docId]) {
        updatedDocuments[docId] = {
          ...updatedDocuments[docId],
          masterPages: updatedDocuments[docId].masterPages?.map((m) =>
            m.id === id ? { ...m, ...updates } : m
          ) || [],
        };
      }

      return {
        masterPages: nextMasterPages,
        documents: updatedDocuments,
      };
    }),

  deleteMasterPage: (id) =>
    set((state) => {
      const updatedDocuments = { ...state.documents };
      delete updatedDocuments[`__master__${id}`];

      const docId = (state.editorMode === 'master' ? state.previousActiveTabId : state.activeTabId);
      if (docId && updatedDocuments[docId]) {
        updatedDocuments[docId] = {
          ...updatedDocuments[docId],
          masterPages: updatedDocuments[docId].masterPages?.filter((m) => m.id !== id) || [],
        };
      }

      for (const tabId of Object.keys(updatedDocuments)) {
        if (tabId.startsWith('__master__')) continue;
        const doc = updatedDocuments[tabId];
        const assignments = { ...(doc.masterPageAssignments || {}) };
        let changed = false;
        for (const pageKey of Object.keys(assignments)) {
          if (assignments[Number(pageKey)] === id) {
            assignments[Number(pageKey)] = null;
            changed = true;
          }
        }
        if (changed) {
          updatedDocuments[tabId] = { ...doc, masterPageAssignments: assignments };
        }
      }

      const remainingMasters = state.masterPages.filter((m) => m.id !== id);

      let nextActiveMasterPageId = state.activeMasterPageId;
      let nextActiveTabId = state.activeTabId;

      if (state.activeMasterPageId === id) {
        if (remainingMasters.length > 0) {
          nextActiveMasterPageId = remainingMasters[0].id;
          nextActiveTabId = `__master__${remainingMasters[0].id}`;
        } else {
          nextActiveMasterPageId = null;
          nextActiveTabId = null;
        }
      }

      return {
        masterPages: remainingMasters,
        documents: updatedDocuments,
        activeMasterPageId: nextActiveMasterPageId,
        activeTabId: nextActiveTabId,
      };
    }),

  setMasterPageAssignment: (tabId, pageNum, masterId) =>
    set((state) => {
      if (!state.documents[tabId]) return {};
      const doc = state.documents[tabId];
      return {
        documents: {
          ...state.documents,
          [tabId]: {
            ...doc,
            masterPageAssignments: {
              ...(doc.masterPageAssignments || {}),
              [pageNum]: masterId,
            },
          },
        },
      };
    }),

  // ── Editor Mode ────────────────────────────────────────────────────────────

  editorMode: 'document' as 'document' | 'master',
  setEditorMode: (mode) => set((state) => {
    // Exiting master mode: sync shapes back to the masterPages list
    if (mode === 'document' && state.editorMode === 'master') {
      const updatedMasterPages = state.masterPages.map(m => {
        const masterTabId = `__master__${m.id}`;
        const doc = state.documents[masterTabId];
        if (doc) {
          return {
            ...m,
            shapes: doc.shapes,
            backgroundPdfBytes: doc.pdfBytes,
            backgroundPageNum: doc.pageNum,
            guides: doc.guides || [],
          };
        }
        return m;
      });
      const restoredTabId = state.previousActiveTabId && !state.previousActiveTabId.startsWith('__master__')
        ? state.previousActiveTabId
        : null;
      const restoredTool = state.documentTool || 'select';

      const updatedDocuments = { ...state.documents };
      if (restoredTabId && updatedDocuments[restoredTabId]) {
        updatedDocuments[restoredTabId] = {
          ...updatedDocuments[restoredTabId],
          masterPages: updatedMasterPages,
        };
      }

      return { 
        editorMode: mode, 
        masterPages: updatedMasterPages,
        activeTabId: restoredTabId,
        activeTool: restoredTool,
        masterTool: state.activeTool,
        documents: updatedDocuments,
        guides: restoredTabId && updatedDocuments[restoredTabId] ? updatedDocuments[restoredTabId].guides || [] : [],
      };
    }

    // Entering master mode: swap to master tab & tool
    if (mode === 'master' && state.editorMode === 'document') {
      const masterTabId = state.activeMasterPageId ? `__master__${state.activeMasterPageId}` : null;
      const nextTool = state.masterTool || 'select';
      return {
        editorMode: mode,
        previousActiveTabId: state.activeTabId && !state.activeTabId.startsWith('__master__') ? state.activeTabId : null,
        documentTool: state.activeTool,
        activeTool: nextTool,
        activeTabId: masterTabId,
        guides: masterTabId && state.documents[masterTabId] ? state.documents[masterTabId].guides || [] : [],
      };
    }

    return { editorMode: mode };
  }),

  activeMasterPageId: null,
  setActiveMasterPageId: (id) => set((state) => {
    const updates: any = { activeMasterPageId: id };
    if (state.editorMode === 'master' && id) {
      const masterTabId = `__master__${id}`;
      updates.activeTabId = masterTabId;
      const masterDoc = state.documents[masterTabId];
      updates.guides = masterDoc ? masterDoc.guides || [] : [];
    }
    return updates;
  }),

  loadDocumentData: (tabId, shapes, spreadConfig, masterPages, masterPageAssignments, bleedConfig, guides) =>
    set((state) => {
      const targetTabId = tabId || state.activeTabId;
      if (!targetTabId || !state.documents[targetTabId]) return {};
      const doc = state.documents[targetTabId];

      const updatedDocuments = { ...state.documents };
      const updatedDoc: DocumentState = {
        ...doc,
        shapes,
        isSpread: spreadConfig?.isSpread ?? false,
        // hasFrontCover: new key name. Fallback to legacy 'hasCoverPage' for files saved before this fix.
        hasFrontCover: spreadConfig?.hasFrontCover ?? (spreadConfig as any)?.hasCoverPage ?? false,
        // hasBackCover: was never saved in old files — defaults to false, correctly read from new saves.
        hasBackCover: spreadConfig?.hasBackCover ?? false,
        masterPages: masterPages || [],
        masterPageAssignments: masterPageAssignments || {},
        bleedOffset: bleedConfig?.bleedOffset ?? 0,
        showBleedGuides: bleedConfig?.showBleedGuides ?? true,
        colorSpaceMode: bleedConfig?.colorSpaceMode ?? 'srgb',
        guides: guides || [],
      };
      updatedDocuments[targetTabId] = updatedDoc;

      // Also instantiate/update virtual documents for master pages in documents state
      if (masterPages) {
        masterPages.forEach((m) => {
          const masterTabId = `__master__${m.id}`;
          updatedDocuments[masterTabId] = {
            ...DEFAULT_DOC_STATE,
            pdfBytes: m.backgroundPdfBytes || null,
            pageNum: m.backgroundPageNum || 1,
            numPages: 1,
            shapes: m.shapes || [],
            scale: 0.75,
            panOffset: { x: 40, y: 60 },
            isSpread: m.isSpread || false,
            guides: m.guides || [],
          };
        });
      }

      return {
        documents: updatedDocuments,
        masterPages: masterPages || [],
        activeMasterPageId: masterPages && masterPages.length > 0 ? masterPages[0].id : null,
        ...(targetTabId === state.activeTabId ? { guides: guides || [] } : {}),
      };
    }),

  setBleedOffset: (val) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...state.documents[aid],
            bleedOffset: val,
          },
        },
      };
    }),

  setShowBleedGuides: (val) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...state.documents[aid],
            showBleedGuides: val,
          },
        },
      };
    }),

  setColorSpaceMode: (val) =>
    set((state) => {
      const aid = state.activeTabId;
      if (!aid || !state.documents[aid]) return {};
      return {
        documents: {
          ...state.documents,
          [aid]: {
            ...state.documents[aid],
            colorSpaceMode: val,
          },
        },
      };
    }),

  setSavingStatus: (tabId, status) =>
    set((state) => {
      const updated = { ...state.savingStatus };
      if (status) {
        updated[tabId] = status;
      } else {
        delete updated[tabId];
      }
      return { savingStatus: updated };
    }),

  addNotification: (message, type = 'info') =>
    set((state) => ({
      notifications: [
        ...state.notifications,
        { id: Math.random().toString(36).substring(2, 9), message, type },
      ],
    })),

  removeNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),
}));

if (typeof window !== 'undefined') {
  (window as any).useStore = useStore;
}




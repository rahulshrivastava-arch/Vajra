// ─────────────────────────────────────────────────────────────────────────────
// types.ts
// Single source of truth for all Zustand store types.
// Extracted to break the circular import chain that Phase 3 (DocumentViewer)
// would create if types lived directly inside useStore.ts.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Master Page ─────────────────────────────────────────────────────────────
// A global background template (similar to Adobe InDesign Master Pages).
// Stored globally in the Zustand store — shared across all open tabs.

export interface MasterPage {
  /** Unique identifier, e.g. "master-a". */
  id: string;
  /** Display name shown in the UI, e.g. "A-Master". */
  name: string;
  /**
   * Optional raw PDF bytes uploaded as the static background for this master.
   * Null = no background PDF; use a plain white canvas.
   */
  backgroundPdfBytes: Uint8Array | null;
  /** Which page of the background PDF to use as the background (1-indexed). */
  backgroundPageNum: number;
  /**
   * Shapes drawn on this master page using the standard drawing tools.
   * These may contain smart text variables like {{Page Number}}.
   */
  shapes: ShapeData[];
  /** Width of a single page in points (e.g., 612 for letter, 842 for A3 landscape). */
  pageWidth: number;
  /** Height of a single page in points (e.g., 792 for letter, 595 for A3 landscape). */
  pageHeight: number;
  /** True if this is a 2-page spread master template. */
  isSpread: boolean;
  /** Guidelines on this master page */
  guides?: Guide[];
}

// ─── Guide Type ──────────────────────────────────────────────────────────────

export type Guide = {
  id: string;
  orientation: 'horizontal' | 'vertical';
  position: number;
  origin?: 'left' | 'right' | 'top' | 'bottom' | 'left-spread' | 'right-spread';
};

// ─── Arrow Head Type ─────────────────────────────────────────────────────────

export type ArrowHeadType = 'arrow' | 'circle' | 'greater_than' | 'none';

// ─── Tool Types ───────────────────────────────────────────────────────────────

export type ToolType =
  | 'select'
  | 'pan'
  | 'line'
  | 'rect'
  | 'circle'
  | 'freehand'
  | 'text'
  | 'measure_length'
  | 'measure_area'
  | 'image'
  | 'cloud'
  | 'arrow'
  | 'stamp'
  | 'callout'
  | 'polyline'
  | 'polygon'
  | 'spline'
  | 'arc'
  | 'highlight'
  | 'brush'
  | 'table'
  // ── Architectural Marks ──────────────────────────────────────────────────
  | 'mark_section'   // section cut line with eye head
  | 'mark_level'     // horizontal datum line with bulb + labels
  | 'mark_grid'      // grid bubble line
  | 'mark_elevation' // diamond stamp with directional arrows
  | 'mark_single_elevation' // circle with one triangular tail
  | 'mark_hat_channel'      // trapezoidal hat channel profile
  | 'mark_masonry_ties'     // masonry tie assembly symbol
  | 'mark_t_section'       // T-shape steel section profile
  | 'mark_cfmf_stud'       // Cold-formed metal framing stud profile
  | 'mark_break_line'      // break line with optional masking region
  | 'mark_callout'   // dashed rect with corner bubble tag
  | 'mark_block'     // rectangle with an X through it
  | 'mark_w_section' // W-shape steel section profile
  | 'mark_insulation'// Architectural insulation batting line
  | 'mark_door'       // Single door marker
  | 'mark_double_door'// Double door marker
  | 'mark_sealant'    // Sealant with backer rod marker
  | 'mark_angle'
  | 'mark_bolt'       // Bolt/Screw marker
  | 'mark_thermal_spacer' // Thermal spacer marker
  | 'mark_metal_deck'   // Metal deck line marker
  // ── Layout ──────────────────────────────────────────────────────────────
  | 'content_box';   // InDesign-style frame/asset dual-mode layout box

// ─── Table Types ──────────────────────────────────────────────────────────────

export interface TableCell {
  text: string;
  fillColor?: string;
  colSpan?: number;
  rowSpan?: number;
  isMerged?: boolean; // True if it's hidden under a merged cell
  wrapText?: boolean;
  imageUrl?: string;
  formula?: string; // e.g., "=A1+B2"
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  fontFamily?: string;
  fontSize?: number;
  strokeColor?: string;
  isBold?: boolean;
  isItalic?: boolean;
  isUnderline?: boolean;
  isStrike?: boolean;
}

export interface TableData {
  rows: number;
  cols: number;
  rowHeights: number[]; // Array of heights for each row
  colWidths: number[];  // Array of widths for each column
  cells: Record<string, TableCell>; // Keyed by "row_col", e.g., "0_0", "1_2"
  borderThickness: number;
  selectedCellIds?: string[]; // Array of selected "row_col"
  selectedLine?: { type: 'row' | 'col'; index: number } | null;
  colLineThicknesses?: number[];
  rowLineThicknesses?: number[];
}

// ─── Shape Data ───────────────────────────────────────────────────────────────

export interface ShapeData {
  id: string;
  type: ToolType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
  points?: number[];

  // Ledger specific tracking
  page: number;
  author: string;
  date: string;
  comments?: string;

  // Advanced Math/Geometry
  dash?: number[];
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  isBold?: boolean;
  isItalic?: boolean;
  isUnderline?: boolean;
  isStrike?: boolean;
  textAlign?: 'left' | 'center' | 'right';
  parentId?: string;

  // OS-Snipping Integration
  imageUrl?: string;
  cropX?: number;
  cropY?: number;

  // Stamp Integration
  stampText?: string;

  // Transform
  rotation?: number;

  // Architectural Measurements
  measurementSystem?: 'imperial' | 'metric';
  measurementScale?: number;

  // Revit Hatch Pattern Engine Storage
  fillPatternId?: string;
  fillPatternScale?: number;
  fillPatternStrokeWidth?: number;

  // Cloud Mode Selector
  cloudMode?: 'rect' | 'polygon' | 'circle';
  
  // Polyline / Spline loop closure
  closed?: boolean;
  // Spline / Arc specific
  showArrowHead?: boolean; // Kept for backwards compatibility
  arrowHeadType?: ArrowHeadType;
  arrowHeadSize?: number;
  arrowHeadAngle?: number;
  arrowHeadFilled?: boolean;

  // ── Architectural marks sub-label storage ────────────────────────────────
  // Keyed by marker type:
  //   mark_section:   { top: viewNum, bottom: sheetNum }
  //   mark_level:     { name: floorName, elevation: elevValue }
  //   mark_grid:      { label: gridLetter }
  //   mark_elevation: { label: elevLabel }
  //   mark_callout:   { top: viewNum, bottom: sheetNum }
  markerData?: Record<string, string>;

  // Minimum rendered dimension (px) — enforced by the Transformer boundBoxFunc
  // so text never overflows the marker body.
  minWidth?: number;
  minHeight?: number;

  // Table specific data
  tableData?: TableData;

  // ── Content Box (InDesign-style frame + asset) ────────────────────────────
  // contentMode: which sub-element is currently "selected" for interaction.
  //   'frame'   → the outer clipping rect (blue handles, resize crops the window)
  //   'content' → the inner asset (orange handles, resize/pan moves the image)
  // When undefined the box is in frame mode (the default).
  contentMode?: 'frame' | 'content';
  // URL of the image dropped inside the frame (data-URL or object URL).
  assetUrl?: string;
  // The image's own position and scale relative to the frame's top-left corner.
  // All values are in the same canvas-unit space as x/y/width/height.
  assetTransform?: {
    x: number;      // left edge of the image relative to the frame
    y: number;      // top edge of the image relative to the frame
    width: number;  // rendered width of the image (can exceed frame width → clipped)
    height: number; // rendered height of the image (can exceed frame height → clipped)
  };

  // Clipping
  clippedToPage?: boolean;
}

// ─── Per-Document State ───────────────────────────────────────────────────────
//
// The complete, isolated state for a single open document/tab.
// Every entry in `documents: Record<tabId, DocumentState>` is this shape.
//
// Design rule (Phase 1 → 4):
//   - Serializable fields only. `pdfDoc` (PDFDocumentProxy) is NEVER stored here.
//   - `pdfBytes` IS stored here (per architectural decision) so TopCommandCenter
//     can access raw bytes globally for save/export without a ref tunnel into
//     DocumentViewer. Large Uint8Array blobs are an accepted trade-off.

export interface HistoryEntry {
  shapes: ShapeData[];
  pdfBytes?: Uint8Array;
  pageNum?: number;
}

export interface DocumentState {
  /**
   * Raw PDF bytes for this document.
   * Stored in Zustand so TopCommandCenter can access them via
   * `documents[activeTabId].pdfBytes` without imperative refs.
   * Set by `setPdfBytes()` when a PDF is loaded; `null` for blank/new tabs.
   */
  pdfBytes: Uint8Array | null;

  /**
   * Current page number (1-indexed).
   * In Phase 1/2, this is also held as local React state in App.tsx.
   * In Phase 3, DocumentViewer reads/writes this from the store directly.
   * Synced to `documents[activeTabId]` on tab switch.
   */
  pageNum: number;

  /** Markup shapes drawn on this document. */
  shapes: ShapeData[];

  /**
   * Undo history — each entry is a deep-cloned snapshot of `shapes` (and optionally `pdfBytes` for page insertions/deletions)
   * captured by `pushToHistory()` before a mutation.
   */
  past: HistoryEntry[];

  /** Redo future stack. */
  future: HistoryEntry[];

  /** Currently selected shape IDs on this document. */
  selectedShapeIds: string[];

  /**
   * Current viewport zoom scale (1.0 = 100%).
   * Per-document so each tab remembers its own zoom level.
   */
  scale: number;

  /**
   * Physical-to-pixel calibration factor (points-per-inch).
   * Auto-detected from PDF page dimensions on file load via the
   * architectural aspect-ratio detection logic in App.tsx / DocumentViewer.
   */
  scaleCalibration: number;

  /** X/Y panning offset for the infinite canvas. */
  panOffset: { x: number; y: number };

  /** Layer visibility toggles for the three rendering layers. */
  layersVisible: {
    base: boolean;    // PDF raster base canvas
    active: boolean;  // Markup shapes (Konva layer)
    chest: boolean;   // Image/snip overlays
  };

  /**
   * Total number of pages in the loaded PDF.
   * Set by DocumentViewer when the PDF document proxy is first resolved.
   * 0 for blank/new tabs that haven't loaded a PDF yet.
   */
  numPages: number;

  // ── Spread Layout ─────────────────────────────────────────────────────────

  /**
   * When true the canvas renders two pages side-by-side (book spread).
   * The left page is always an odd page number, right is left+1.
   * Shapes coordinate space is unified: left page occupies x in [0, pageWidth),
   * right page occupies x in [pageWidth, pageWidth*2). The spine is at x=pageWidth.
   */
  isSpread: boolean;

  /**
   * Active spread index (0-indexed). Spread 0 = pages 1+2, spread 1 = pages 3+4, etc.
   * The left/right page numbers are: leftPage = spreadIndex*2+1, rightPage = leftPage+1.
   */
  activeSpreadIndex: number;

  /**
   * The active sub-page within the spread (1 = left, 2 = right).
   * Updated by cursor position tracking in DocumentViewer.
   * Used to display the accurate page number in the bottom status bar.
   */
  activeSide: 1 | 2;

  /**
   * When true, page 1 is a solo "cover" page.
   */
  hasFrontCover: boolean;

  /**
   * When true, the last page is a solo "back cover" page.
   */
  hasBackCover: boolean;

  // ── Master Page Assignments ───────────────────────────────────────────────

  /**
   * Maps document page numbers (1-indexed) to a master page ID.
   * A null value means "no master" for that page.
   * Pages not present in this map also have no master.
   * Example: { 1: "master-a", 2: "master-a", 3: "master-b", 4: null }
   */
  masterPageAssignments: Record<number, string | null>;
  /** Exclusive master pages list for this document. */
  masterPages?: MasterPage[];
  /** Bleed offset in inches (e.g. 0, 0.125, 0.25, 0.5) */
  bleedOffset: number;
  /** True to display bleed guidelines on screen */
  showBleedGuides: boolean;
  /** Color space mode for exported PDF: sRGB or CMYK */
  colorSpaceMode: 'srgb' | 'cmyk';
  /** Guidelines for this document */
  guides: Guide[];
  pageWidth?: number;
  pageHeight?: number;
}

// ─── Tab Metadata ─────────────────────────────────────────────────────────────
//
// Lightweight display-level data about a tab, stored separately from
// DocumentState so the tab bar can render without touching the heavy doc state.

export interface TabMeta {
  /** Matches the key in `documents{}`. Duplicated here for convenience. */
  id: string;

  /**
   * Display label shown in the tab pill.
   * Typically the filename (e.g. "FloorPlan_Level1.pdf") or "Untitled".
   */
  label: string;

  /**
   * True when the document has unsaved changes.
   * Displayed as a `*` indicator in the tab pill.
   */
  isDirty: boolean;

  /**
   * The absolute path to the file on disk. Used for saving.
   * Will be undefined for new or unsaved documents.
   */
  filePath?: string;
}

// ─── Full Zustand Store Interface ─────────────────────────────────────────────

export interface MarkupState {
  pdfBytes: Uint8Array | null;
  scaleCalibration?: number;
  pageNum: number;
  numPages: number;
  //  Tab Registry ────────────────────────────────────────────────────────────

  /**
   * Normalized dictionary of all open documents, keyed by tabId.
   * This is the canonical data store for all per-document state.
   *
   * IMPORTANT: During Phase 1/2, the root-level proxy fields (shapes, scale,
   * etc.) are the LIVE copy. `documents[activeTabId]` is synced from root
   * at tab-switch boundaries by `saveRootToActiveDoc()`. From Phase 3
   * onward, DocumentViewer reads from here directly.
   */
  documents: Record<string, DocumentState>;

  /** Display metadata for each tab (label, dirty flag). Keyed by tabId. */
  tabMetas: Record<string, TabMeta>;

  /**
   * The currently active tab ID.
   * Null only when no tabs are open (edge case: user closes last tab).
   */
  activeTabId: string | null;

  /**
   * Open a new tab and immediately switch to it.
   * Saves current root-proxy state to the old tab before switching.
   * @param tabId   Unique ID for the new tab (caller generates this).
   * @param meta    Display metadata for the new tab.
   * @param initialState  Optional partial DocumentState to seed the new tab
   *                      (e.g. `{ pdfBytes, pageNum: 1 }`).
   */
  openTab: (
    tabId: string,
    meta: Omit<TabMeta, 'id'>,
    initialState?: Partial<DocumentState>
  ) => void;

  /**
   * Close an existing tab and free its DocumentState.
   * If the closed tab was active, automatically switches to the nearest
   * remaining tab (rightmost remaining). If no tabs remain, activeTabId = null.
   */
  closeTab: (tabId: string) => void;

  /**
   * Switch to an existing tab.
   * Saves current root-proxy state to the old tab first.
   * No-op if `tabId === activeTabId` or the tab doesn't exist.
   */
  setActiveTab: (tabId: string) => void;

  /**
   * Update display metadata for a tab (label, isDirty, etc.).
   * Used by file-load logic to set the filename, and by mutation actions
   * (Phase 3+) to mark tabs dirty.
   */
  updateTabMeta: (tabId: string, updates: Partial<Omit<TabMeta, 'id'>>) => void;

  // ── Global Tool State ────────────────────────────────────────────────────────
  // These settings are SHARED across all tabs, like Bluebeam's toolbar.
  // Switching tabs does NOT reset stroke color, active tool, etc.

  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;

  strokeColor: string;
  setStrokeColor: (color: string) => void;

  strokeWidth: number;
  setStrokeWidth: (width: number) => void;

  fillColor: string;
  setFillColor: (color: string) => void;

  activeDash: number[] | undefined;
  setActiveDash: (dash?: number[]) => void;

  activeStamp: string;
  setActiveStamp: (stamp: string) => void;

  polygonSides: number;
  setPolygonSides: (sides: number) => void;

  cloudMode: 'polygon' | 'rect' | 'circle';
  setCloudMode: (mode: 'polygon' | 'rect' | 'circle') => void;

  showArrowHead: boolean;
  setShowArrowHead: (show: boolean) => void;

  arrowHeadType: ArrowHeadType;
  setArrowHeadType: (type: ArrowHeadType) => void;

  arrowHeadSize: number;
  setArrowHeadSize: (size: number) => void;

  arrowHeadAngle: number;
  setArrowHeadAngle: (angle: number) => void;

  arrowHeadFilled: boolean;
  setArrowHeadFilled: (filled: boolean) => void;

  addLabelMode: boolean;
  setAddLabelMode: (enabled: boolean) => void;

  /** Global custom stamp/image asset library (not per-document). */
  customAssets: string[];
  addCustomAsset: (url: string) => void;
  removeCustomAsset: (index: number) => void;

  /** Global custom stamp library specifically for user signatures or seals. */
  customStamps: string[];
  addCustomStamp: (url: string) => void;
  removeCustomStamp: (index: number) => void;

  isScaleMode: boolean;
  setIsScaleMode: (val: boolean) => void;

  /** Global state for pointer-based asset dragging to bypass WebView DnD quirks. */
  draggingAssetIndex: number | null;
  setDraggingAssetIndex: (index: number | null) => void;

  /** State to hold user input for table dimensions before placing a table. */
  pendingTableDimensions: { rows: number; cols: number } | null;
  setPendingTableDimensions: (dims: { rows: number; cols: number } | null) => void;

  brushThickness: number;
  setBrushThickness: (thickness: number) => void;

  // ── Guide / Snap System ──────────────────────────────────────────────────────
  /** List of guideline objects rendered on the infinite canvas. */
  guides: Guide[];
  addGuide: (guide: Guide) => void;
  updateGuide: (id: string, position: number, extra?: Partial<Guide>) => void;
  removeGuide: (id: string) => void;

  /** Controls guide-line visibility (the cyan lines). */
  showGuides: boolean;
  toggleShowGuides: () => void;

  /** Controls whether dragging shapes snaps to guide-line positions. */
  snapEnabled: boolean;
  toggleSnap: () => void;

  /** Controls whether drawing snaps to CAD vector geometry. */
  vectorSnapEnabled: boolean;
  toggleVectorSnap: () => void;

  /** When true, shapes snap to the horizontal and vertical centre lines of each page. */
  centerSnapEnabled: boolean;
  toggleCenterSnap: () => void;

  /** Currently selected guide ID (null = none selected). */
  selectedGuideId: string | null;
  setSelectedGuideId: (id: string | null) => void;

  /** When true, clicking guides selects them; when false, guides are non-interactive. */
  guideSelectionEnabled: boolean;
  toggleGuideSelection: () => void;

  /** Screen-pixel distance within which shapes snap to guide lines (default 10). */
  snapSensitivity: number;
  setSnapSensitivity: (val: number) => void;

  // ── Per-Document Setters (always operate on the active tab) ─────────────────

  setPageDimensions: (width: number, height: number) => void;
  setScale: (update: number | ((prev: number) => number)) => void;
  setScaleCalibration: (val: number) => void;
  setLayerVisible: (layer: 'base' | 'active' | 'chest', visible: boolean) => void;
  setPanOffset: (update: { x: number; y: number } | ((prev: { x: number; y: number }) => { x: number; y: number })) => void;

  /** Atomically update scale and panOffset in one Zustand set to prevent intermediate renders. */
  zoomTo: (newScale: number, newPanOffset: { x: number; y: number }) => void;

  /**
   * Store raw PDF bytes for the active tab.
   * Writes to BOTH the root proxy (`pdfBytes`) AND `documents[activeTabId].pdfBytes`
   * so the save/export pipeline in TopCommandCenter always reads correct data
   * without needing a tab switch to flush.
   */
  setPdfBytes: (bytes: Uint8Array | null) => void;

  /**
   * Update current page number for the active tab.
   * Mirrors to `documents[activeTabId].pageNum` immediately (same flush
   * strategy as `setPdfBytes`).
   */
  setPageNum: (page: number) => void;

  /**
   * Update the total page count for the active tab.
   * Called by DocumentViewer when the PDFDocumentProxy resolves.
   * Same dual-write strategy as setPdfBytes/setPageNum.
   */
  setNumPages: (n: number) => void;

  // ── Spread Layout Setters ────────────────────────────────────────────────

  /** Toggle spread mode on/off for the active tab. */
  setIsSpread: (val: boolean) => void;

  /** Set the active spread index (0-based). Updates pageNum to the left page of that spread. */
  setActiveSpreadIndex: (idx: number) => void;

  /** Set which side (1=left, 2=right) of the spread the cursor is on. */
  setActiveSide: (side: 1 | 2) => void;

  /** Toggle front cover solo page mode. */
  setHasFrontCover: (val: boolean) => void;

  /** Toggle back cover solo page mode. */
  setHasBackCover: (val: boolean) => void;

  // ── History & Shape Mutations (operate on the active tab) ───────────────────

  /** Snapshot current shapes into the undo stack. Call before any mutation. */
  pushToHistory: () => void;
  pushPageChangeToHistory: () => void;
  undo: () => void;
  redo: () => void;
  insertPagesAt: (afterIndex: number, numInserted: number) => void;
  insertPagesInsideSpread: (afterIndex: number, numInserted: number) => void;
  deletePageAt: (pageIndex: number) => void;

  setShapes: (shapes: ShapeData[] | ((prev: ShapeData[]) => ShapeData[])) => void;
  addShape: (shape: ShapeData) => void;
  updateShape: (id: string, updates: Partial<ShapeData>) => void;

  /**
   * Delete a single shape by ID.
   * Also deletes any child shapes with a matching `parentId` (e.g. callouts).
   * Automatically calls `pushToHistory()` before mutation.
   */
  deleteShape: (id: string) => void;

  /**
   * Delete multiple shapes by ID array.
   * Also removes children of any deleted parent (callout orphan prevention).
   * Automatically calls `pushToHistory()` before mutation.
   */
  deleteShapes: (ids: string[]) => void;

  setSelectedShapeIds: (ids: string[]) => void;
  bringToFront: () => void;
  sendToBack: () => void;

  /** Global clipboard for copied shapes */
  clipboard: ShapeData[];
  setClipboard: (shapes: ShapeData[]) => void;

  // ── Master Page System ─────────────────────────────────────────────────────

  /**
   * Global registry of all Master Pages.
   * Shared across all open tabs — a master can be applied to any document.
   */
  masterPages: MasterPage[];

  /** Create a new Master Page. Returns the new master's id. */
  addMasterPage: (name: string, pageWidth: number, pageHeight: number, isSpread: boolean) => string;

  /** Update fields on an existing Master Page (e.g. upload a background, add shapes). */
  updateMasterPage: (id: string, updates: Partial<Omit<MasterPage, 'id'>>) => void;

  /** Delete a Master Page by ID. Any documents that had it assigned will lose the assignment. */
  deleteMasterPage: (id: string) => void;

  /**
   * Assign (or unassign) a master page to a specific document page.
   * @param tabId    The document tab to update.
   * @param pageNum  The page number (1-indexed) within that document.
   * @param masterId The master page ID to assign, or null to remove the assignment.
   */
  setMasterPageAssignment: (tabId: string, pageNum: number, masterId: string | null) => void;

  // ── Editor Mode ────────────────────────────────────────────────────────────

  /**
   * Global editor mode.
   * - 'document': Normal document editing (the active tab is the focus).
   * - 'master':   Master Page editing mode (MasterPageEditor is shown instead of DocumentViewer).
   */
  editorMode: 'document' | 'master';
  setEditorMode: (mode: 'document' | 'master') => void;

  /**
   * The ID of the Master Page currently being edited.
   * Only relevant when editorMode === 'master'.
   */
  activeMasterPageId: string | null;
  setActiveMasterPageId: (id: string | null) => void;

  loadDocumentData: (
    tabId: string,
    shapes: ShapeData[],
    spreadConfig: { isSpread: boolean; hasFrontCover: boolean; hasBackCover: boolean } | null,
    masterPages: MasterPage[] | null,
    masterPageAssignments: Record<number, string | null> | null,
    bleedConfig?: { bleedOffset: number; showBleedGuides: boolean; colorSpaceMode: 'srgb' | 'cmyk' } | null,
    guides?: Guide[]
  ) => void;

  documentTool?: ToolType;
  masterTool?: ToolType;
  previousActiveTabId?: string | null;

  // ── Bleed & CMYK Exporter Actions ──
  setBleedOffset: (val: number) => void;
  setShowBleedGuides: (val: boolean) => void;
  setColorSpaceMode: (val: 'srgb' | 'cmyk') => void;

  // ── Save Progress Tracking ──
  savingStatus: Record<string, { progress: number; mode: 'save' | 'export' | null }>;
  setSavingStatus: (tabId: string, status: { progress: number; mode: 'save' | 'export' | null } | null) => void;

  // ── Notifications ──
  notifications: { id: string; message: string; type: 'info' | 'warning' | 'error' }[];
  addNotification: (message: string, type?: 'info' | 'warning' | 'error') => void;
  removeNotification: (id: string) => void;
}

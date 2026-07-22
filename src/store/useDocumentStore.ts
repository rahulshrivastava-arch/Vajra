// ─────────────────────────────────────────────────────────────────────────────
// useDocumentStore.ts
//
// Thin, per-tab selector hooks built on top of the main Zustand store.
//
// Design:
//   - Each hook accepts a `tabId` and returns only the slice of the store that
//     belongs to that specific document, using primitive equality comparison so
//     the subscriber re-renders only when *its own* data changes.
//   - Keeps DocumentViewer decoupled from the root-level proxy fields while
//     still using the same shared store instance.
//
// Usage:
//   const pdfBytes = usePdfBytes(tabId);
// ─────────────────────────────────────────────────────────────────────────────

import { useStore } from './useStore';

/**
 * Returns the raw PDF bytes for the given tab, or null if none are loaded.
 *
 * DocumentViewer uses this as the trigger to derive its local `pdfDoc` state:
 * whenever pdfBytes changes (new file opened, pristine attachment extracted,
 * page inserted/deleted), DocumentViewer re-loads the PDF.js document.
 *
 * Reference equality is used: a new Uint8Array object triggers a re-render.
 */
export function usePdfBytes(tabId: string): Uint8Array | null {
  return useStore((s) => s.documents[tabId]?.pdfBytes ?? null);
}

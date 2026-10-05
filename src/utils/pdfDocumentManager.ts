// Shared, ref-counted PDF.js document cache.
//
// Several components (DocumentViewer, App thumbnails, RightSidePanel page sizes)
// used to each parse the same bytes with their own getDocument() call and never
// destroyed the result. This module parses each distinct byte buffer ONCE, hands
// the same PDFDocumentProxy to every consumer, and destroys it (freeing the
// worker-side copy) shortly after the last consumer releases it.
//
// Entries are keyed by the *identity* of the Uint8Array held in the store. The
// store treats pdfBytes as immutable (replaced, never mutated), so a new
// reference means new content.

import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Self-hosted worker (bundled by Vite) -- no CDN/network dependency. Importing
// this module anywhere guarantees the worker is configured.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface Entry {
  promise: Promise<PDFDocumentProxy>;
  task: { destroy: () => Promise<void> };
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<Uint8Array, Entry>();

// Grace period so quick release -> re-acquire (tab switch, React remount,
// StrictMode double effects) reuses the parsed doc instead of re-parsing.
const DESTROY_DELAY_MS = 5000;

/**
 * Get the shared PDFDocumentProxy for `bytes`. Every call MUST be paired with
 * releasePdfDoc(bytes) (typically in an effect cleanup).
 */
export function acquirePdfDoc(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  let entry = entries.get(bytes);
  if (!entry) {
    // pdf.js may detach/transfer the buffer it is given, so hand it a private copy.
    const task = pdfjsLib.getDocument({ data: bytes.slice(0) });
    entry = { promise: task.promise, task, refs: 0, timer: null };
    entries.set(bytes, entry);
    // If parsing fails, drop the entry so a later acquire can retry.
    const failed = entry;
    failed.promise.catch(() => {
      if (entries.get(bytes) === failed) entries.delete(bytes);
    });
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.refs++;
  return entry.promise;
}

/** Release one reference. The doc is destroyed after a grace period at 0 refs. */
export function releasePdfDoc(bytes: Uint8Array | null | undefined): void {
  if (!bytes) return;
  const entry = entries.get(bytes);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && !entry.timer) {
    entry.timer = setTimeout(() => {
      if (entry.refs === 0 && entries.get(bytes) === entry) {
        entries.delete(bytes);
        entry.task.destroy().catch(() => {});
      }
    }, DESTROY_DELAY_MS);
  }
}

/** Destroy everything immediately (app shutdown). */
export function destroyAllPdfDocs(): void {
  for (const [bytes, entry] of [...entries]) {
    if (entry.timer) clearTimeout(entry.timer);
    entries.delete(bytes);
    entry.task.destroy().catch(() => {});
  }
}

/**
 * textLayout.ts — Shared canvas-based text measurement utilities.
 *
 * Using the browser canvas with Inter (the same font the Konva app uses) ensures
 * the PDF exporter wraps text at exactly the same breakpoints as the on-screen
 * canvas renderer. This is the single source of truth for line-breaking.
 *
 * IMPORTANT: Call `ensureFontsLoaded()` (an async function) at the start of any
 * PDF export path to guarantee web-fonts are available before measuring.
 */

// ─── Measurement canvas singleton ────────────────────────────────────────────
// Must be large enough so Chromium does not clip font-metric calculations.
// measureText() is a virtual operation and does NOT depend on canvas content,
// but some Chromium builds suppress font activation on tiny canvases.
let _measureCanvas: HTMLCanvasElement | null = null;
let _measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(fontSize: number, fontFamily: string): CanvasRenderingContext2D {
  if (!_measureCtx) {
    _measureCanvas = document.createElement('canvas');
    _measureCanvas.width  = 4096;
    _measureCanvas.height = 64;
    _measureCanvas.style.position = 'absolute';
    _measureCanvas.style.left = '-9999px';
    _measureCanvas.style.top = '-9999px';
    _measureCanvas.style.pointerEvents = 'none';
    if (document.body) {
      document.body.appendChild(_measureCanvas);
    }
    _measureCtx = _measureCanvas.getContext('2d')!;
  }

  // Setting the font string forces the browser to activate the font face,
  // which is required for measureText() to return accurate glyph widths.
  _measureCtx.font = `${fontSize}px ${fontFamily}, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

  return _measureCtx;
}

// ─── Async font pre-loader ────────────────────────────────────────────────────

/**
 * Waits for all document fonts (including web fonts loaded via @font-face /
 * Google Fonts) to be ready.  Must be called before the first `wrapTextCanvas`
 * invocation in any PDF export path so that Inter glyph widths are accurate.
 *
 * Safe to call multiple times — resolves immediately once fonts are ready.
 */
export async function ensureFontsLoaded(
  fontSizes: number[] = [12, 14, 16, 24],
  fontFamily: string = 'Inter',
): Promise<void> {
  try {
    // 1. Wait for the document FontFaceSet to be in a "loaded" state.
    await document.fonts.ready;

    // 2. Explicitly request the specific face+size combinations we will use.
    //    This is a no-op if already loaded, but it triggers loading if not.
    await Promise.all(
      fontSizes.map(size =>
        document.fonts.load(`${size}px ${fontFamily}`).catch(() => { /* ignore */ })
      )
    );

    // 3. Pre-warm the singleton canvas so the font is "used" before measuring.
    //    Chromium activates a font face lazily — drawing even empty text helps.
    for (const size of fontSizes) {
      const ctx = getMeasureCtx(size, fontFamily);
      ctx.fillText('', 0, 0); // force font activation
    }
  } catch {
    // Non-fatal: fall back to whatever system font the browser picks.
  }
}

// ─── Core wrap function ───────────────────────────────────────────────────────

/**
 * Wraps `text` into lines that fit within `availableWidth` using browser canvas
 * font metrics (Inter by default).
 *
 * Rules:
 *  - Hard line breaks (`\n` or CRLF) always start a new line.
 *  - Escaped `\\n` sequences are treated as real newlines.
 *  - Words that exceed the available width are placed on their own line
 *    (no character-level breaking — matches Konva's `wrap="word"` behaviour).
 *
 * @param text           Raw text content (may contain \n characters).
 * @param availableWidth Maximum line width in the **same unit as fontSize**.
 *                       Pass `shape.width` (PDF points / Konva px).
 * @param fontSize       Unscaled font size in the **same unit as availableWidth**.
 * @param fontFamily     CSS font-family (default: 'Inter').
 * @param measureCtx     Optional: an already-configured CanvasRenderingContext2D
 *                       to use for measurement (avoids the singleton canvas and
 *                       guarantees the correct font is loaded).  When provided,
 *                       the caller is responsible for setting ctx.font before
 *                       calling this function.
 * @returns              Ordered array of wrapped lines.
 */
export function wrapTextCanvas(
  text: string,
  availableWidth: number,
  fontSize: number,
  fontFamily: string = 'Inter',
  measureCtx?: CanvasRenderingContext2D,
): string[] {
  if (!text) return [];
  if (availableWidth <= 0) return [text]; // Guard: never infinite-loop on zero width

  let ctx: CanvasRenderingContext2D;
  if (measureCtx) {
    // Use the caller-supplied context (e.g. the live rendering canvas).
    // The caller must have already set ctx.font to the correct size/family.
    ctx = measureCtx;
  } else {
    ctx = getMeasureCtx(fontSize, fontFamily);
  }

  // Normalise escaped sequences then split into hard paragraphs.
  const paragraphs = text.replace(/\\n/g, '\n').split(/\r?\n/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (!para) {
      // Preserve intentional blank lines (e.g. double-newline).
      lines.push('');
      continue;
    }

    const words = para.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (!word) continue; // Skip consecutive spaces.

      const wordWidth = ctx.measureText(word).width;
      if (wordWidth > availableWidth) {
        // If we have a current line, flush it first
        if (currentLine) {
          lines.push(currentLine);
          currentLine = '';
        }
        // Break the word character-by-character
        let temp = '';
        for (let charIndex = 0; charIndex < word.length; charIndex++) {
          const char = word[charIndex];
          const testTemp = temp + char;
          if (ctx.measureText(testTemp).width > availableWidth) {
            if (temp) {
              lines.push(temp);
            }
            temp = char;
          } else {
            temp = testTemp;
          }
        }
        currentLine = temp;
      } else {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testWidth = ctx.measureText(testLine).width;

        if (testWidth > availableWidth && currentLine) {
          // Current line is full — flush it and start a new one with this word.
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
    }

    if (currentLine) lines.push(currentLine);
  }

  return lines;
}

/**
 * Returns the rendered pixel width of `text` using canvas font metrics.
 * Useful for right/center alignment calculations.
 */
export function measureTextCanvas(
  text: string,
  fontSize: number,
  fontFamily: string = 'Inter',
): number {
  const ctx = getMeasureCtx(fontSize, fontFamily);
  return ctx.measureText(text).width;
}

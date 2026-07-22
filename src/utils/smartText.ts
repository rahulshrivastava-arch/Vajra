// ─────────────────────────────────────────────────────────────────────────────
// smartText.ts
//
// Pure functions for Master Page smart text variable resolution.
//
// Variables are written as {{Tag Name}} in text shapes on a Master Page.
// When the master is rendered as an underlay in Document View, each variable
// is substituted with a live value derived from the target document page.
//
// Supported variables:
//   {{Page Number}}    → current page number (e.g. "3")
//   {{Total Pages}}    → total page count (e.g. "12")
//   {{Date}}           → today's date (locale string, e.g. "5/25/2026")
//   {{Document Title}} → the active tab's label (e.g. "FloorPlan_Level1.pdf")
// ─────────────────────────────────────────────────────────────────────────────

/** Context passed when evaluating smart text for a specific page. */
export interface SmartTextContext {
  pageNum: number;
  totalPages: number;
  date: string;
  docTitle: string;
}

/**
 * Regex that matches any {{...}} variable tag.
 * Captured group 1 = the tag name (trimmed).
 */
const VARIABLE_REGEX = /\{\{([^}]+)\}\}/g;

/**
 * Returns true if the given text string contains at least one smart text
 * variable tag (e.g. {{Page Number}}). Used by the Master Page Editor to
 * render a visual indicator on variable-containing text shapes.
 */
export function containsSmartText(text: string): boolean {
  VARIABLE_REGEX.lastIndex = 0;
  return VARIABLE_REGEX.test(text);
}

/**
 * Replaces all smart text variable tags in `raw` with their resolved values
 * from `ctx`. Unknown tags are left as-is so authors can see if they've made
 * a typo.
 *
 * @param raw  The raw text string (may contain {{...}} tags).
 * @param ctx  Evaluation context: current page, total pages, date, doc title.
 * @returns    The resolved string with variables substituted.
 */
export function evaluateSmartText(raw: string, ctx: SmartTextContext): string {
  return raw.replace(VARIABLE_REGEX, (_, tag: string) => {
    const key = tag.trim().toLowerCase();
    switch (key) {
      case 'page number':
        return String(ctx.pageNum);
      case 'total pages':
        return String(ctx.totalPages);
      case 'date':
        return ctx.date;
      case 'document title':
        return ctx.docTitle;
      default:
        // Return the original tag so the author knows it wasn't resolved
        return `{{${tag}}}`;
    }
  });
}

/**
 * Returns the list of variable tag names found in `text`.
 * Used by the editor to show which variables are present.
 */
export function extractSmartTextVars(text: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  const re = /\{\{([^}]+)\}\}/g;
  while ((m = re.exec(text)) !== null) {
    found.push(m[1].trim());
  }
  return found;
}

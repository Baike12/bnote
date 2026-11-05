/**
 * The todo completion stamp (`✅ YYYY-MM-DD`), shared by the daily-note model,
 * the live preview, the cross-file todo sync and the footprint.
 *
 * It lives in `lib` because `daily/model.ts` is a pure text module: importing it
 * from `editor/ops` would drag the CodeMirror editor (and its view layer) into
 * every consumer of the todo model just to read a regular expression.
 */

/** Today as YYYY-MM-DD, the ✅ stamp appended when a todo is completed. */
export function todayStamp(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Trailing " ✅ YYYY-MM-DD" completion stamp, with surrounding whitespace. */
export const DONE_STAMP_RE = /(\s*✅\s*\d{4}-\d{2}-\d{2})\s*$/;

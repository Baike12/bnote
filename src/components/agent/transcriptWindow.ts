/** How many of the newest entries a restored conversation opens with. */
export const INITIAL_VISIBLE_ENTRIES = 60;
/** How many older entries each "load earlier" adds. */
export const EARLIER_STEP = 60;
/**
 * How far `alignWindowStart` may walk back. A turn usually holds one or two
 * entries, so this is generous for the normal shape; a single turn that spans
 * hundreds of assistant rounds (one user message, many tool rounds) must not
 * drag the whole tail into the window.
 */
export const ALIGN_MAX_BACK = 30;

/**
 * The first entry index a transcript window shows. `start` is the absolute
 * index the reader scrolled back to; `null` follows the tail. Clamped to the
 * list so a shrinking list never yields an empty or out-of-range window.
 */
export function transcriptWindowStart(total: number, start: number | null): number {
  const tail = Math.max(0, total - INITIAL_VISIBLE_ENTRIES);
  return Math.min(start ?? tail, total);
}

/** The window start after one "load earlier" click. */
export function earlierWindowStart(current: number): number {
  return Math.max(0, current - EARLIER_STEP);
}

/**
 * Move the window start back to a turn boundary, so a window normally opens
 * on the user message its first reply answers. A start already on a user entry
 * stays put; when the nearest user entry is farther than `maxBack` (a single
 * turn of many assistant rounds) the raw start is kept — the window must stay
 * bounded, which is the whole point of the window.
 */
export function alignWindowStart(
  entries: readonly { role: "user" | "assistant" | "notice" }[],
  start: number,
  maxBack = ALIGN_MAX_BACK,
): number {
  const from = Math.min(start, entries.length);
  if (from <= 0 || entries[from]?.role === "user") return Math.max(0, from);
  for (let i = from - 1; i >= 0 && from - i <= maxBack; i -= 1) {
    if (entries[i].role === "user") return i;
  }
  return from;
}

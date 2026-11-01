/**
 * Vertical position model of the caret in typewriter mode.
 *
 * `position` is the ratio of the viewport height where the caret line's centre
 * sits: 0.5 = vertically centred, below 0.5 sits higher (leaving more unread
 * content below), above 0.5 sits lower. The scroll container's top and bottom
 * padding are derived from that same ratio (top p, bottom 1-p), so that both
 * the first and the last line can stop at that height — with top padding only,
 * the last line always rests at the bottom and "sitting high" is only visible
 * in the middle of a document.
 */

export const DEFAULT_TYPEWRITER_POSITION = 0.5;
export const MIN_TYPEWRITER_POSITION = 0.2;
export const MAX_TYPEWRITER_POSITION = 0.8;

/** The setting may come from an old config or a hand-edited JSON file: clamp it
 *  into [20%, 80%] and round to 1%. */
export function normalizeTypewriterPosition(value: unknown): number {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_TYPEWRITER_POSITION;
  return Math.min(
    MAX_TYPEWRITER_POSITION,
    Math.max(MIN_TYPEWRITER_POSITION, Math.round(raw * 100) / 100),
  );
}

/**
 * Top and bottom padding of the scroll container (px). For the caret line's
 * centre to land at `position` of the height, the padding has to subtract half
 * a line height: first line centre = top padding + half a line; last line
 * centre = viewport height - bottom padding - half a line; both then equal
 * `position × viewport height` exactly.
 *
 * With `reserveTop = false` the top padding is 0: **the first line stays pinned
 * to the top**, so when the caret line is a few screens up it no longer drags
 * the first line down to centre it — the caret instead walks up the screen on
 * its own (used by the code pane; note bodies keep the top padding, so their
 * first line can still stop at the configured height). The bottom padding is
 * unchanged, so the last line still reaches the target height.
 */
export function typewriterReserve(
  clientHeight: number,
  lineHeight: number,
  position: number,
  reserveTop = true,
): { top: number; bottom: number } {
  const ratio = normalizeTypewriterPosition(position);
  const height = Math.max(0, clientHeight);
  const line = Math.max(0, lineHeight);
  return {
    top: reserveTop ? Math.max(0, Math.round(ratio * height - line / 2)) : 0,
    bottom: Math.max(0, Math.round((1 - ratio) * height - line / 2)),
  };
}

/** scrollTop delta needed to push the caret line's centre to the target height
 *  (positive scrolls down). */
export function typewriterScrollDelta(
  caretCenter: number,
  clientHeight: number,
  position: number,
): number {
  return caretCenter - Math.max(0, clientHeight) * normalizeTypewriterPosition(position);
}

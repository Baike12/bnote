/**
 * Draft parsing for the minutes input.
 *
 * Why the value cannot be committed while typing: clearing the input makes
 * `Number("")` 0, and normalization clamps that to 1, so the user can never
 * delete the digit (to type 25 you would first have to remove the 1). Draft
 * and committed value are therefore kept apart: an empty or malformed input
 * returns null (the current value is kept), and only a valid number is stored.
 *
 * Returning null means this input does not form a valid duration; the caller
 * should restore the input field to the current value.
 */
export function parseMinutesDraft(
  draft: string,
  { min = 1, max = 180 }: { min?: number; max?: number } = {},
): number | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

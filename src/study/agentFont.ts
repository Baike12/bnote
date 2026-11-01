/**
 * Conversation font-size zoom for the study assistant panel.
 *
 * Same interaction as the content column's web zoom (step through the scale
 * table + click the readout to return to 100%), but it scales the text inside
 * the panel: the 15px body base multiplied by the zoom, with headings / code /
 * tool rows derived at the same ratio (see `--agent-text` in global.css). The
 * header readout is that percentage.
 *
 * Steps: three steps on each side of 100% (85%-160%). The assistant column is
 * only a few hundred pixels wide, so above that a line of body text no longer
 * fits a few characters; below it the text is already unreadable. A value
 * hand-mangled in the settings is clamped back here.
 */

/** Zoom steps (ascending). */
const AGENT_FONT_STEPS = [0.85, 1, 1.1, 1.25, 1.4, 1.6];

export const MIN_AGENT_FONT = 0.85;
export const MAX_AGENT_FONT = 1.6;
export const DEFAULT_AGENT_FONT = 1;

/** The setting may come from an old config (no such key) or a hand-edited JSON: clamp into [85%, 160%]. */
export function normalizeAgentFont(value: unknown): number {
  const raw =
    typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_AGENT_FONT;
  return Math.min(MAX_AGENT_FONT, Math.max(MIN_AGENT_FONT, raw));
}

/** Step one entry in the step table; a value that is not on a step lands on the nearest one (never a fixed-ratio multiply). */
export function stepAgentFont(current: unknown, direction: 1 | -1): number {
  const value = normalizeAgentFont(current);
  if (direction > 0) {
    for (const step of AGENT_FONT_STEPS) {
      if (step > value + 1e-6) return step;
    }
    return MAX_AGENT_FONT;
  }
  for (let i = AGENT_FONT_STEPS.length - 1; i >= 0; i -= 1) {
    if (AGENT_FONT_STEPS[i] < value - 1e-6) return AGENT_FONT_STEPS[i];
  }
  return MIN_AGENT_FONT;
}

/** Readout, e.g. "110%". */
export function formatAgentFont(value: unknown): string {
  return `${Math.round(normalizeAgentFont(value) * 100)}%`;
}

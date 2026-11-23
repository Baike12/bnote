/**
 * The open-state rules of a turn's collapsible work section (ZCode's
 * ConversationWorkSegmentFlow), kept out of the component so the rules — not
 * only the markup — are testable.
 */

/** What the section shows and what the user has done with it. */
export interface WorkSection {
  /** Whether the section is expanded. */
  open: boolean;
  /** The user opened the section or a card inside it; their choice outranks the auto-collapse. */
  inspected: boolean;
}

/** One `toggle` event of a `<details>`, reduced to what the rules need. */
export interface SectionToggle {
  /** The event came from the section's own `<details>`, not from a card inside it. */
  own: boolean;
  /** The state the DOM holds after the toggle. */
  next: boolean;
  /** The state this component last rendered. */
  rendered: boolean;
}

/**
 * Apply one `toggle` event to the section.
 *
 * A `<details>` reports every write of its `open` property back as a `toggle`
 * event — the HTML spec queues one whenever the attribute changes — and React
 * writes it both on mount and on every state change. That echo is not a click:
 * counting it as one marked every streamed turn "opened by hand", so the
 * section never collapsed when its turn ended (observed in the browser: the
 * mount echo of `open={streaming}` arrived as a single `toggle next=true`
 * event, and the done edge left the section open). A toggle that reproduces
 * the rendered state is therefore ignored.
 *
 * A toggle from a card inside the section only records the inspection: the
 * section's own open state has one writer, so collapsing one card must not
 * collapse the section around it.
 */
export function applySectionToggle(section: WorkSection, toggle: SectionToggle): WorkSection {
  if (!toggle.own) {
    return toggle.next ? { ...section, inspected: true } : section;
  }
  if (toggle.next === toggle.rendered) return section;
  return { open: toggle.next, inspected: section.inspected || toggle.next };
}

/**
 * The open state once the turn stops streaming.
 *
 * The section auto-collapses to "已工作 N 秒". Two cases keep it open: the
 * user opened it by hand (their choice wins), and a turn whose work is all
 * there is to read — it failed, the user stopped it, or it ends on work with
 * no answer drawn outside the section.
 */
export function openWhenSettled(
  section: WorkSection,
  turn: { error?: unknown; stopReason?: string | null },
  hasAnswer: boolean,
): boolean {
  if (section.inspected) return section.open;
  return Boolean(turn.error) || turn.stopReason === "aborted" || !hasAnswer;
}

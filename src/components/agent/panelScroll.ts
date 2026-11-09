/**
 * The transcript scroller's geometry: where a streaming turn may scroll to,
 * and how far one stream event moves the view. Pure DOM measurement, kept out
 * of the panel so the rules are readable without the component tree.
 */

/** The flex gap between transcript entries (`.agent-scroll`); the reply starts
 *  this far below the newest user message. */
const TRANSCRIPT_GAP = 12;

/**
 * The scroll cap for a streaming turn: the scrollTop that puts the reply start
 * on the shade line. Measured once per turn from the live DOM — the shade line
 * is the bottom edge of the read shade (50% of the column), the reply start is
 * the bottom of the newest user row plus the entry gap.
 */
export function measureTurnCap(scroller: HTMLDivElement): number | null {
  const shade = scroller.parentElement?.querySelector<HTMLElement>(".agent-read-shade");
  if (!shade) return null;
  const top = scroller.getBoundingClientRect().top;
  const lineY = shade.getBoundingClientRect().bottom - top;
  const rows = scroller.querySelectorAll<HTMLElement>(".agent-msg-row.is-user");
  const lastUser = rows[rows.length - 1];
  if (!lastUser) return 0;
  const replyStart =
    lastUser.getBoundingClientRect().bottom - top + scroller.scrollTop + TRANSCRIPT_GAP;
  return Math.max(0, replyStart - lineY);
}

/**
 * One stream event's auto-scroll: keep the newest content visible, but never
 * past the turn cap — at the cap the newest line sits on the shade line and
 * the view freezes; what grows below is reached by scrolling manually.
 * Never scrolls up, so a manual scroll down sticks. The position it leaves
 * behind is recorded so the scroll listener can tell the user's upward
 * scrolls (always a decrease from the last auto position) from its own.
 */
export function followTranscript(scroller: HTMLDivElement, cap: number | null): number | null {
  const target = Math.min(scroller.scrollHeight - scroller.clientHeight, cap ?? Infinity);
  if (target > scroller.scrollTop) {
    scroller.scrollTo({ top: target });
    return target;
  }
  return null;
}

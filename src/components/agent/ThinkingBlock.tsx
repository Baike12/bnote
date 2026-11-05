import { useEffect, useRef, useState } from "react";
import { thinkingSummaryLine } from "./model";

/** The distance within which the thinking summary counts as pinned to the bottom (the same value as ZCode: within 2 px of the bottom). */
const THINKING_BOTTOM_LOCK_PX = 2;

/**
 * The collapsible block of the thinking process, modelled after ZCode's
 * Reasoning (the modified vercel/ai-elements): while streaming it is
 * collapsed, the summary line shows the last line of the thinking text and
 * scrolls to the end; when it is done the label becomes "thinking, lasted N
 * seconds". The content is shown as plain text (no markdown rendering: the
 * thinking is appended while streaming and rerunning the markdown parser on
 * every delta stutters on a long thinking). The open state scrolls inside a
 * limited height, sticks to the bottom by default, pauses when the user
 * scrolls away from the bottom and resumes when they scroll back.
 */
export function ThinkingBlock({
  thinking,
  streaming,
  seconds,
}: {
  thinking: string;
  streaming: boolean;
  seconds: number | null;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const stickBottomRef = useRef(true);
  const interactedRef = useRef(false);
  const [open, setOpen] = useState(false);

  // Streaming append: it sticks to the bottom while open; while collapsed the viewport of the single summary line is pushed to the end (the old content moves left).
  useEffect(() => {
    if (!streaming) return;
    if (open) {
      if (stickBottomRef.current) {
        const el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    } else {
      const tail = tailRef.current;
      if (tail) tail.scrollLeft = tail.scrollWidth;
    }
  }, [thinking, open, streaming]);

  // Collapse at the end of the output (ZCode autoCollapseKey): when the turn ends and the user has not opened the block manually, it returns to the collapsed state. Once the user has opened it (interacted) their choice is respected.
  useEffect(() => {
    if (!streaming && !interactedRef.current) setOpen(false);
  }, [streaming]);

  if (!thinking) return null;
  const tail = streaming && !open ? thinkingSummaryLine(thinking) : "";
  return (
    <details
      className={`agent-thinking${streaming ? " is-streaming" : ""}`}
      open={open}
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        if (next) interactedRef.current = true;
        setOpen(next);
      }}
    >
      <summary>
        <svg
          className="agent-thinking-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 4.5a3 3 0 0 0-3 3v.5a3 3 0 0 0-1.5 5.6A3 3 0 0 0 9 18.5a2.6 2.6 0 0 0 3 0 2.6 2.6 0 0 0 3 0 3 3 0 0 0 1.5-4.9A3 3 0 0 0 15 8v-.5a3 3 0 0 0-3-3Z" />
          <path d="M12 4.5V3M9.8 11.2c.7.5 1.6.5 2.2 0 .6.5 1.5.5 2.2 0M10 14.5h4" />
        </svg>
        {streaming ? (
          <span className="agent-thinking-live">正在思考</span>
        ) : (
          <span className="agent-thinking-done">
            思考
            <span className="agent-thinking-sec"> · 持续了 {seconds ?? 0} 秒</span>
          </span>
        )}
        {tail && (
          <span className="agent-thinking-tail" ref={tailRef}>
            <span className="agent-thinking-tail-text">{tail}</span>
          </span>
        )}
      </summary>
      <div
        className="agent-thinking-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottomRef.current =
            el.scrollHeight - el.clientHeight - el.scrollTop <= THINKING_BOTTOM_LOCK_PX;
        }}
      >
        {thinking}
      </div>
    </details>
  );
}

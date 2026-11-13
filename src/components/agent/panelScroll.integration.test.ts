import { describe, expect, it, vi } from "vitest";
import { followTranscript, measureTurnCap } from "./panelScroll";

/**
 * The transcript scroller's two rules:
 *
 *   - the cap puts the start of the streaming reply on the read-shade line;
 *   - one stream event scrolls down to that cap and never up, so a manual
 *     scroll sticks.
 *
 * jsdom has no layout, so the rectangles are the test fixture.
 */

interface Rect {
  top: number;
  bottom: number;
}

function setRect(el: Element, { top, bottom }: Rect): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

function fixture(shadeBottom: number | null): {
  scroller: HTMLDivElement;
  userRow: HTMLDivElement;
} {
  const parent = document.createElement("div");
  if (shadeBottom !== null) {
    const shade = document.createElement("div");
    shade.className = "agent-read-shade";
    setRect(shade, { top: shadeBottom - 100, bottom: shadeBottom });
    parent.append(shade);
  }
  const scroller = document.createElement("div");
  setRect(scroller, { top: 100, bottom: 500 });
  parent.append(scroller);
  document.body.append(parent);

  const userRow = document.createElement("div");
  userRow.className = "agent-msg-row is-user";
  return { scroller, userRow: userRow };
}

describe("measureTurnCap", () => {
  it("returns null when the read shade is absent", () => {
    const { scroller } = fixture(null);
    expect(measureTurnCap(scroller)).toBeNull();
  });

  it("returns 0 before the first user message exists", () => {
    const { scroller } = fixture(300);
    expect(measureTurnCap(scroller)).toBe(0);
  });

  it("puts the reply start (user row + gap) on the shade line", () => {
    const { scroller, userRow } = fixture(300);
    // lineY = 300 - 100 = 200.
    setRect(userRow, { top: 320, bottom: 390 });
    scroller.append(userRow);
    scroller.scrollTop = 50;

    // replyStart = 390 - 100 + 50 + 12 = 352; cap = 352 - 200 = 152.
    expect(measureTurnCap(scroller)).toBe(152);
  });

  it("clamps a reply that starts above the shade line to 0", () => {
    const { scroller, userRow } = fixture(500);
    setRect(userRow, { top: 120, bottom: 150 });
    scroller.append(userRow);
    // replyStart = 50 + 0 + 12 = 62; lineY = 400; negative -> 0.
    expect(measureTurnCap(scroller)).toBe(0);
  });

  it("uses the last user row, not the first", () => {
    const { scroller, userRow } = fixture(300);
    const first = document.createElement("div");
    first.className = "agent-msg-row is-user";
    setRect(first, { top: 110, bottom: 120 });
    setRect(userRow, { top: 320, bottom: 390 });
    scroller.append(first, userRow);
    expect(measureTurnCap(scroller)).toBe(102);
  });
});

describe("followTranscript", () => {
  function scrollable(scrollTop: number, scrollHeight = 1000, clientHeight = 400) {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
    el.scrollTop = scrollTop;
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      el.scrollTop = top ?? 0;
    });
    Object.defineProperty(el, "scrollTo", { configurable: true, value: scrollTo });
    return { el, scrollTo };
  }

  it("scrolls to the bottom while the cap is beyond the content", () => {
    const { el, scrollTo } = scrollable(100);
    expect(followTranscript(el, null)).toBe(600);
    expect(scrollTo).toHaveBeenCalledWith({ top: 600 });
    expect(el.scrollTop).toBe(600);
  });

  it("stops at the cap when the cap is above the bottom", () => {
    const { el, scrollTo } = scrollable(100);
    expect(followTranscript(el, 300)).toBe(300);
    expect(scrollTo).toHaveBeenCalledWith({ top: 300 });
  });

  it("does not scroll once the cap is reached", () => {
    const { el, scrollTo } = scrollable(600);
    expect(followTranscript(el, 300)).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("never scrolls up, even if the view is below the target", () => {
    const { el, scrollTo } = scrollable(800);
    expect(followTranscript(el, null)).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(800);
  });
});

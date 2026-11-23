import { describe, expect, it } from "vitest";
import { applySectionToggle, openWhenSettled, type WorkSection } from "./turnWork";

/**
 * The rules of a turn's work section: the streaming→done collapse, the user's
 * own choice outranking it, and the echo rule that made the collapse never
 * happen (a `<details>` reports React's own `open` write back as a `toggle`,
 * and that echo was counted as the user's click).
 */

const closed: WorkSection = { open: false, inspected: false };
const open = (inspected = false): WorkSection => ({ open: true, inspected });

describe("applySectionToggle", () => {
  it("the echo of our own write changes nothing", () => {
    // The browser queues this after React sets `open={streaming}` on mount.
    const echo = { own: true, next: true, rendered: true };
    expect(applySectionToggle(open(), echo)).toEqual(open());
    expect(applySectionToggle(closed, { own: true, next: false, rendered: false })).toEqual(closed);
  });

  it("a real toggle of the section writes its state; opening counts as inspection", () => {
    expect(applySectionToggle(closed, { own: true, next: true, rendered: false })).toEqual(
      open(true),
    );
    // Closing by hand is not an inspection: they want it shut.
    expect(applySectionToggle(open(), { own: true, next: false, rendered: true })).toEqual(closed);
  });

  it("a second close keeps the earlier inspection on record", () => {
    expect(applySectionToggle(open(true), { own: true, next: false, rendered: true })).toEqual({
      open: false,
      inspected: true,
    });
  });

  it("opening a card inside records the inspection but never writes the section's state", () => {
    expect(applySectionToggle(closed, { own: false, next: true, rendered: false })).toEqual({
      open: false,
      inspected: true,
    });
  });

  it("closing a card inside changes nothing", () => {
    expect(applySectionToggle(open(true), { own: false, next: false, rendered: true })).toEqual(
      open(true),
    );
  });
});

describe("openWhenSettled (the streaming → done edge)", () => {
  const done = { error: null, stopReason: null };

  it("collapses to 已工作 N 秒 when the turn ended on an answer", () => {
    expect(openWhenSettled(open(), done, true)).toBe(false);
  });

  it("a turn that failed, was stopped, or ends on work stays open", () => {
    expect(openWhenSettled(open(), { error: "boom", stopReason: null }, true)).toBe(true);
    expect(openWhenSettled(open(), { error: null, stopReason: "aborted" }, true)).toBe(true);
    expect(openWhenSettled(open(), done, false)).toBe(true);
  });

  it("the user's own choice outranks the auto-collapse in both directions", () => {
    expect(openWhenSettled(open(true), done, true)).toBe(true);
    // They opened something and shut the section again: leave it as they left it.
    expect(openWhenSettled({ open: false, inspected: true }, done, true)).toBe(false);
  });
});

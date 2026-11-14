import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The quick switcher reads the chord that opened it so pressing the same chord
 * again cycles the result list (alt-tab style). The record is a timestamped
 * one-shot: it must go stale instead of cycling a list that was opened by
 * something else long ago.
 *
 * The record is module state, so every test loads a fresh copy — assertions
 * must not depend on the order the file ran in.
 */

function chord(key: string): KeyboardEvent {
  return { key } as unknown as KeyboardEvent;
}

async function freshModule() {
  vi.resetModules();
  return await import("./lastChord");
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 0, 5, 10, 0, 0) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the chord that opened the current UI", () => {
  it("before any keystroke there is no chord", async () => {
    const { recentCommandChord } = await freshModule();
    expect(recentCommandChord()).toBeNull();
  });

  it("a recorded chord is returned as the lower-case key", async () => {
    const { recordCommandChord, recentCommandChord } = await freshModule();
    recordCommandChord(chord("O"));
    expect(recentCommandChord()?.key).toBe("o");
  });

  it("a later keystroke replaces the earlier one: the cycle follows the most recent chord", async () => {
    const { recordCommandChord, recentCommandChord } = await freshModule();
    recordCommandChord(chord("O"));
    recordCommandChord(chord("P"));
    expect(recentCommandChord()?.key).toBe("p");
  });

  it("the chord goes stale after the window, so an old chord cannot cycle a newly opened list", async () => {
    const { recordCommandChord, recentCommandChord } = await freshModule();
    recordCommandChord(chord("O"));
    vi.advanceTimersByTime(3000);
    expect(recentCommandChord()?.key).toBe("o");

    vi.advanceTimersByTime(1);
    expect(recentCommandChord()).toBeNull();
  });

  it("the caller can ask for a shorter window than the default", async () => {
    const { recordCommandChord, recentCommandChord } = await freshModule();
    recordCommandChord(chord("O"));
    vi.advanceTimersByTime(500);
    expect(recentCommandChord(499)).toBeNull();
    expect(recentCommandChord(500)?.key).toBe("o");
  });
});

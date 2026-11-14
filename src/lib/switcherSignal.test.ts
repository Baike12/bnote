import { afterEach, describe, expect, it } from "vitest";
import { cycleQuickSwitcher, registerSwitcherCycle } from "./switcherSignal";

/**
 * The chord-repeat hook of the quick switcher, as a signal: the command layer
 * may not import the component, so it calls this signal and the component
 * registers its handler while it is open. The return value is a promise to the
 * caller: "the selection moved" — a closed or empty switcher must answer
 * exactly that no, without throwing.
 */

afterEach(() => {
  registerSwitcherCycle(null);
});

describe("switcher cycle signal", () => {
  it("returns false while the switcher is closed", () => {
    expect(cycleQuickSwitcher(1)).toBe(false);
    expect(cycleQuickSwitcher(-1)).toBe(false);
  });

  it("forwards the direction and reports whether the selection moved", () => {
    const seen: (1 | -1)[] = [];
    registerSwitcherCycle((dir) => {
      seen.push(dir);
      return dir === 1;
    });

    expect(cycleQuickSwitcher(1)).toBe(true);
    expect(cycleQuickSwitcher(-1)).toBe(false);
    expect(seen).toEqual([1, -1]);
  });

  it("registering a new handler replaces the previous one", () => {
    const first = () => false;
    const second = () => true;
    registerSwitcherCycle(first);
    registerSwitcherCycle(second);
    expect(cycleQuickSwitcher(1)).toBe(true);
  });

  it("unregistering goes back to the no-op", () => {
    registerSwitcherCycle(() => true);
    registerSwitcherCycle(null);
    expect(cycleQuickSwitcher(1)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  clampTermHeight,
  closeTab,
  nextTitle,
  normalizeTermHeight,
  TERM_DEFAULT_HEIGHT,
  TERM_MIN_HEIGHT,
  type TermTab,
} from "./tabs";

const tab = (id: number, title = `zsh ${id}`): TermTab => ({ id, title, exited: false });

describe("terminal tab titles", () => {
  it("uses the bare shell name for the first tab", () => {
    expect(nextTitle([], "zsh")).toBe("zsh");
  });

  it("numbers duplicates instead of repeating the name", () => {
    const tabs = [tab(1, "zsh")];
    expect(nextTitle(tabs, "zsh")).toBe("zsh 2");
    expect(nextTitle([...tabs, tab(2, "zsh 2")], "zsh")).toBe("zsh 3");
  });

  it("fills a gap left by a closed tab", () => {
    // 1 and 3 exist (2 was closed): the next shell may take 2 again, so the
    // numbering never climbs forever in a long session.
    const tabs = [tab(1, "zsh"), tab(3, "zsh 3")];
    expect(nextTitle(tabs, "zsh")).toBe("zsh 2");
  });

  it("keeps unrelated shells apart", () => {
    expect(nextTitle([tab(1, "bash")], "zsh")).toBe("zsh");
  });
});

describe("closing terminal tabs", () => {
  const tabs = [tab(1), tab(2), tab(3)];

  it("moves the focus to the right neighbour when the active tab closes", () => {
    expect(closeTab(tabs, 2, 2)).toEqual({ tabs: [tab(1), tab(3)], activeId: 3 });
  });

  it("moves the focus left when the active last tab closes", () => {
    expect(closeTab(tabs, 3, 3)).toEqual({ tabs: [tab(1), tab(2)], activeId: 2 });
  });

  it("leaves the focus alone when a background tab closes", () => {
    expect(closeTab(tabs, 1, 3)).toEqual({ tabs: [tab(1), tab(2)], activeId: 1 });
  });

  it("returns a null active tab when the last tab closes", () => {
    expect(closeTab([tab(7)], 7, 7)).toEqual({ tabs: [], activeId: null });
  });

  it("ignores an unknown id", () => {
    expect(closeTab(tabs, 2, 99)).toEqual({ tabs, activeId: 2 });
  });
});

describe("terminal drawer height", () => {
  it("falls back to the default for bad persisted data", () => {
    for (const bad of [undefined, null, "220", NaN, Infinity, -10, 0]) {
      expect(normalizeTermHeight(bad)).toBe(TERM_DEFAULT_HEIGHT);
    }
  });

  it("keeps a valid persisted height", () => {
    expect(normalizeTermHeight(318.6)).toBe(319);
  });

  it("clamps a drag to the drawer bounds", () => {
    expect(clampTermHeight(10, 800)).toBe(TERM_MIN_HEIGHT);
    expect(clampTermHeight(5000, 800)).toBe(560); // 70% of the pane
    expect(clampTermHeight(300, 800)).toBe(300);
  });

  it("never clamps below the minimum, even in a tiny pane", () => {
    expect(clampTermHeight(300, 40)).toBe(TERM_MIN_HEIGHT);
  });
});

import { describe, expect, it } from "vitest";
import { pickKeyRegion, type FocusRegion } from "./globalKeys";

/**
 * Root-cause gate for region ownership.
 *
 * Ownership only follows "where the user last acted", not
 * `document.activeElement`: the reading region (PDF) deliberately does not
 * take DOM focus (giving the reader a tabindex/focus makes WebKit's text
 * selection anchor jump), so scrolling the page or clicking the body never
 * changes activeElement — with the focus still in the Agent input / note
 * editor, the reading region's bindings (screenshot, region switch) would
 * silently fall through to another command or do nothing. Conversely, a
 * region that is not on screen (temporarily hidden/collapsed inside the
 * three columns, or no Agent/reading region outside study mode) must not
 * hold the keyboard either.
 */
const ALL: FocusRegion[] = ["reading", "notes", "agent", "project"];
const onScreenAll = () => true;

describe("pickKeyRegion", () => {
  it("the region the user last acted in wins over the focused one (after scrolling a PDF the keyboard belongs to the reading region)", () => {
    expect(
      pickKeyRegion({
        owner: "reading",
        focus: "agent", // the focus is still in the Agent input
        onScreen: onScreenAll,
      }),
    ).toBe("reading");
  });

  it("with only a focus, the focus decides", () => {
    expect(pickKeyRegion({ owner: null, focus: "agent", onScreen: onScreenAll })).toBe("agent");
  });

  it("a region that is not on screen must not own the key (a key must never land on an absent region)", () => {
    const onScreen = (region: FocusRegion) => region !== "notes";
    expect(pickKeyRegion({ owner: "notes", focus: "notes", onScreen })).toBe("reading");
    expect(pickKeyRegion({ owner: "notes", focus: null, onScreen })).toBe("reading");
  });

  it("when the owning region is hidden, it falls back to the focused region that is on screen", () => {
    const onScreen = (region: FocusRegion) => region !== "agent";
    expect(pickKeyRegion({ owner: "agent", focus: "notes", onScreen })).toBe("notes");
  });

  it("with neither owner nor focus it falls back through reading region → project cards → notes region → Agent (the reading region takes no focus, which is the safest)", () => {
    expect(
      pickKeyRegion({
        owner: null,
        focus: null,
        onScreen: () => true,
      }),
    ).toBe("reading");
    // The reading region is absent: project management comes before the notes
    // region — right after switching into the project view there is no
    // "recent activity" yet, so the keyboard belongs to the cards in the
    // middle, not to the journal on the right.
    expect(
      pickKeyRegion({
        owner: null,
        focus: null,
        onScreen: (region) => region !== "reading",
      }),
    ).toBe("project");
    expect(
      pickKeyRegion({
        owner: null,
        focus: null,
        onScreen: (region) => region !== "reading" && region !== "project",
      }),
    ).toBe("notes");
  });

  it("when no region is on screen (the normal layout) it falls back to the notes region", () => {
    expect(pickKeyRegion({ owner: "reading", focus: null, onScreen: () => false })).toBe("notes");
  });

  it("a focused region that is not in the set (focus in the sidebar / title bar) does not change the ownership", () => {
    for (const owner of ALL) {
      expect(pickKeyRegion({ owner, focus: null, onScreen: onScreenAll })).toBe(owner);
    }
  });
});

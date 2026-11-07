import { describe, expect, it } from "vitest";
import "@/commands/builtin";
import { getCommand } from "./registry";
import { useAppStore } from "@/state/appStore";

/**
 * ⌘⌥R = "put the reading column back in the middle" only. The reader (PDF / web
 * page) is read, not typed into, so the command must not take the keyboard
 * from the notes editor / Agent input — the notes editor keeps the caret and
 * the next keystroke goes to it.
 *
 * The run executes in the node environment (no `document`): any focus
 * hand-off would throw here, so "the command is layout-only" is locked by the
 * fact that it completes at all, plus the explicit keystroke contract.
 */
describe("the reading-region command only re-orders the middle column", () => {
  it("puts the reading column back in the middle", () => {
    useAppStore.setState({ mainColumn: "agent" });
    const cmd = getCommand("region.focus-reading");
    expect(cmd).toBeDefined();
    cmd?.run();
    expect(useAppStore.getState().mainColumn).toBe("content");
  });

  it("does not pull the keyboard out of a web page that forwards the chord", () => {
    // The in-page runtime hands ⌘⌥R back to the main window; without this the
    // first responder would leave the page and the following keys would go to
    // a window that no region owns (see previewFocus).
    expect(getCommand("region.focus-reading")?.keepsPageFocus).toBe(true);
  });
});

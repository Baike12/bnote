import { describe, expect, it } from "vitest";
import { composerKeyAction, type ComposerKeyState } from "./composerKeys";

/**
 * The composer's key routing: Enter sends, the completion popup owns its keys,
 * ↑/↓ recall history only where they are not vim motions, and an IME key is
 * never taken.
 */

const base: ComposerKeyState = {
  key: "a",
  shift: false,
  ime: false,
  suggestOpen: false,
  historyActive: false,
  empty: false,
  edits: true,
};

const state = (patch: Partial<ComposerKeyState>): ComposerKeyState => ({ ...base, ...patch });

describe("Enter", () => {
  it("sends in insert mode and in vim's normal mode alike", () => {
    // Vim's normal-mode Enter is a motion; the composer has always sent on
    // Enter (Zed's message editor binds Enter → send for every mode too).
    expect(composerKeyAction(state({ key: "Enter" }))).toBe("send");
    expect(composerKeyAction(state({ key: "Enter", edits: false }))).toBe("send");
  });

  it("Shift+Enter is a newline, left to the editor", () => {
    expect(composerKeyAction(state({ key: "Enter", shift: true }))).toBe("pass");
  });

  it("the IME's own Enter is never a send", () => {
    expect(composerKeyAction(state({ key: "Enter", ime: true }))).toBe("pass");
  });
});

describe("the completion popup owns its keys while it is open", () => {
  const open = { suggestOpen: true };

  it("arrows walk the list, Escape closes, Tab/Enter pick", () => {
    expect(composerKeyAction(state({ ...open, key: "ArrowDown" }))).toBe("suggest-next");
    expect(composerKeyAction(state({ ...open, key: "ArrowUp" }))).toBe("suggest-prev");
    expect(composerKeyAction(state({ ...open, key: "Escape" }))).toBe("suggest-close");
    expect(composerKeyAction(state({ ...open, key: "Tab" }))).toBe("suggest-pick");
    expect(composerKeyAction(state({ ...open, key: "Enter" }))).toBe("suggest-pick");
    expect(composerKeyAction(state({ ...open, key: "Enter", shift: true }))).toBe("pass");
  });

  it("every other key stays the editor's", () => {
    expect(composerKeyAction(state({ ...open, key: "j" }))).toBe("pass");
    expect(composerKeyAction(state({ ...open, key: "ArrowLeft" }))).toBe("pass");
  });

  it("the open popup outranks vim: its arrows do not become motions", () => {
    expect(composerKeyAction(state({ ...open, key: "ArrowDown", edits: false }))).toBe(
      "suggest-next",
    );
  });
});

describe("the prompt history", () => {
  it("↑ on an empty box walks back; ↓ walks forward while inside the list", () => {
    expect(composerKeyAction(state({ key: "ArrowUp", empty: true }))).toBe("history-up");
    expect(composerKeyAction(state({ key: "ArrowDown", historyActive: true }))).toBe(
      "history-down",
    );
  });

  it("a non-empty box keeps ↑ for the editor", () => {
    expect(composerKeyAction(state({ key: "ArrowUp", empty: false }))).toBe("pass");
  });

  it("in vim's normal/visual mode the arrows are motions, not the history", () => {
    expect(composerKeyAction(state({ key: "ArrowUp", empty: true, edits: false }))).toBe("pass");
    expect(composerKeyAction(state({ key: "ArrowDown", historyActive: true, edits: false }))).toBe(
      "pass",
    );
  });
});

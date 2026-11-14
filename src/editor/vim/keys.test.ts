import { describe, expect, it } from "vitest";
import { commandMappingKeymap, lookupVimCommand, normalizeVimKey, vimCapturesKey } from "./vim";
import type { VimMapping } from "./vimrc";

/**
 * `normalizeVimKey` translates vim key notation into the CM6 key string the
 * keymap and the capture registry agree on. Both consumers use the same
 * function, so a translation that returns a string for an unusable lhs (or null
 * for a usable one) silently unbinds or mis-binds the user's key.
 */
describe("normalizeVimKey: modifier chords", () => {
  it("the short and long modifier spellings produce the same CM6 key", () => {
    expect(normalizeVimKey("<C-s>")).toBe("Ctrl-s");
    expect(normalizeVimKey("<ctrl-s>")).toBe("Ctrl-s");
    expect(normalizeVimKey("<D-s>")).toBe("Mod-s");
    expect(normalizeVimKey("<cmd-s>")).toBe("Mod-s");
    expect(normalizeVimKey("<meta-s>")).toBe("Mod-s");
    expect(normalizeVimKey("<M-x>")).toBe("Alt-x");
    expect(normalizeVimKey("<alt-x>")).toBe("Alt-x");
    expect(normalizeVimKey("<A-x>")).toBe("Alt-x");
    expect(normalizeVimKey("<S-Tab>")).toBe("Shift-Tab");
  });

  it("multiple modifiers accumulate in declaration order", () => {
    expect(normalizeVimKey("<C-S-s>")).toBe("Ctrl-Shift-s");
    expect(normalizeVimKey("<D-C-s>")).toBe("Mod-Ctrl-s");
  });

  it("the known vim key names are translated to CM6 names", () => {
    expect(normalizeVimKey("<Esc>")).toBe("Escape");
    expect(normalizeVimKey("<CR>")).toBe("Enter");
    expect(normalizeVimKey("<Return>")).toBe("Enter");
    expect(normalizeVimKey("<Enter>")).toBe("Enter");
    expect(normalizeVimKey("<Tab>")).toBe("Tab");
    expect(normalizeVimKey("<Space>")).toBe("Space");
    expect(normalizeVimKey("<BS>")).toBe("Backspace");
    expect(normalizeVimKey("<Bar>")).toBe("|");
    expect(normalizeVimKey("<LT>")).toBe("<");
    expect(normalizeVimKey("<GT>")).toBe(">");
    expect(normalizeVimKey("<Lead>")).toBe("\\");
  });

  it("function keys and named navigation keys pass through", () => {
    expect(normalizeVimKey("<F5>")).toBe("F5");
    expect(normalizeVimKey("<F12>")).toBe("F12");
    expect(normalizeVimKey("<Home>")).toBe("Home");
    expect(normalizeVimKey("<End>")).toBe("End");
    expect(normalizeVimKey("<PageUp>")).toBe("PageUp");
    expect(normalizeVimKey("<PageDown>")).toBe("PageDown");
    expect(normalizeVimKey("<Delete>")).toBe("Delete");
    expect(normalizeVimKey("<Insert>")).toBe("Insert");
    expect(normalizeVimKey("<ArrowLeft>")).toBe("ArrowLeft");
  });
});

describe("normalizeVimKey: what cannot be a CM6 key binding", () => {
  it("a bare multi-character lhs returns null (the keymap cannot catch it)", () => {
    expect(normalizeVimKey("gs")).toBeNull();
    expect(normalizeVimKey("jj")).toBeNull();
  });

  it("a single character is its own key", () => {
    expect(normalizeVimKey("g")).toBe("g");
    expect(normalizeVimKey(";")).toBe(";");
  });

  it("an unknown modifier or an unknown key name returns null", () => {
    expect(normalizeVimKey("<X-s>")).toBeNull();
    expect(normalizeVimKey("<C-NotAKey>")).toBeNull();
  });

  it("an empty angle form returns null instead of an empty key", () => {
    expect(normalizeVimKey("<>")).toBeNull();
    expect(normalizeVimKey("<->")).toBeNull();
  });

  it("a partially bracketed lhs is not a notation form", () => {
    expect(normalizeVimKey("<C-s")).toBeNull();
    expect(normalizeVimKey("C-s>")).toBeNull();
  });
});

describe("commandMappingKeymap: duplicate keys collapse last-wins", () => {
  const mapping = (mode: VimMapping["mode"], commandId: string): VimMapping => ({
    lhs: "<C-b>",
    rhs: `:Bnote ${commandId}<CR>`,
    mode,
    noremap: false,
    commandId,
  });

  it("a later definition of the same key and mode wins (vim's rule, not the keymap's first-wins)", () => {
    commandMappingKeymap([mapping("normal", "first.command"), mapping("normal", "second.command")]);
    expect(lookupVimCommand("<C-b>", "normal")).toBe("second.command");
  });

  it("the same lhs in different modes stays two separate bindings", () => {
    commandMappingKeymap([
      mapping("normal", "normal.command"),
      mapping("visual", "visual.command"),
    ]);
    expect(lookupVimCommand("<C-b>", "normal")).toBe("normal.command");
    expect(lookupVimCommand("<C-b>", "visual")).toBe("visual.command");
    expect(lookupVimCommand("<C-b>", "insert")).toBeUndefined();
  });

  it("a mapping without a command id never enters the registry", () => {
    commandMappingKeymap([{ lhs: "<C-b>", rhs: "<Esc>", mode: "normal", noremap: false }]);
    expect(lookupVimCommand("<C-b>", "normal")).toBeUndefined();
  });

  it("an unusable lhs never enters the registry", () => {
    commandMappingKeymap([{ ...mapping("normal", "some.command"), lhs: "gs" }]);
    expect(lookupVimCommand("gs", "normal")).toBeUndefined();
  });

  it("the registry keeps the lhs verbatim (the engine's vocabulary), not the normalized key", () => {
    commandMappingKeymap([mapping("normal", "nav.toggle-sidebar")]);
    expect(lookupVimCommand("<C-b>", "normal")).toBe("nav.toggle-sidebar");
    expect(lookupVimCommand("Ctrl-b", "normal")).toBeUndefined();
  });

  it("an empty mapping list clears the registry", () => {
    commandMappingKeymap([mapping("normal", "some.command")]);
    commandMappingKeymap([]);
    expect(lookupVimCommand("<C-b>", "normal")).toBeUndefined();
  });
});

describe("vimCapturesKey: the capture dispatch decision", () => {
  const base = {
    insertMode: false,
    composing: false,
    deadKey: false,
    targetIsContentDOM: true,
    defaultPrevented: false,
  };

  it("an ordinary key in normal mode goes to the engine", () => {
    expect(vimCapturesKey(base)).toBe(true);
  });

  it("each guard releases the key to the CM keymap chain", () => {
    expect(vimCapturesKey({ ...base, insertMode: true })).toBe(false);
    expect(vimCapturesKey({ ...base, composing: true })).toBe(false);
    expect(vimCapturesKey({ ...base, deadKey: true })).toBe(false);
    expect(vimCapturesKey({ ...base, defaultPrevented: true })).toBe(false);
    expect(vimCapturesKey({ ...base, targetIsContentDOM: false })).toBe(false);
  });

  it("an already-claimed event wins over the target check (order does not change the answer)", () => {
    expect(vimCapturesKey({ ...base, defaultPrevented: true, targetIsContentDOM: false })).toBe(
      false,
    );
  });
});

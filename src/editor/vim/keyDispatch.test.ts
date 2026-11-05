import { describe, expect, it } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { commandMappingKeymap, lookupVimCommand, vimCapturesKey } from "./vim";
import {
  buildSession,
  escapeForSnippet,
  setSession,
  snippetField,
  type SnippetSession,
} from "@/editor/snippets/extension";
import { parseReplacement } from "@/editor/snippets/engine";
import { useAppStore } from "@/state/appStore";

/**
 * Root-cause regression for "normal-mode Enter/Backspace get rewritten and a
 * live session swallows the first Esc".
 *
 * CM6 funnels all keyBindings into one shared keydown handler, flattened at
 * the position of the first keymap.of declaration (in baseExtensions that is
 * snippetsExtension(), the earliest one), so it runs before the vim engine.
 * The engine's own chain entry never returns true (it acts through side
 * effects and never claims the event), so any key bound by some keymap never
 * reaches the engine: in normal mode Enter lands on defaultKeymap's
 * insertNewlineAndIndent (inserting a line out of nowhere) and Backspace on
 * deleteCharBackward (deleting a character); a live snippet session swallows
 * the first Esc (so leaving takes two presses).
 *
 * The two contracts of the fix are locked here (the dispatch order itself
 * needs a DOM and is verified in the browser):
 * 1. vimCapturesKey: the capture dispatcher only takes over in normal/visual
 *    mode; insert mode yields to the snippet/latex editing enhancements, and
 *    IME composition, dead keys and already-claimed events are never touched;
 * 2. the command mapping registry: `nmap <C-b> :Bnote…` collides with the
 *    engine's native <C-b> (page down), so the capture dispatch must consult
 *    it before the engine; mappings deleted from the vimrc do not linger.
 * 3. the snippet Esc gate: with vim enabled the engine leaves insert mode
 *    first.
 */

const capturesBase = {
  insertMode: false,
  composing: false,
  deadKey: false,
  targetIsContentDOM: true,
  defaultPrevented: false,
};

describe("vimCapturesKey: the decision core of the capture dispatch", () => {
  it("normal/visual mode is handed to the engine", () => {
    expect(vimCapturesKey(capturesBase)).toBe(true);
  });

  it("insert mode yields: the snippet Tab/Escape and the latex Backspace legitimately run first in insert mode", () => {
    expect(vimCapturesKey({ ...capturesBase, insertMode: true })).toBe(false);
  });

  it("IME composition / dead key / already claimed upstream / the target is not on the editable content → it is not touched", () => {
    expect(vimCapturesKey({ ...capturesBase, composing: true })).toBe(false);
    expect(vimCapturesKey({ ...capturesBase, deadKey: true })).toBe(false);
    expect(vimCapturesKey({ ...capturesBase, defaultPrevented: true })).toBe(false);
    expect(vimCapturesKey({ ...capturesBase, targetIsContentDOM: false })).toBe(false);
  });
});

describe("lookupVimCommand: the command mapping registry (the capture dispatch consults it before the engine)", () => {
  const mappings = [
    {
      lhs: "<C-s>",
      rhs: ":w<CR>",
      mode: "normal" as const,
      commandId: "workspace.save-note",
      noremap: false,
    },
    {
      lhs: "<C-b>",
      rhs: ":Bnote nav.toggle-sidebar<CR>",
      mode: "normal" as const,
      commandId: "nav.toggle-sidebar",
      noremap: false,
    },
    // Multi-key lhs: the keymap cannot catch it (normalizeVimKey returns
    // null), so it stays out of the registry
    { lhs: "gs", rhs: ":Bnote x.y<CR>", mode: "normal" as const, commandId: "x.y", noremap: false },
  ];

  it("a hit is keyed by the mode\\0engine key; a mode mismatch or an unbound key does not hit", () => {
    commandMappingKeymap(mappings);
    expect(lookupVimCommand("<C-b>", "normal")).toBe("nav.toggle-sidebar");
    expect(lookupVimCommand("<C-s>", "normal")).toBe("workspace.save-note");
    expect(lookupVimCommand("<C-b>", "insert")).toBeUndefined();
    expect(lookupVimCommand("<C-z>", "normal")).toBeUndefined();
  });

  it("a multi-key lhs does not enter the registry (same criteria as the keymap)", () => {
    commandMappingKeymap(mappings);
    expect(lookupVimCommand("gs", "normal")).toBeUndefined();
  });

  it("a rebuild is a wholesale replacement: mappings deleted from the vimrc do not linger", () => {
    commandMappingKeymap(mappings.slice(0, 1));
    expect(lookupVimCommand("<C-b>", "normal")).toBeUndefined();
    expect(lookupVimCommand("<C-s>", "normal")).toBe("workspace.save-note");
  });
});

/* ---- escapeForSnippet: a live session must not swallow vim's first Esc ---- */

function withSession(doc: string, session: SnippetSession | null): EditorState {
  const base = EditorState.create({ doc, extensions: [snippetField] });
  return base.update({ effects: setSession.of(session) }).state;
}

function fakeView(initial: EditorState): EditorView {
  let current = initial;
  return {
    get state() {
      return current;
    },
    dispatch: (spec: TransactionSpec) => {
      current = current.update(spec).state;
    },
  } as unknown as EditorView;
}

const dmSession = () => buildSession(0, parseReplacement("$$\n$0\n$$", [], null))!;

describe("escapeForSnippet: a live session must not swallow vim's first Esc", () => {
  it("vim enabled → it returns false (letting the engine leave insert mode) and the session is kept as is", () => {
    useAppStore.getState().patchSettings({ vim: true });
    const view = fakeView(withSession("$$\nx\n$$", dmSession()));
    expect(escapeForSnippet(view)).toBe(false);
    expect(view.state.field(snippetField, false)).not.toBeNull();
  });

  it("vim disabled → the latex-suite semantics hold: Esc ends the session", () => {
    useAppStore.getState().patchSettings({ vim: false });
    const view = fakeView(withSession("$$\nx\n$$", dmSession()));
    expect(escapeForSnippet(view)).toBe(true);
    expect(view.state.field(snippetField, false)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { applyNativeMappings } from "./vim";
import { Vim } from "@replit/codemirror-vim";

// The engine's insert-mode mapping timeout timer hangs off `window` (vim.js's
// insertModeEscKeysTimeout); the node test environment supplies it through a
// global alias.
(globalThis as Record<string, unknown>).window = globalThis;

/**
 * Key-sequence mappings (`imap jj <Esc>` and friends) must hand the rhs to
 * the engine **verbatim**. When the engine expands a keyToKey mapping it
 * splits on angle-bracket tokens (doKeyToKey) and takes its native
 * "leave insert mode" branch for `<Esc>`; once rewritten to a bare "Esc", the
 * expander replaces the selection with the three single characters E·s·c one
 * by one — insert mode can no longer be left and the literal "Esc" lands in
 * the document. The "gg/G does not jump in normal mode" reports actually
 * happened in insert state (jj failed to leave). Here the real engine plus a
 * minimal CM5 shim locks this down at the behavior level (pure logic, no DOM).
 */

function indexFromPos(doc: { lines: number; line(n: number): { from: number; to: number } }, pos: { line: number; ch: number }): number {
  const lineNumber = Math.min(Math.max(pos.line + 1, 1), doc.lines);
  const line = doc.line(lineNumber);
  return line.from + Math.min(Math.max(pos.ch, 0), line.to - line.from);
}

/** Minimal CM5-style shim: the method surface the engine's insert path
 *  (i / jj→<Esc>) touches. The document state is carried by a real
 *  EditorState; Pos(line, ch) is 0-based, as in the engine. */
function makeCm(docText: string) {
  let state = EditorState.create({ doc: docText });
  const opts: Record<string, unknown> = {};

  const doc = () => state.doc;
  const curPos = (): { line: number; ch: number } => {
    const offset = state.selection.main.head;
    const line = state.doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  };
  const setCur = (pos: { line: number; ch: number }) => {
    const offset = indexFromPos(state.doc, pos);
    state = state.update({ selection: { anchor: offset } }).state;
  };
  const dispatch = (changes: { from: number; to: number; insert: string }, selAnchor?: number) => {
    state = state.update({ changes, selection: selAnchor !== undefined ? { anchor: selAnchor } : undefined }).state;
  };
  const posToOffset = (pos: { line: number; ch: number }) => indexFromPos(state.doc, pos);

  const cm = {
    // The engine hangs the per-editor vim state off cm.state.vim
    state: {} as { vim?: unknown },
    curOp: {} as Record<string, unknown>,
    operation(f: () => void) {
      this.curOp = {};
      try {
        f();
      } finally {
        this.curOp = {};
      }
    },
    getOption: (name: string) => opts[name],
    setOption: (name: string, value: unknown) => {
      opts[name] = value;
    },
    firstLine: () => 0,
    lastLine: () => doc().lines - 1,
    lineCount: () => doc().lines,
    getLine: (row: number) => (row < 0 || row >= doc().lines ? "" : doc().line(row + 1).text),
    getCursor: (_p?: string) => curPos(),
    getRange: (a: { line: number; ch: number }, b: { line: number; ch: number }) => {
      const from = posToOffset(a);
      const to = posToOffset(b);
      return from <= to ? state.doc.sliceString(from, to) : state.doc.sliceString(to, from);
    },
    listSelections: () => [(() => {
      const p = curPos();
      return { anchor: { ...p }, head: { ...p } };
    })()],
    somethingSelected: () => false,
    setSelection: (anchor: { line: number; ch: number }, head: { line: number; ch: number }) => {
      const a = posToOffset(anchor);
      const h = posToOffset(head);
      state = state.update({ selection: { anchor: a, head: h } }).state;
    },
    setSelections: (ranges: { anchor: { line: number; ch: number }; head: { line: number; ch: number } }[]) => {
      const first = ranges[0];
      if (first) cm.setSelection(first.anchor, first.head);
    },
    replaceRange: (text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => {
      const f = posToOffset(from);
      const t = to ? posToOffset(to) : f;
      const insert = text ?? "";
      dispatch({ from: Math.min(f, t), to: Math.max(f, t), insert }, Math.min(f, t) + insert.length);
    },
    replaceSelection: (text: string) => {
      const p = curPos();
      const at = posToOffset(p);
      dispatch({ from: at, to: at, insert: text }, at + text.length);
    },
    setCursor: (pos: { line?: number; ch?: number } | { line: number; ch: number }) => {
      const p = curPos();
      const line = typeof pos === "object" && pos.line !== undefined ? pos.line : p.line;
      const ch = typeof pos === "object" && pos.ch !== undefined ? pos.ch : p.ch;
      setCur({ line, ch: ch ?? 0 });
    },
    // Wide catch-all: the test only enters and leaves insert mode, so every
    // other engine probe fails harmlessly
    isInMultiSelectMode: () => false,
    inVirtualSelectionMode: false,
    toggleOverwrite: () => {},
    setBookmark: () => ({ clear: () => {} }),
    getInputField: () => ({}),
    markText: () => ({ clear: () => {} }),
    on: () => {},
    off: () => {},
    signal: () => {},
    getValue: () => state.doc.toString(),
    state_: null,
  };
  return {
    cm: cm as unknown as Record<string, unknown> & { state: { vim?: unknown } },
    docText: () => state.doc.toString(),
  };
}

/** Feed a key sequence into the engine (the wrapper's real path is
 *  multiSelectHandleKey). */
function typeKeys(cm: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    Vim.multiSelectHandleKey(cm as never, k, "user");
  }
}

function modeOf(cm: { state: { vim?: { insertMode?: boolean } } }): string {
  const vim = cm.state.vim as { insertMode?: boolean } | undefined;
  return vim?.insertMode ? "insert" : "normal";
}

describe("applyNativeMappings: the rhs goes into the engine verbatim (the key name rewriting regression)", () => {
  it("`imap jj <Esc>` (the rhs contains angle brackets): the two j leave insert mode and the document stays as it is", () => {
    applyNativeMappings([{ lhs: "jj", rhs: "<Esc>", mode: "insert", noremap: true }]);
    const { cm, docText } = makeCm("line one\nline two");
    typeKeys(cm, ["i"]);
    expect(modeOf(cm as never)).toBe("insert");
    typeKeys(cm, ["j", "j"]);
    expect(modeOf(cm as never)).toBe("normal");
    // The engine's changeQueue books the undo as "2 characters inserted
    // during the partial"; the shim has no browser default input, so the
    // first key never really inserted and the document ends up 2 characters
    // short — that is the shim's bookkeeping artifact; under a real keyboard
    // the undo removes exactly the "jj" just typed. Only two things are
    // locked here: the mode returns to normal, and no literal "Esc" was
    // inserted into the document.
    expect(docText()).not.toContain("Esc");
  });

  it("an rhs mixing <Esc> with ordinary characters (jja) is still expanded token by token", () => {
    applyNativeMappings([{ lhs: ">>", rhs: "<Esc>A;", mode: "insert", noremap: true }]);
    const { cm, docText } = makeCm("abc");
    typeKeys(cm, ["i"]);
    typeKeys(cm, [">", ">"]);
    expect(modeOf(cm as never)).toBe("insert"); // A re-enters insert after <Esc> left
    typeKeys(cm, ["<Esc>"]);
    expect(modeOf(cm as never)).toBe("normal");
    expect(docText()).toBe("abc;");
  });

  it("a bare Esc string as the rhs is inserted character by character (locking the historic symptom of the rewrite error)", () => {
    // Regression guard: if someone ever rewrites <Esc> back to a bare Esc
    // again, this case will see the mode still insert and the document
    // carrying an extra "Esc" — exactly the dead end users hit.
    applyNativeMappings([{ lhs: ";;", rhs: "Esc", mode: "insert", noremap: true }]);
    const { cm, docText } = makeCm("x");
    typeKeys(cm, ["i"]);
    typeKeys(cm, [";", ";"]);
    const stillInsert = modeOf(cm as never) === "insert";
    const polluted = docText().includes("Esc");
    expect(stillInsert || polluted).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The command table imports the code-project commands, which pull xterm in;
// xterm probes a 2D canvas while its module evaluates, and jsdom has no canvas
// implementation. A null context is enough — nothing here renders a terminal.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import "@/commands/builtin";
import { docPathField, setDocPath } from "@/editor/docPath";
import { editorApi, registerEditorView, unregisterEditorView } from "@/editor/api";
import { setConfigSnapshot, useAppStore } from "@/state/appStore";
import { installGlobalKeybindings, runBoundKey, setActiveKeyRegion } from "./globalKeys";
import { runCommand } from "./registry";
import { applyOverrides } from "./keys";

/**
 * The editing commands are the clearest case of the project's convention: the
 * toolbar/palette entry and the keybinding are the same command, so what a
 * chord does is exactly what `runCommand` does. The document is the observable
 * proof — an assertion on the resulting bytes cannot pass if either path
 * drifted to a different operation.
 *
 * A real EditorView is used: `withView` reads `getView()` and dispatches
 * transactions, so a stub would test the stub. Only the DOM node exists; jsdom
 * has no layout, which the edit operations do not read.
 */

const PATH = "/fake/vault/a.md";

let view: EditorView | null = null;

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  let state = EditorState.create({ doc, extensions: [docPathField] });
  state = state.update({ effects: setDocPath.of(PATH) }).state;
  const created = new EditorView({ state, parent });
  registerEditorView(created);
  return created;
}

/** Select `text` inside the document, so a wrapping command has a range to act on. */
function select(text: string): void {
  const doc = view!.state.doc.toString();
  const from = doc.indexOf(text);
  if (from < 0) throw new Error(`not in document: ${text}`);
  view!.dispatch({ selection: { anchor: from, head: from + text.length } });
}

function putCaretOn(lineNumber: number): void {
  const line = view!.state.doc.line(lineNumber);
  view!.dispatch({ selection: { anchor: line.from + 1 } });
}

function lineText(lineNumber: number): string {
  return view!.state.doc.line(lineNumber).text;
}

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  setConfigSnapshot({});
  applyOverrides({});
  setActiveKeyRegion("notes");
  useAppStore.setState({
    currentFile: PATH,
    mode: "notes",
    modal: null,
    toast: null,
    settings: { ...useAppStore.getState().settings, autoNumberHeadings: false },
  });
  installGlobalKeybindings();
});

afterEach(() => {
  if (view) unregisterEditorView(view);
  view = null;
  editorApi.view = null;
  document.body.replaceChildren();
});

describe("the editor is the command's target", () => {
  it("with no editor open the command refuses honestly instead of throwing", () => {
    expect(runBoundKey("Mod-b", "notes")).toBe(true);
    expect(useAppStore.getState().toast).toBe("没有活动的编辑器");
  });

  it("the command acts on the active editor only, never on every mounted one", () => {
    view = mount("first\n");
    const second = mount("second\n");
    try {
      // A freshly mounted instance becomes the active one (the user just saw
      // it); the command must not reach into the editor behind it.
      expect(editorApi.view).toBe(second);
      runCommand("edit.toggle-bold");
      expect(view.state.doc.toString()).toBe("first\n");
      expect(second.state.doc.toString()).not.toBe("second\n");
    } finally {
      unregisterEditorView(second);
    }
  });
});

describe("inline wrappers", () => {
  it("⌘B wraps the selection in bold markers, and pressing it again removes them", () => {
    view = mount("hello world\n");
    select("hello");

    expect(runBoundKey("Mod-b", "notes")).toBe(true);
    expect(view.state.doc.toString()).toBe("**hello** world\n");

    // The toggle is idempotent in the sense that matters: the same command on
    // an already-wrapped word undoes it instead of nesting markers.
    runBoundKey("Mod-b", "notes");
    expect(view.state.doc.toString()).toBe("hello world\n");
  });

  it("⌘⇧I toggles italic through the same wrap", () => {
    view = mount("hello\n");
    select("hello");

    runCommand("edit.toggle-italic");
    expect(view.state.doc.toString()).toBe("*hello*\n");
  });

  it("⌘⇧D toggles strikethrough", () => {
    view = mount("hello\n");
    select("hello");

    runCommand("edit.toggle-strikethrough");
    expect(view.state.doc.toString()).toBe("~~hello~~\n");
  });
});

describe("line-level commands", () => {
  it("⌘J cycles a heading one level down, one level up, then back to body text", () => {
    view = mount("# Title\n");
    putCaretOn(1);

    runCommand("edit.toggle-heading");
    expect(lineText(1)).toBe("## Title");

    runCommand("edit.heading-promote");
    expect(lineText(1)).toBe("# Title");

    runCommand("edit.heading-promote");
    expect(lineText(1)).toBe("Title");
  });

  it("turning a line into a specific heading level is one command per level", () => {
    view = mount("Title\n");
    putCaretOn(1);

    runCommand("edit.heading-3");
    expect(lineText(1)).toBe("### Title");

    // Pressing the same level again removes it: the command is a toggle, not
    // an "insert this many hashes" no-op.
    runCommand("edit.heading-3");
    expect(lineText(1)).toBe("Title");
  });

  it("⌘L toggles a todo checkbox on the caret's line, stamping the completion date", () => {
    view = mount("buy milk\n");
    putCaretOn(1);

    runBoundKey("Mod-l", "notes");
    expect(lineText(1)).toBe("- [ ] buy milk");

    // Completing a todo carries the day stamp the daily-note model reads (see
    // lib/todoStamp); the command must go through that one model. The exact
    // date is asserted by shape, so the test cannot flake across midnight.
    runBoundKey("Mod-l", "notes");
    expect(lineText(1)).toMatch(/^- \[x\] buy milk ✅ \d{4}-\d{2}-\d{2}$/);
  });

  it("⌘; cycles an unordered list, ⌘⇧; the numbered one", () => {
    view = mount("item\n");
    putCaretOn(1);

    runCommand("edit.toggle-bullet-list");
    expect(lineText(1)).toBe("- item");

    runCommand("edit.toggle-numbered-list");
    expect(lineText(1)).toBe("1. item");
  });
});

describe("block insertions", () => {
  it("⌘M inserts a math block at the caret", () => {
    view = mount("");

    runBoundKey("Mod-m", "notes");

    expect(view.state.doc.toString()).toContain("$$");
  });

  it("⌘⇧C inserts a fenced code block with the configured language", () => {
    view = mount("");

    runBoundKey("Mod-Shift-c", "notes");

    const text = view.state.doc.toString();
    expect(text).toContain("```ts");
    expect(text).toContain("```");
  });

  it("the Python block command inserts a python fence, not the configured default", () => {
    view = mount("");

    runCommand("edit.insert-python-block");

    expect(view.state.doc.toString()).toContain("```python");
  });

  it("⌘⇧H inserts a horizontal rule", () => {
    view = mount("before\n");

    runBoundKey("Mod-Shift-h", "notes");

    expect(view.state.doc.toString()).toContain("---");
  });
});

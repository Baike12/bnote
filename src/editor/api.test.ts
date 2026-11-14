import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docPathField, setDocPath } from "./docPath";
import {
  activeEditors,
  editorApi,
  findEditorFor,
  focusEditor,
  getView,
  registerEditorView,
  setActiveEditor,
  unregisterEditorView,
} from "./api";

/**
 * The registry decides which editor the whole command layer acts on when the
 * page hosts two instances (study mode's content + notes columns, the project
 * board's card + daily note). Two levels are locked here:
 *
 *  - `editorApi.view` (what getView returns) is the most recently focused live
 *    instance;
 *  - `activeEditors()` is every live instance, so settings can be applied to
 *    each one (and only to instances still connected to the DOM).
 *
 * The registry is module-level state, so each test unregisters what it
 * registered; a leaked view would make "the active editor" depend on test
 * order.
 */
const created: EditorView[] = [];

function makeView(doc = "", path: string | null = null, connected = true): EditorView {
  let state = EditorState.create({ doc, extensions: [docPathField] });
  if (path !== null) state = state.update({ effects: setDocPath.of(path) }).state;
  const focus = vi.fn();
  const view = {
    state,
    dom: { isConnected: connected },
    contentDOM: { focus },
  } as unknown as EditorView;
  created.push(view);
  return view;
}

function dropAll(): void {
  for (const view of created.splice(0)) unregisterEditorView(view);
  editorApi.view = null;
}

afterEach(dropAll);

describe("registerEditorView: the freshly mounted instance becomes the command target", () => {
  it("registering sets both the active view and the live set", () => {
    const view = makeView("a");
    registerEditorView(view);
    expect(getView()).toBe(view);
    expect(activeEditors()).toEqual([view]);
  });

  it("registering a second instance moves the command target to it and keeps both live", () => {
    const first = makeView("a");
    const second = makeView("b");
    registerEditorView(first);
    registerEditorView(second);
    expect(getView()).toBe(second);
    expect(activeEditors()).toEqual([first, second]);
  });
});

describe("setActiveEditor: focus only switches between registered instances", () => {
  it("a live instance becomes the target", () => {
    const first = makeView("a");
    const second = makeView("b");
    registerEditorView(first);
    registerEditorView(second);
    setActiveEditor(first);
    expect(getView()).toBe(first);
  });

  it("an unregistered view cannot hijack the command target", () => {
    const registered = makeView("a");
    registerEditorView(registered);
    const foreign = makeView("b");
    setActiveEditor(foreign);
    expect(getView()).toBe(registered);
    expect(activeEditors()).toEqual([registered]);
  });
});

describe("unregisterEditorView: teardown clears the target only for the removed instance", () => {
  it("removing the active instance clears the target", () => {
    const view = makeView("a");
    registerEditorView(view);
    unregisterEditorView(view);
    expect(getView()).toBeNull();
    expect(activeEditors()).toEqual([]);
  });

  it("removing an inactive instance leaves the current target in place", () => {
    const first = makeView("a");
    const second = makeView("b");
    registerEditorView(first);
    registerEditorView(second);
    unregisterEditorView(first);
    expect(getView()).toBe(second);
    expect(activeEditors()).toEqual([second]);
  });
});

describe("activeEditors: a disconnected instance is not a target for settings", () => {
  it("filters DOM-disconnected instances but keeps them registered until teardown", () => {
    const live = makeView("a", null, true);
    const detached = makeView("b", null, false);
    registerEditorView(live);
    registerEditorView(detached);
    expect(activeEditors()).toEqual([live]);
    unregisterEditorView(detached);
    expect(activeEditors()).toEqual([live]);
  });
});

describe("findEditorFor: the instance holding a file", () => {
  it("returns the connected instance whose docPath matches", () => {
    const note = makeView("x", "/vault/note.md");
    const other = makeView("y", "/vault/other.md");
    registerEditorView(note);
    registerEditorView(other);
    expect(findEditorFor("/vault/note.md")).toBe(note);
    expect(findEditorFor("/vault/other.md")).toBe(other);
  });

  it("returns null when no instance holds that path", () => {
    registerEditorView(makeView("x", "/vault/note.md"));
    expect(findEditorFor("/vault/missing.md")).toBeNull();
  });

  it("returns null for an instance that is no longer connected", () => {
    registerEditorView(makeView("x", "/vault/note.md", false));
    expect(findEditorFor("/vault/note.md")).toBeNull();
  });

  it("an instance with no file open never matches", () => {
    registerEditorView(makeView("x", null));
    expect(findEditorFor("")).toBeNull();
  });
});

describe("focusEditor: changes focus without scrolling the ancestors", () => {
  it("focuses the content DOM with preventScroll", () => {
    const view = makeView();
    focusEditor(view);
    expect(view.contentDOM.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("null is a no-op", () => {
    expect(() => focusEditor(null)).not.toThrow();
  });
});

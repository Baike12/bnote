import { afterEach, describe, expect, it } from "vitest";
import {
  activeCodeEditor,
  handleForView,
  registerCodeEditor,
  setActiveCodeEditor,
  unregisterCodeEditor,
  type CodeEditorHandle,
} from "./registry";

/**
 * The command layer acts on "the code editor the user is currently using", so
 * the registry is the one owner of that answer. Two failures are locked here:
 * a closing tab must not lose the focus entirely (the neighbour takes it), and
 * a handle whose DOM is gone must never be returned — the commands would
 * dispatch into a detached view.
 */

function handle(path: string, connected = true): CodeEditorHandle {
  return {
    root: "/proj",
    path,
    language: "typescript",
    view: { dom: { isConnected: connected } } as unknown as CodeEditorHandle["view"],
  };
}

const registered: CodeEditorHandle[] = [];

function track(h: CodeEditorHandle): CodeEditorHandle {
  registerCodeEditor(h);
  registered.push(h);
  return h;
}

afterEach(() => {
  for (const h of registered.splice(0)) unregisterCodeEditor(h);
});

describe("registering code editors", () => {
  it("the last registered instance is the active one", () => {
    const a = track(handle("a.ts"));
    expect(activeCodeEditor()).toBe(a);
    const b = track(handle("b.ts"));
    expect(activeCodeEditor()).toBe(b);
  });

  it("a view maps back to its own handle, not to the focused one", () => {
    const a = track(handle("a.ts"));
    track(handle("b.ts"));
    expect(handleForView(a.view)).toBe(a);
  });

  it("an unregistered view has no handle", () => {
    expect(handleForView(handle("ghost.ts").view)).toBeNull();
  });
});

describe("unregistering code editors", () => {
  it("falls back to a live instance when the active tab closes", () => {
    const a = track(handle("a.ts"));
    const b = track(handle("b.ts"));
    unregisterCodeEditor(b);
    expect(activeCodeEditor()).toBe(a);
  });

  it("skips a detached view when picking the fallback", () => {
    const detached = track(handle("detached.ts", false));
    const alive = track(handle("alive.ts"));
    // `alive` is active; closing it must not hand the command target to the
    // detached handle that is still in the set.
    unregisterCodeEditor(alive);
    expect(activeCodeEditor()).toBeNull();
    expect(activeCodeEditor()).not.toBe(detached);
  });

  it("no instance left means no target", () => {
    const only = track(handle("only.ts"));
    unregisterCodeEditor(only);
    expect(activeCodeEditor()).toBeNull();
  });
});

describe("switching the command target", () => {
  it("focusing a live instance makes it the target", () => {
    const a = track(handle("a.ts"));
    track(handle("b.ts"));
    setActiveCodeEditor(a);
    expect(activeCodeEditor()).toBe(a);
  });

  it("focusing an instance that was never registered changes nothing", () => {
    const live = track(handle("live.ts"));
    setActiveCodeEditor(handle("stranger.ts"));
    expect(activeCodeEditor()).toBe(live);
  });

  it("null is not a target switch", () => {
    const live = track(handle("live.ts"));
    setActiveCodeEditor(null);
    expect(activeCodeEditor()).toBe(live);
  });

  it("a handle that lost its DOM is not reported as active", () => {
    const h = track(handle("a.ts", false));
    expect(activeCodeEditor()).toBeNull();
    expect(activeCodeEditor()).not.toBe(h);
  });
});

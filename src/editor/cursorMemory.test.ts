import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/appStore", () => ({
  getConfigSnapshot: () => ({
    cursorPositions: {
      "/v/restored.md": { pos: 30, scroll: 1234 },
      "/v/huge.md": { pos: 0, scroll: 99999 },
    },
  }),
  rememberCursorPosition: vi.fn(),
}));

import { rememberCursorPosition } from "@/state/appStore";
import {
  flushCursorSave,
  observeScrollSave,
  restoreSavedCursor,
  scheduleCursorSave,
} from "./cursorMemory";

type Listener = (event: { type: string }) => void;

/** Minimal view stub: saveNow only reads state.doc / selection / scrollDOM.scrollTop. */
function fakeView(doc: object) {
  const listeners = new Map<string, Set<Listener>>();
  const scrollDOM = {
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
    scrollTop: 0,
    scrollHeight: 5000,
  };
  const measures: Array<{ write?: (m: unknown, v: unknown) => void }> = [];
  const state = { doc, selection: { main: { head: 42 } } };
  const view = {
    scrollDOM,
    measures,
    requestMeasure: (req: { write?: (m: unknown, v: unknown) => void }) => {
      measures.push(req);
    },
    dispatch: (spec: { selection?: { anchor: number } }) => {
      if (spec.selection) state.selection.main.head = spec.selection.anchor;
    },
    state,
  } as unknown as import("@codemirror/view").EditorView;
  return {
    view,
    runMeasures() {
      for (const m of measures.splice(0)) m.write?.(null, view);
    },
    emitScroll() {
      for (const fn of listeners.get("scroll") ?? []) fn({ type: "scroll" });
    },
  };
}

describe("restoreSavedCursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(rememberCursorPosition).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scrollTop is written in the write phase of requestMeasure (root-cause regression: writing it directly lands in the estimated-height coordinate system and is then moved away by CM's scroll anchoring compensation)", () => {
    const { view, runMeasures } = fakeView({});
    restoreSavedCursor(view, "/v/restored.md");
    expect(view.scrollDOM.scrollTop).toBe(0); // not written synchronously
    runMeasures();
    expect(view.scrollDOM.scrollTop).toBe(1234);
  });

  it("the restored value is clamped to the real scrollHeight", () => {
    const { view, runMeasures } = fakeView({});
    restoreSavedCursor(view, "/v/huge.md");
    runMeasures();
    expect(view.scrollDOM.scrollTop).toBe(5000);
  });

  it("a file with no remembered position is neither written nor queued", () => {
    const { view, runMeasures } = fakeView({});
    restoreSavedCursor(view, "/v/unknown.md");
    runMeasures();
    expect(view.scrollDOM.scrollTop).toBe(0);
  });
});

describe("cursorMemory scroll position saving", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(rememberCursorPosition).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a pure scroll (no transaction) also triggers a position save: root-cause regression — the old implementation only hooked selectionSet/docChanged, so a position reached by wheel scrolling was never recorded", () => {
    const { view, emitScroll } = fakeView({});
    view.scrollDOM.scrollTop = 1234;
    const dispose = observeScrollSave(view, () => "/v/a.md");

    emitScroll();
    // the scroll event itself does not write; the 300ms debounce trailing edge writes once
    expect(rememberCursorPosition).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);

    expect(rememberCursorPosition).toHaveBeenCalledWith("/v/a.md", 42, 1234);
    dispose();
  });

  it("a queued pending save is voided after the document changes: inside the openNote document-switch window the old path's timer must not write the new document's position into the old path", () => {
    const docA = {};
    const docB = {};
    const { view, emitScroll } = fakeView(docA);
    const dispose = observeScrollSave(view, () => "/v/a.md");

    emitScroll();
    // simulate loadDocument swapping the document (same view, doc reference replaced)
    (view.state as { doc: object }).doc = docB;
    vi.advanceTimersByTime(1000);

    expect(rememberCursorPosition).not.toHaveBeenCalled();
    dispose();
  });

  it("flush writes immediately without waiting for the debounce; after unloading, scrolling no longer triggers a save", () => {
    const { view, emitScroll } = fakeView({});
    scheduleCursorSave("/v/b.md", view);
    flushCursorSave();
    expect(rememberCursorPosition).toHaveBeenCalledWith("/v/b.md", 42, 0);

    const dispose = observeScrollSave(view, () => "/v/b.md");
    dispose();
    emitScroll();
    vi.advanceTimersByTime(1000);
    expect(rememberCursorPosition).toHaveBeenCalledTimes(1);
  });

  it("scrolling with no current file is not saved", () => {
    const { view, emitScroll } = fakeView({});
    const dispose = observeScrollSave(view, () => null);

    emitScroll();
    vi.advanceTimersByTime(1000);
    expect(rememberCursorPosition).not.toHaveBeenCalled();
    dispose();
  });
});

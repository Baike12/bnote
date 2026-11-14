import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The key-latency probe is the only measurement of what the user actually
 * feels (keydown → presented frame), so its gates are the contract:
 *
 *   - an IME composition key and a bare modifier are not editor input;
 *   - level `off` costs no allocation at all;
 *   - a key below the threshold records nothing, a slow key records the doc
 *     context and the phase spans of its own window;
 *   - the update listener only fills the first update and never overwrites it.
 *
 * CodeMirror's view is faked at the extension boundary: the probe's behavior
 * lives in the listeners it installs, not in the editor itself.
 */

const cm = vi.hoisted(() => ({
  pluginClasses: [] as unknown[],
  updateListeners: [] as ((u: unknown) => void)[],
}));

vi.mock("@codemirror/view", () => ({
  EditorView: {
    updateListener: {
      of: (fn: (u: unknown) => void) => cm.updateListeners.push(fn) ?? { listener: fn },
    },
  },
  ViewPlugin: {
    fromClass: (cls: unknown) => {
      cm.pluginClasses.push(cls);
      return { plugin: cls };
    },
  },
}));

import { clearPerf, perfEvents, setPerfLevel } from "./trace";
import { editorPerfProbe } from "./editorProbe";

type Plugin = {
  onKeyDown: (event: KeyboardEvent) => void;
  destroy: () => void;
};

type FakeView = {
  contentDOM: {
    listeners: Map<string, (event: unknown) => void>;
    addEventListener: (type: string, fn: (event: unknown) => void) => void;
    removeEventListener: (type: string, fn: (event: unknown) => void) => void;
  };
  state: { doc: { lines: number; length: number } };
};

function fakeView(): FakeView {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    contentDOM: {
      listeners,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    },
    state: { doc: { lines: 12, length: 480 } },
  };
}

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "a",
    keyCode: 65,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent;
}

function install(view: FakeView): Plugin {
  const Ctor = cm.pluginClasses[cm.pluginClasses.length - 1] as new (v: FakeView) => Plugin;
  return new Ctor(view);
}

let now = 0;
const rafQueue: (() => void)[] = [];
const timeoutQueue: (() => void)[] = [];

beforeEach(() => {
  now = 0;
  rafQueue.length = 0;
  timeoutQueue.length = 0;
  cm.pluginClasses.length = 0;
  cm.updateListeners.length = 0;
  setPerfLevel("slow");
  clearPerf();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  // The probe's measurement ends "after the presented frame" via rAF + a 0ms
  // timeout; both are captured so the test can present the frame itself and
  // keep the clock under its own control.
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("setTimeout", (cb: () => void) => {
    timeoutQueue.push(cb);
    return timeoutQueue.length;
  });
  editorPerfProbe();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run the rAF + setTimeout pair the probe schedules after a keydown. */
function presentFrame(): void {
  for (const cb of rafQueue.splice(0)) cb();
  for (const cb of timeoutQueue.splice(0)) cb();
}

/** The key records of the trace (a level change is an `event`, not a key). */
function keyRecords() {
  return perfEvents().filter((e) => e.kind === "key");
}

describe("keydown gating", () => {
  it("ignores a modifier key, an IME composition key and a composing key", () => {
    const view = fakeView();
    const plugin = install(view);

    plugin.onKeyDown(keyEvent({ key: "Shift" }));
    plugin.onKeyDown(keyEvent({ keyCode: 229 }));
    plugin.onKeyDown(keyEvent({ isComposing: true }));

    expect(rafQueue).toEqual([]);
  });

  it("level off installs no measurement at all", () => {
    setPerfLevel("off");
    const plugin = install(fakeView());

    plugin.onKeyDown(keyEvent());

    expect(rafQueue).toEqual([]);
  });

  it("a normal key starts a measurement", () => {
    const plugin = install(fakeView());
    plugin.onKeyDown(keyEvent());
    expect(rafQueue).toHaveLength(1);
  });

  it("a composition marks the following key and compositionend clears it again", () => {
    const view = fakeView();
    const plugin = install(view);
    view.contentDOM.listeners.get("compositionstart")?.({});
    plugin.onKeyDown(keyEvent());

    now = 80;
    presentFrame();

    expect(keyRecords()[0]?.data).toMatchObject({ composing: true });

    view.contentDOM.listeners.get("compositionend")?.({});
    clearPerf();
    plugin.onKeyDown(keyEvent());
    now = 160;
    presentFrame();
    expect(keyRecords()[0]?.data).toMatchObject({ composing: false });
  });
});

describe("thresholds", () => {
  it("a fast key records nothing in slow mode", () => {
    const plugin = install(fakeView());
    plugin.onKeyDown(keyEvent());
    now = 10;
    presentFrame();
    expect(perfEvents()).toEqual([]);
  });

  it("a slow key records the key name, duration and document context", () => {
    const plugin = install(fakeView());
    plugin.onKeyDown(keyEvent({ key: "j" }));
    now = 120;
    presentFrame();

    const [record] = keyRecords();
    expect(record).toMatchObject({ kind: "key", name: "j", ms: 120 });
    expect(record?.data).toMatchObject({
      composing: false,
      docLines: 12,
      docBytes: 480,
      transactions: 0,
    });
  });

  it("a full trace records every key, including the fast ones", () => {
    setPerfLevel("full");
    const plugin = install(fakeView());
    plugin.onKeyDown(keyEvent({ key: "x" }));
    now = 1;
    presentFrame();
    expect(keyRecords()).toHaveLength(1);
  });
});

describe("update listener", () => {
  it("fills the first update time and the transaction count of the pending key", () => {
    const view = fakeView();
    const plugin = install(view);
    plugin.onKeyDown(keyEvent());

    now = 15;
    const listener = cm.updateListeners[cm.updateListeners.length - 1];
    listener?.({ view, docChanged: true, selectionSet: false, transactions: [{ a: 1 }, { b: 2 }] });
    listener?.({ view, docChanged: true, selectionSet: false, transactions: [{ c: 3 }] });

    now = 60;
    presentFrame();
    expect(keyRecords()[0]?.data).toMatchObject({ updateMs: 15, transactions: 2 });
  });

  it("ignores an update that changes neither the document nor the selection", () => {
    const view = fakeView();
    const plugin = install(view);
    plugin.onKeyDown(keyEvent());

    const listener = cm.updateListeners[cm.updateListeners.length - 1];
    listener?.({ view, docChanged: false, selectionSet: false, transactions: [] });

    now = 70;
    presentFrame();
    expect(keyRecords()[0]?.data).toMatchObject({ updateMs: null, transactions: 0 });
  });

  it("an update of another view does not touch the pending key", () => {
    const view = fakeView();
    const plugin = install(view);
    plugin.onKeyDown(keyEvent());

    const listener = cm.updateListeners[cm.updateListeners.length - 1];
    listener?.({
      view: fakeView(),
      docChanged: true,
      selectionSet: true,
      transactions: [{ x: 1 }],
    });

    now = 70;
    presentFrame();
    expect(keyRecords()[0]?.data).toMatchObject({ updateMs: null });
  });
});

describe("destroy", () => {
  it("removes all three listeners", () => {
    const view = fakeView();
    const plugin = install(view);
    expect([...view.contentDOM.listeners.keys()]).toEqual([
      "keydown",
      "compositionstart",
      "compositionend",
    ]);

    plugin.destroy();

    expect(view.contentDOM.listeners.size).toBe(0);
  });
});

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

/** 最小 view 桩:saveNow 只读 state.doc / selection / scrollDOM.scrollTop。 */
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

  it("scrollTop 走 requestMeasure 的 write 阶段写(根因回归:直写落在估算高度坐标系,随后被 CM 滚动锚定补偿挪走)", () => {
    const { view, runMeasures } = fakeView({});
    restoreSavedCursor(view, "/v/restored.md");
    expect(view.scrollDOM.scrollTop).toBe(0); // 同步未写
    runMeasures();
    expect(view.scrollDOM.scrollTop).toBe(1234);
  });

  it("恢复值按真实 scrollHeight 夹紧", () => {
    const { view, runMeasures } = fakeView({});
    restoreSavedCursor(view, "/v/huge.md");
    runMeasures();
    expect(view.scrollDOM.scrollTop).toBe(5000);
  });

  it("没有记忆的文件不写、不排队", () => {
    const { view, runMeasures } = fakeView({});
    restoreSavedCursor(view, "/v/unknown.md");
    runMeasures();
    expect(view.scrollDOM.scrollTop).toBe(0);
  });
});

describe("cursorMemory 滚动位置保存", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(rememberCursorPosition).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("纯滚动(无事务)也触发位置保存:根因回归——旧实现只挂 selectionSet/docChanged,滚轮阅读的位置永远不会被记下", () => {
    const { view, emitScroll } = fakeView({});
    view.scrollDOM.scrollTop = 1234;
    const dispose = observeScrollSave(view, () => "/v/a.md");

    emitScroll();
    // 滚动事件本身不落盘,300ms 防抖尾随落一次
    expect(rememberCursorPosition).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);

    expect(rememberCursorPosition).toHaveBeenCalledWith("/v/a.md", 42, 1234);
    dispose();
  });

  it("换文档后排队中的待存作废:openNote 换文档窗口里,旧路径的定时器不能把新文档的位置写进旧路径", () => {
    const docA = {};
    const docB = {};
    const { view, emitScroll } = fakeView(docA);
    const dispose = observeScrollSave(view, () => "/v/a.md");

    emitScroll();
    // 模拟 loadDocument 换文档(同一 view,doc 引用替换)
    (view.state as { doc: object }).doc = docB;
    vi.advanceTimersByTime(1000);

    expect(rememberCursorPosition).not.toHaveBeenCalled();
    dispose();
  });

  it("flush 立即落盘,不等防抖;卸载后滚动不再触发保存", () => {
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

  it("无当前文件时滚动不保存", () => {
    const { view, emitScroll } = fakeView({});
    const dispose = observeScrollSave(view, () => null);

    emitScroll();
    vi.advanceTimersByTime(1000);
    expect(rememberCursorPosition).not.toHaveBeenCalled();
    dispose();
  });
});

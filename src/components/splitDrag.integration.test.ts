import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSplitDrag } from "./splitDrag";

/**
 * Divider drags write CSS variables only: the panes hold CodeMirror
 * instances, so a 60 Hz React render is not an option. The preference is
 * committed once on pointerup. A pointermove is not a frame boundary — the
 * write and the consumer report run at most once per frame — so the frame
 * scheduler is the fixture here.
 */

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function flushFrames(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(performance.now());
}

interface Setup {
  host: HTMLDivElement;
  handle: HTMLDivElement;
  event: ReactPointerEvent<HTMLElement>;
}

function setup(clientX = 100, clientY = 100): Setup {
  const host = document.createElement("div");
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 0, left: 0, right: 300, bottom: 400, width: 300, height: 400 }),
  });
  const handle = document.createElement("div");
  document.body.append(host, handle);
  const preventDefault = vi.fn();
  const event = {
    preventDefault,
    currentTarget: handle,
    pointerId: 1,
    clientX,
    clientY,
  } as unknown as ReactPointerEvent<HTMLElement>;
  return { host, handle, event };
}

function move(clientX: number, clientY = 0): void {
  const event = new Event("pointermove");
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  window.dispatchEvent(event);
}

function up(): void {
  window.dispatchEvent(new Event("pointerup"));
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("startSplitDrag", () => {
  it("batches several pointer moves into one write and one report per frame", () => {
    const { host, handle, event } = setup();
    const onMove = vi.fn();
    const commit = vi.fn();
    const compute = vi.fn((delta: number) => ({ "--a": 200 + delta, "--b": 100 - delta }));

    startSplitDrag({
      event,
      host,
      variables: ["--a", "--b"],
      stored: { "--a": 200, "--b": 100 },
      compute,
      commit,
      onMove,
    });

    expect(handle.classList.contains("dragging")).toBe(true);
    move(150);
    move(160);
    move(170);
    // Nothing is written before the frame: the handler only records O(1) state.
    expect(host.style.getPropertyValue("--a")).toBe("");
    expect(onMove).not.toHaveBeenCalled();

    flushFrames();
    expect(host.style.getPropertyValue("--a")).toBe("270px");
    expect(host.style.getPropertyValue("--b")).toBe("30px");
    expect(compute).toHaveBeenLastCalledWith(70);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();

    up();
  });

  it("commits the pointer's final position when it arrived after the last frame", () => {
    const { host, event } = setup();
    const onMove = vi.fn();
    const commit = vi.fn();

    startSplitDrag({
      event,
      host,
      variables: ["--a"],
      stored: { "--a": 200 },
      compute: (delta) => ({ "--a": 200 + delta }),
      commit,
      onMove,
    });

    move(120);
    flushFrames();
    move(140); // never painted: the drag ends between two frames
    up();

    expect(host.style.getPropertyValue("--a")).toBe("240px");
    expect(commit).toHaveBeenCalledWith({ "--a": 240 });
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it("restores the stored values when a click changed nothing", () => {
    const { host, handle, event } = setup();
    const commit = vi.fn();
    const onMove = vi.fn();

    startSplitDrag({
      event,
      host,
      variables: ["--a"],
      stored: { "--a": 200 },
      compute: (delta) => ({ "--a": 200 + delta }),
      commit,
      onMove,
    });

    move(100); // zero offset
    up();

    expect(host.style.getPropertyValue("--a")).toBe("200px");
    expect(commit).not.toHaveBeenCalled();
    expect(handle.classList.contains("dragging")).toBe(false);

    // A click with no move at all paints nothing.
    const plain = setup();
    startSplitDrag({
      event: plain.event,
      host: plain.host,
      variables: ["--a"],
      stored: { "--a": 200 },
      compute: () => ({ "--a": 300 }),
      commit,
      onMove,
    });
    up();
    expect(plain.host.style.getPropertyValue("--a")).toBe("");
    expect(commit).not.toHaveBeenCalled();
  });

  it("measures the y axis for row heights", () => {
    const { host, event } = setup(100, 100);
    const compute = vi.fn((delta: number) => ({ "--h": 300 - delta }));

    startSplitDrag({
      event,
      host,
      variables: ["--h"],
      stored: { "--h": 300 },
      compute,
      commit: vi.fn(),
      axis: "y",
    });

    move(100, 160);
    flushFrames();
    expect(compute).toHaveBeenLastCalledWith(60);
    up();
  });

  it("ignores a collapsed host and a missing host", () => {
    const collapsed = setup();
    Object.defineProperty(collapsed.host, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    });
    const event = collapsed.event;
    startSplitDrag({
      event,
      host: collapsed.host,
      variables: ["--a"],
      stored: {},
      compute: () => ({}),
      commit: vi.fn(),
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(collapsed.handle.classList.contains("dragging")).toBe(false);

    startSplitDrag({
      event,
      host: null,
      variables: ["--a"],
      stored: {},
      compute: () => ({}),
      commit: vi.fn(),
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

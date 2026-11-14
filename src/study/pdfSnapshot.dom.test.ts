/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canvasToFile,
  capturePdfSnapshot,
  hasPdfSnapshotSource,
  paintSnapshot,
  registerPdfSnapshotSource,
  snapshotRect,
  type SnapshotColors,
  type SnapshotPlan,
  type SnapshotRect,
} from "./pdfSnapshot";

/**
 * The snapshot pipeline has a pure geometry half (`planSnapshot`, covered in
 * pdfSnapshot.test.ts) and a DOM half: measuring, painting and the registered
 * source. The DOM half runs against a stubbed 2D context, because jsdom has no
 * canvas backend: the assertions are the exact draw calls and colors the
 * reader must produce, not pixels.
 */

const rect = (left: number, top: number, width: number, height: number): SnapshotRect => ({
  left,
  top,
  width,
  height,
});

const COLORS: SnapshotColors = {
  background: "#111111",
  paper: "#ffffff",
  tint: null,
  highlight: "rgba(255, 224, 0, 0.42)",
  note: "rgba(0, 140, 255, 0.42)",
};

interface DrawCall {
  op: "fillRect" | "drawImage" | "clip";
  args: number[];
}

interface FakeContext {
  fillStyle: string;
  globalCompositeOperation: string;
  calls: DrawCall[];
  fills: string[];
  fillRect: (x: number, y: number, w: number, h: number) => void;
  drawImage: (...args: unknown[]) => void;
  save: () => void;
  restore: () => void;
  beginPath: () => void;
  rect: (x: number, y: number, w: number, h: number) => void;
  clip: () => void;
}

function fakeContext(): FakeContext {
  const calls: DrawCall[] = [];
  const fills: string[] = [];
  const ctx: FakeContext = {
    fillStyle: "",
    globalCompositeOperation: "source-over",
    calls,
    fills,
    fillRect: (x, y, w, h) => {
      calls.push({ op: "fillRect", args: [x, y, w, h] });
      fills.push(ctx.fillStyle);
    },
    drawImage: (...args: unknown[]) => {
      calls.push({ op: "drawImage", args: args.slice(1) as number[] });
    },
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {
      calls.push({ op: "clip", args: [] });
    },
  };
  return ctx;
}

/** Install a canvas element whose 2D context is the fake, and return the fake. */
function stubCanvas(width = 0, height = 0): { canvas: HTMLCanvasElement; ctx: FakeContext } {
  const ctx = fakeContext();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  Object.defineProperty(canvas, "getContext", { configurable: true, value: () => ctx });
  return { canvas, ctx };
}

const createElement = document.createElement.bind(document);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("snapshotRect", () => {
  it("takes exactly the four layout fields from the bounding box", () => {
    const el = document.createElement("div");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      width: 300,
      height: 400,
      right: 310,
      bottom: 420,
      x: 10,
      y: 20,
      toJSON() {},
    });

    expect(snapshotRect(el)).toEqual(rect(10, 20, 300, 400));
  });
});

describe("paintSnapshot", () => {
  /** Two pages: page 0 fully visible, page 1 starting at y=414. */
  const plan: SnapshotPlan = {
    width: 1000,
    height: 1600,
    scale: 2,
    origin: { left: 0, top: 0 },
    pages: [
      {
        page: 0,
        src: rect(0, 0, 1000, 800),
        dest: rect(0, 0, 1000, 800),
        sheet: rect(0, 0, 1000, 1500),
        annotations: [],
      },
      {
        page: 1,
        src: rect(0, 0, 1000, 800),
        dest: rect(0, 828, 1000, 800),
        sheet: rect(0, 828, 1000, 1500),
        annotations: [],
      },
    ],
  };

  it("fills the background first and paints both page fragments at the planned destination", () => {
    const output = stubCanvas();
    const page0 = stubCanvas(1000, 1500);
    const page1 = stubCanvas(1000, 1500);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
      tag === "canvas" ? output.canvas : createElement(tag),
    );

    const canvas = paintSnapshot(plan, [page0.canvas, page1.canvas], COLORS);

    expect(canvas).toBe(output.canvas);
    expect(canvas.width).toBe(1000);
    expect(canvas.height).toBe(1600);
    // The first fill is the scroll background over the whole output.
    expect(output.ctx.calls[0]).toEqual({ op: "fillRect", args: [0, 0, 1000, 1600] });
    expect(output.ctx.fills[0]).toBe(COLORS.background);
    // Each page gets a paper underlay, then its canvas pixels move across.
    expect(output.ctx.fills).toContain(COLORS.paper);
    const draws = output.ctx.calls.filter((c) => c.op === "drawImage");
    expect(draws).toHaveLength(2);
    expect(draws[0].args).toEqual([0, 0, 1000, 800, 0, 0, 1000, 800]);
    expect(draws[1].args).toEqual([0, 0, 1000, 800, 0, 828, 1000, 800]);
  });

  it("skips a page whose canvas is missing or still zero wide (a render that has not finished)", () => {
    const output = stubCanvas();
    const empty = document.createElement("canvas");
    empty.width = 0;
    empty.height = 0;
    Object.defineProperty(empty, "getContext", { configurable: true, value: () => fakeContext() });
    vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
      tag === "canvas" ? output.canvas : createElement(tag),
    );

    paintSnapshot(plan, [empty], COLORS);

    expect(output.ctx.calls.filter((c) => c.op === "drawImage")).toHaveLength(0);
  });

  it("repaints highlights and notes in whole-page coordinates inside the page clip", () => {
    const output = stubCanvas();
    const source = stubCanvas(1000, 1500);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
      tag === "canvas" ? output.canvas : createElement(tag),
    );
    const annotated: SnapshotPlan = {
      ...plan,
      pages: [
        {
          ...plan.pages[0],
          annotations: [
            { kind: "highlight", rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.01 }] },
            { kind: "note", rects: [{ x: 0.2, y: 0.3, w: 0.1, h: 0.02 }] },
          ],
        },
      ],
    };

    paintSnapshot(annotated, [source.canvas], COLORS);

    // The sheet is 1000x1500 in output pixels: 0.1/0.2/0.5/0.01 = 100/300/500/15.
    expect(output.ctx.fills).toContain(COLORS.highlight);
    expect(output.ctx.fills).toContain(COLORS.note);
    const highlight = output.ctx.calls.find(
      (c) =>
        c.op === "fillRect" &&
        c.args[0] === 100 &&
        c.args[1] === 300 &&
        c.args[2] === 500 &&
        Math.round(c.args[3]) === 15,
    );
    expect(highlight).toBeDefined();
    // Annotations are clipped to the page fragment so a highlight cannot bleed into the gap.
    expect(output.ctx.calls.filter((c) => c.op === "clip")).toHaveLength(1);
  });

  it("paints the eye-care tint over the page last, under multiply", () => {
    const output = stubCanvas();
    const source = stubCanvas(1000, 1500);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
      tag === "canvas" ? output.canvas : createElement(tag),
    );

    paintSnapshot(plan, [source.canvas], { ...COLORS, tint: "rgba(220, 235, 214, 0.55)" });

    expect(output.ctx.fills).toContain("rgba(220, 235, 214, 0.55)");
  });

  it("throws a message the UI can show when the output context is unavailable", () => {
    const output = document.createElement("canvas");
    Object.defineProperty(output, "getContext", { configurable: true, value: () => null });
    vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
      tag === "canvas" ? output : createElement(tag),
    );

    expect(() => paintSnapshot(plan, [], COLORS)).toThrow("canvas 不可用");
  });
});

describe("canvasToFile", () => {
  it("encodes the canvas as a PNG file named for the reading snapshot", async () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: (callback: (blob: Blob | null) => void) => {
        callback(new Blob(["png"], { type: "image/png" }));
      },
    });

    const file = await canvasToFile(canvas);

    expect(file.name).toBe("reading-snapshot.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
  });

  it("a failed encode rejects instead of sending an empty request", async () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: (callback: (blob: Blob | null) => void) => {
        callback(null);
      },
    });

    await expect(canvasToFile(canvas)).rejects.toThrow("截图编码失败");
  });
});

describe("the registered snapshot source", () => {
  it("there is no source before a reader mounts, and capture resolves null", async () => {
    expect(hasPdfSnapshotSource()).toBe(false);
    await expect(capturePdfSnapshot()).resolves.toBeNull();
  });

  it("the mounted reader's callback is what capture returns", async () => {
    const file = new File(["x"], "a.png", { type: "image/png" });
    const source = vi.fn(async () => file);

    const unregister = registerPdfSnapshotSource(source);

    expect(hasPdfSnapshotSource()).toBe(true);
    await expect(capturePdfSnapshot()).resolves.toBe(file);
    expect(source).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("unregistering only clears the source it registered (a remounted reader keeps its own)", async () => {
    const first = vi.fn(async () => null);
    const second = vi.fn(async () => null);
    const unregisterFirst = registerPdfSnapshotSource(first);
    registerPdfSnapshotSource(second);

    // The first reader unmounted after the second registered: it must not clear the live one.
    unregisterFirst();

    expect(hasPdfSnapshotSource()).toBe(true);
    await capturePdfSnapshot();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

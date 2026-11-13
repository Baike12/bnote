import { beforeEach, describe, expect, it } from "vitest";
import { clampPx, lineBandsAtY, pageMetrics, snapFlipToLine, spanRects } from "./geometry";

/**
 * PDF geometry is one batched layout read followed by pure arithmetic. The
 * boundaries that matter: page offsets use the scroll content's coordinate
 * space, tiny/empty span rectangles are not lines, and a boundary in a page
 * gap or margin produces no line (the landing spot is then left as is).
 */

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rect({ left, top, right, bottom }: Box) {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function setRect(el: Element, box: Box): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(box),
  });
}

function span(boxes: Box[]): HTMLSpanElement {
  const el = document.createElement("span");
  Object.defineProperty(el, "getClientRects", {
    configurable: true,
    value: () => boxes.map(rect),
  });
  return el;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("clampPx", () => {
  it("clamps into [0, size]", () => {
    expect(clampPx(-5, 100)).toBe(0);
    expect(clampPx(40, 100)).toBe(40);
    expect(clampPx(140, 100)).toBe(100);
  });
});

describe("pageMetrics", () => {
  it("converts viewport rectangles to scroll-content coordinates", () => {
    const scroll = document.createElement("div");
    scroll.scrollTop = 500;
    setRect(scroll, { left: 0, top: 100, right: 600, bottom: 900 });

    const first = document.createElement("div");
    setRect(first, { left: 0, top: 150, right: 600, bottom: 950 });
    const third = document.createElement("div");
    setRect(third, { left: 0, top: 1000, right: 600, bottom: 1800 });

    const metrics = pageMetrics(
      scroll,
      new Map([
        [1, first],
        [3, third],
      ]),
    );
    expect(metrics).toEqual([
      { page: 1, top: 550, height: 800 },
      { page: 3, top: 1400, height: 800 },
    ]);
  });
});

describe("spanRects", () => {
  it("keeps real line rectangles and drops empty ones", () => {
    const textLayer = document.createElement("div");
    textLayer.append(
      span([
        { left: 10, top: 20, right: 110, bottom: 40 },
        { left: 10, top: 40, right: 10.4, bottom: 41 }, // hairline: not a line
      ]),
      span([{ left: 10, top: 60, right: 90, bottom: 60.4 }]), // zero height
    );

    expect(spanRects(textLayer)).toEqual([{ left: 10, top: 20, right: 110, bottom: 40 }]);
  });

  it("returns every client rectangle of a span (a wrapped line has several)", () => {
    const textLayer = document.createElement("div");
    textLayer.append(
      span([
        { left: 10, top: 20, right: 200, bottom: 40 },
        { left: 10, top: 40, right: 120, bottom: 60 },
      ]),
    );
    expect(spanRects(textLayer)).toHaveLength(2);
  });
});

function pdfPage(box: Box, texts: HTMLSpanElement[] | null): HTMLDivElement {
  const page = document.createElement("div");
  page.className = "pdf-page";
  setRect(page, box);
  if (texts) {
    const layer = document.createElement("div");
    layer.className = "textLayer";
    layer.append(...texts);
    page.append(layer);
  }
  return page;
}

describe("lineBandsAtY", () => {
  it("returns only the text lines crossing the boundary inside a page", () => {
    const scroll = document.createElement("div");
    const crossing = span([{ left: 10, top: 195, right: 400, bottom: 205 }]);
    const above = span([{ left: 10, top: 150, right: 400, bottom: 180 }]);
    const marginOnly = span([{ left: 600, top: 195, right: 700, bottom: 205 }]);
    scroll.append(
      pdfPage({ left: 0, top: 100, right: 500, bottom: 900 }, [crossing, above, marginOnly]),
    );
    document.body.append(scroll);

    expect(lineBandsAtY(scroll, 200)).toEqual([{ top: 195, bottom: 205 }]);
  });

  it("returns no line for a page gap or a page without a text layer", () => {
    const scroll = document.createElement("div");
    scroll.append(
      pdfPage({ left: 0, top: 100, right: 500, bottom: 300 }, [span([])]),
      pdfPage({ left: 0, top: 400, right: 500, bottom: 900 }, null),
    );
    document.body.append(scroll);

    expect(lineBandsAtY(scroll, 350)).toEqual([]);
    expect(lineBandsAtY(scroll, 500)).toEqual([]);
  });
});

describe("snapFlipToLine", () => {
  it("aligns the crossing line's near edge with the read boundary", () => {
    const scroll = document.createElement("div");
    const page = pdfPage({ left: 0, top: 0, right: 500, bottom: 1000 }, [
      span([{ left: 10, top: 195, right: 400, bottom: 205 }]),
    ]);
    scroll.append(page);
    document.body.append(scroll);
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 1000 });

    // step 0.5 -> boundary at 100 + 200 * 50% = 200; the top edge is 5px off,
    // inside the 8px tolerance (2% of the 400px viewport).
    expect(snapFlipToLine(scroll, 500, 0.5)).toBe(495);
  });

  it("keeps the position when the boundary falls into a margin", () => {
    const scroll = document.createElement("div");
    scroll.append(pdfPage({ left: 0, top: 0, right: 500, bottom: 1000 }, [span([])]));
    document.body.append(scroll);
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 1000 });

    expect(snapFlipToLine(scroll, 500, 0.5)).toBe(500);
  });
});

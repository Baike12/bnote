import { describe, expect, it } from "vitest";
import {
  createReadPositionStore,
  emptyReadPositions,
  normalizeReadPositions,
  parseReadPositions,
  pdfPositionAt,
  scrollTopForPdfPosition,
  type PageMetric,
} from "./readPositions";

const pages: PageMetric[] = [
  { page: 1, top: 14, height: 1000 },
  { page: 2, top: 1028, height: 1000 },
  { page: 3, top: 2042, height: 800 },
];

describe("the read position data", () => {
  it("a bad file or bad field falls back to an empty position without crashing", () => {
    expect(parseReadPositions(null)).toEqual(emptyReadPositions());
    expect(parseReadPositions("{oops")).toEqual(emptyReadPositions());
    expect(parseReadPositions("[]")).toEqual(emptyReadPositions());
    expect(
      normalizeReadPositions({
        pdfs: {
          "a.pdf": { page: 0, offset: 2, at: 1 },
          "b.pdf": { page: 3.9, offset: 0.25, at: 2 },
          bad: "nope",
        },
        urls: { "https://a": { ratio: 1.5, at: 3 } },
      }),
    ).toEqual({
      version: 1,
      pdfs: { "b.pdf": { page: 3, offset: 0.25, at: 2 } },
      urls: { "https://a": { ratio: 1, at: 3 } },
    });
  });

  it("only the most recent 500 entries are kept", () => {
    const pdfs: Record<string, { page: number; offset: number; at: number }> = {};
    for (let i = 0; i < 520; i++) {
      pdfs[`f${i}.pdf`] = { page: 1, offset: 0, at: i };
    }
    const out = normalizeReadPositions({ pdfs, urls: {} });
    expect(Object.keys(out.pdfs)).toHaveLength(500);
    expect(out.pdfs["f0.pdf"]).toBeUndefined();
    expect(out.pdfs["f519.pdf"]).toBeDefined();
  });
});

describe("PDF position conversion", () => {
  it("it takes the last page whose top edge passed the viewport and computes the in-page offset from the page height", () => {
    expect(pdfPositionAt(pages, 14)).toMatchObject({ page: 1, offset: 0 });
    expect(pdfPositionAt(pages, 514)).toMatchObject({ page: 1, offset: 0.5 });
    expect(pdfPositionAt(pages, 1028)).toMatchObject({ page: 2, offset: 0 });
    expect(pdfPositionAt(pages, 1400)).toMatchObject({ page: 2, offset: 372 / 1000 });
    expect(pdfPositionAt([], 100)).toBeNull();
  });

  it("the gap between pages counts as the end of the previous page, the offset is clamped to 0..1", () => {
    // The bottom of page 1 is 1014, the top of page 2 is 1028; scrolling to 1020 (the gap) still belongs to page 1.
    expect(pdfPositionAt(pages, 1020)).toMatchObject({ page: 1, offset: 1 });
    expect(pdfPositionAt(pages, 99999)).toMatchObject({ page: 3, offset: 1 });
  });

  it("scrollTop is computed back from the page number and offset; a page number that does not exist returns null", () => {
    expect(scrollTopForPdfPosition(pages, { page: 2, offset: 0.25 })).toBe(1278);
    expect(scrollTopForPdfPosition(pages, { page: 9, offset: 0 })).toBeNull();
  });

  // Dragging the column width / zooming scales the pages proportionally: the
  // page height changes, so the same scrollTop points at completely different
  // content (measured: at 981px wide scrollTop=2900 is on page 3 at 53%,
  // after narrowing to 390px the same scrollTop lands on page 6 at 632%).
  // Before and after a reflow the position must be converted by "page number
  // + in-page ratio", not by reusing the pixel value.
  it("before and after a reflow the position is converted by page number and ratio: the same content still rests at the top of the viewport", () => {
    const GAP = 58;
    const build = (height: number, count: number): PageMetric[] =>
      Array.from({ length: count }, (_, i) => ({
        page: i + 1,
        top: 14 + i * (height + GAP),
        height,
      }));
    const wide = build(1244, 9);
    const narrow = build(531, 9);
    // Wide layout: the viewport top rests on page 3, 80% into the page.
    const top = wide[2].top + 0.8 * wide[2].height;
    const anchor = pdfPositionAt(wide, top);
    expect(anchor).toMatchObject({ page: 3 });
    expect(anchor?.offset).toBeCloseTo(0.8, 4);
    // Narrow layout: the same anchor still lands on page 3, still 80% into the page.
    const restored = scrollTopForPdfPosition(narrow, anchor!)!;
    expect(pdfPositionAt(narrow, restored)).toMatchObject({ page: 3 });
    expect(pdfPositionAt(narrow, restored)?.offset).toBeCloseTo(0.8, 4);
    // Control: reusing the old pixel value jumps to page 7 (which is why the user had to scroll again).
    expect(pdfPositionAt(narrow, top)?.page).toBe(7);
  });

  it("saving goes through the same file, the payload carries the page number and offset", async () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const store = createReadPositionStore({
      read: async (path) => {
        const raw = files.get(path);
        if (raw === undefined) throw new Error("not found");
        return raw;
      },
      write: async (path, text) => {
        writes.push(path);
        files.set(path, text);
      },
    });
    await store.load("/vault", "positions");
    store.update("/vault", "positions", (data) => ({
      ...data,
      pdfs: { "papers/a.pdf": { page: 4, offset: 0.5, at: 7 } },
    }));
    store.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes[0]).toBe("/vault/.bnote/read-positions.json");
    expect(JSON.parse(files.get(writes[0]) ?? "{}")).toMatchObject({
      pdfs: { "papers/a.pdf": { page: 4, offset: 0.5 } },
    });
  });
});

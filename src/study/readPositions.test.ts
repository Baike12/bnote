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

describe("阅读位置数据", () => {
  it("坏文件/坏字段退回空位置,不崩", () => {
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

  it("只保留最近的 500 条", () => {
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

describe("PDF 位置换算", () => {
  it("取顶边越过视口的最后一页,并按页高算页内偏移", () => {
    expect(pdfPositionAt(pages, 14)).toMatchObject({ page: 1, offset: 0 });
    expect(pdfPositionAt(pages, 514)).toMatchObject({ page: 1, offset: 0.5 });
    expect(pdfPositionAt(pages, 1028)).toMatchObject({ page: 2, offset: 0 });
    expect(pdfPositionAt(pages, 1400)).toMatchObject({ page: 2, offset: 372 / 1000 });
    expect(pdfPositionAt([], 100)).toBeNull();
  });

  it("页间空隙算上一页的末尾,偏移夹在 0..1", () => {
    // The bottom of page 1 is 1014, the top of page 2 is 1028; scrolling to 1020 (the gap) still belongs to page 1.
    expect(pdfPositionAt(pages, 1020)).toMatchObject({ page: 1, offset: 1 });
    expect(pdfPositionAt(pages, 99999)).toMatchObject({ page: 3, offset: 1 });
  });

  it("按页码+偏移反算 scrollTop;页码不存在返回 null", () => {
    expect(scrollTopForPdfPosition(pages, { page: 2, offset: 0.25 })).toBe(1278);
    expect(scrollTopForPdfPosition(pages, { page: 9, offset: 0 })).toBeNull();
  });

  // Dragging the column width / zooming scales the pages proportionally: the
  // page height changes, so the same scrollTop points at completely different
  // content (measured: at 981px wide scrollTop=2900 is on page 3 at 53%,
  // after narrowing to 390px the same scrollTop lands on page 6 at 632%).
  // Before and after a reflow the position must be converted by "page number
  // + in-page ratio", not by reusing the pixel value.
  it("重排前后按页码+比例换算:同一处内容仍停在视口顶部", () => {
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

  it("存盘走同一份文件,payload 带页码/偏移", async () => {
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

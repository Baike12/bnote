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
    // 第 1 页底部 1014,第 2 页顶 1028;滚动到 1020(空隙)仍属于第 1 页。
    expect(pdfPositionAt(pages, 1020)).toMatchObject({ page: 1, offset: 1 });
    expect(pdfPositionAt(pages, 99999)).toMatchObject({ page: 3, offset: 1 });
  });

  it("按页码+偏移反算 scrollTop;页码不存在返回 null", () => {
    expect(scrollTopForPdfPosition(pages, { page: 2, offset: 0.25 })).toBe(1278);
    expect(scrollTopForPdfPosition(pages, { page: 9, offset: 0 })).toBeNull();
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

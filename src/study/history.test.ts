import { describe, expect, it } from "vitest";
import {
  emptyStudyHistory,
  normalizeStudyHistory,
  pdfHistoryForVault,
  pushPdfEntry,
  pushUrlEntry,
  pushWereadBook,
  STUDY_HISTORY_LIMIT,
} from "./history";

const pdf = (path: string, title = path) => ({ path, relPath: title, title });

describe("study history: PDF 与网页分开", () => {
  it("两类记录互不混入", () => {
    let h = emptyStudyHistory();
    h = pushPdfEntry(h, pdf("/v/pdfs/a.pdf", "A"));
    h = pushUrlEntry(h, { url: "https://example.com", title: "Example" });
    expect(h.pdfs.map((e) => e.path)).toEqual(["/v/pdfs/a.pdf"]);
    expect(h.urls.map((e) => e.url)).toEqual(["https://example.com"]);
  });

  it("重复打开只保留一条并移到最前", () => {
    let h = emptyStudyHistory();
    h = pushPdfEntry(h, { ...pdf("/v/pdfs/a.pdf", "A"), at: 1 });
    h = pushPdfEntry(h, { ...pdf("/v/pdfs/b.pdf", "B"), at: 2 });
    h = pushPdfEntry(h, { ...pdf("/v/pdfs/a.pdf", "A"), at: 3 });
    expect(h.pdfs.map((e) => e.title)).toEqual(["A", "B"]);
    expect(h.pdfs[0].at).toBe(3);
  });

  it("网页按 URL 去重", () => {
    let h = emptyStudyHistory();
    h = pushUrlEntry(h, { url: "https://a.dev", title: "A" });
    h = pushUrlEntry(h, { url: "https://b.dev", title: "B" });
    h = pushUrlEntry(h, { url: "https://a.dev", title: "A 新标题" });
    expect(h.urls).toHaveLength(2);
    expect(h.urls[0].title).toBe("A 新标题");
  });

  it("上限之外的老记录被丢弃", () => {
    let h = emptyStudyHistory();
    for (let i = 0; i < STUDY_HISTORY_LIMIT + 5; i++) {
      h = pushPdfEntry(h, pdf(`/v/pdfs/${i}.pdf`));
    }
    expect(h.pdfs).toHaveLength(STUDY_HISTORY_LIMIT);
    expect(h.pdfs[0].path).toBe(`/v/pdfs/${STUDY_HISTORY_LIMIT + 4}.pdf`);
  });
});

describe("study history: 微信读书独立列表", () => {
  const reader = (hash: string) => `https://weread.qq.com/web/reader/${hash}`;

  it("书籍与网页/PDF 互不混入", () => {
    let h = emptyStudyHistory();
    h = pushUrlEntry(h, { url: "https://example.com", title: "Example" });
    h = pushWereadBook(h, { url: reader("abc"), title: "三体" });
    expect(h.urls).toHaveLength(1);
    expect(h.weread.map((e) => e.title)).toEqual(["三体"]);
  });

  it("同一本书去重置顶,后到的书名覆盖先到的", () => {
    // 首报书名还没提取到(兜底标题),提取到后补报正确书名。
    let h = emptyStudyHistory();
    h = pushWereadBook(h, { url: reader("abc"), title: "微信读书 abc", at: 1 });
    h = pushWereadBook(h, { url: reader("def"), title: "算法导论", at: 2 });
    h = pushWereadBook(h, { url: reader("abc"), title: "三体", at: 3 });
    expect(h.weread.map((e) => e.title)).toEqual(["三体", "算法导论"]);
    expect(h.weread[0].at).toBe(3);
  });

  it("上限之外的老记录被丢弃", () => {
    let h = emptyStudyHistory();
    for (let i = 0; i < STUDY_HISTORY_LIMIT + 3; i++) {
      h = pushWereadBook(h, { url: reader(String(i)), title: `书${i}` });
    }
    expect(h.weread).toHaveLength(STUDY_HISTORY_LIMIT);
    expect(h.weread[0].url).toBe(reader(String(STUDY_HISTORY_LIMIT + 2)));
  });

  it("旧配置没有 weread 字段也能归一(兼容升级)", () => {
    const h = normalizeStudyHistory({
      pdfs: [],
      urls: [{ url: "https://a.dev", title: "A" }],
    });
    expect(h.weread).toEqual([]);
  });

  it("weread 里的坏条目逐条丢弃", () => {
    const h = normalizeStudyHistory({
      weread: [
        { url: reader("abc"), title: "三体", at: 1 },
        { url: "", title: "no url" },
        { url: reader("def") },
        "junk",
      ],
    });
    expect(h.weread.map((e) => e.title)).toEqual(["三体"]);
  });
});

describe("normalizeStudyHistory", () => {
  it("坏配置不抛错，逐条丢弃非法项", () => {
    const h = normalizeStudyHistory({
      pdfs: [
        { path: "/v/pdfs/a.pdf", relPath: "pdfs/a.pdf", title: "A", at: 1 },
        { path: "", title: "empty path" },
        { path: "/v/pdfs/b.pdf" },
        "junk",
      ],
      urls: [{ url: "https://a.dev", title: "A" }, { title: "no url" }],
    });
    expect(h.pdfs.map((e) => e.title)).toEqual(["A"]);
    expect(h.urls.map((e) => e.title)).toEqual(["A"]);
  });

  it("非对象返回空历史", () => {
    expect(normalizeStudyHistory(null)).toEqual(emptyStudyHistory());
    expect(normalizeStudyHistory("nope")).toEqual(emptyStudyHistory());
  });
});

describe("pdfHistoryForVault", () => {
  it("只列出当前 vault 里的 PDF（跨仓记录不能打开）", () => {
    let h = emptyStudyHistory();
    h = pushPdfEntry(h, pdf("/v1/pdfs/a.pdf"));
    h = pushPdfEntry(h, pdf("/v2/pdfs/b.pdf"));
    h = pushPdfEntry(h, pdf("/v1x/pdfs/c.pdf"));
    expect(pdfHistoryForVault(h, "/v1").map((e) => e.path)).toEqual(["/v1/pdfs/a.pdf"]);
  });

  it("没有 vault 时原样返回", () => {
    let h = emptyStudyHistory();
    h = pushPdfEntry(h, pdf("/v1/pdfs/a.pdf"));
    expect(pdfHistoryForVault(h, null)).toEqual(h.pdfs);
  });

  it("运行时混进坏记录也不抛错（只丢弃那一行）", () => {
    const bad = {
      pdfs: [{ title: "坏", relPath: "x", at: 1 }],
      urls: [],
    } as unknown as Parameters<typeof pdfHistoryForVault>[0];
    expect(pdfHistoryForVault(bad, "/v1")).toEqual([]);
  });
});

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

describe("study history: PDFs and web pages are kept apart", () => {
  it("the two kinds of records never mix", () => {
    let h = emptyStudyHistory();
    h = pushPdfEntry(h, pdf("/v/pdfs/a.pdf", "A"));
    h = pushUrlEntry(h, { url: "https://example.com", title: "Example" });
    expect(h.pdfs.map((e) => e.path)).toEqual(["/v/pdfs/a.pdf"]);
    expect(h.urls.map((e) => e.url)).toEqual(["https://example.com"]);
  });

  it("opening the same item again keeps a single entry and moves it to the front", () => {
    let h = emptyStudyHistory();
    h = pushPdfEntry(h, { ...pdf("/v/pdfs/a.pdf", "A"), at: 1 });
    h = pushPdfEntry(h, { ...pdf("/v/pdfs/b.pdf", "B"), at: 2 });
    h = pushPdfEntry(h, { ...pdf("/v/pdfs/a.pdf", "A"), at: 3 });
    expect(h.pdfs.map((e) => e.title)).toEqual(["A", "B"]);
    expect(h.pdfs[0].at).toBe(3);
  });

  it("web pages are deduplicated by URL", () => {
    let h = emptyStudyHistory();
    h = pushUrlEntry(h, { url: "https://a.dev", title: "A" });
    h = pushUrlEntry(h, { url: "https://b.dev", title: "B" });
    h = pushUrlEntry(h, { url: "https://a.dev", title: "A 新标题" });
    expect(h.urls).toHaveLength(2);
    expect(h.urls[0].title).toBe("A 新标题");
  });

  it("entries beyond the limit are dropped", () => {
    let h = emptyStudyHistory();
    for (let i = 0; i < STUDY_HISTORY_LIMIT + 5; i++) {
      h = pushPdfEntry(h, pdf(`/v/pdfs/${i}.pdf`));
    }
    expect(h.pdfs).toHaveLength(STUDY_HISTORY_LIMIT);
    expect(h.pdfs[0].path).toBe(`/v/pdfs/${STUDY_HISTORY_LIMIT + 4}.pdf`);
  });
});

describe("study history: WeRead has its own list", () => {
  const reader = (hash: string) => `https://weread.qq.com/web/reader/${hash}`;

  it("books never mix with web pages or PDFs", () => {
    let h = emptyStudyHistory();
    h = pushUrlEntry(h, { url: "https://example.com", title: "Example" });
    h = pushWereadBook(h, { url: reader("abc"), title: "三体" });
    expect(h.urls).toHaveLength(1);
    expect(h.weread.map((e) => e.title)).toEqual(["三体"]);
  });

  it("the same book is deduplicated and moved to the top, and the later title overrides the earlier one", () => {
    // The first report has no extracted title yet (fallback title); the correct one is reported once extraction finishes.
    let h = emptyStudyHistory();
    h = pushWereadBook(h, { url: reader("abc"), title: "微信读书 abc", at: 1 });
    h = pushWereadBook(h, { url: reader("def"), title: "算法导论", at: 2 });
    h = pushWereadBook(h, { url: reader("abc"), title: "三体", at: 3 });
    expect(h.weread.map((e) => e.title)).toEqual(["三体", "算法导论"]);
    expect(h.weread[0].at).toBe(3);
  });

  it("entries beyond the limit are dropped", () => {
    let h = emptyStudyHistory();
    for (let i = 0; i < STUDY_HISTORY_LIMIT + 3; i++) {
      h = pushWereadBook(h, { url: reader(String(i)), title: `书${i}` });
    }
    expect(h.weread).toHaveLength(STUDY_HISTORY_LIMIT);
    expect(h.weread[0].url).toBe(reader(String(STUDY_HISTORY_LIMIT + 2)));
  });

  it("an old config without a weread field still normalizes (compatible upgrade)", () => {
    const h = normalizeStudyHistory({
      pdfs: [],
      urls: [{ url: "https://a.dev", title: "A" }],
    });
    expect(h.weread).toEqual([]);
  });

  it("bad entries in weread are dropped one by one", () => {
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

describe("study history: code projects are no longer part of it", () => {
  it("a legacy codes array is dropped during normalization (code mode owns its own list)", () => {
    const h = normalizeStudyHistory({
      pdfs: [],
      urls: [],
      codes: [{ path: "/a", title: "A", at: 1 }],
    });
    expect(h).toEqual({ pdfs: [], urls: [], weread: [] });
  });

  it("a record produced without codes never regains the field", () => {
    const h = emptyStudyHistory();
    expect(Object.keys(h).sort()).toEqual(["pdfs", "urls", "weread"]);
  });
});

describe("normalizeStudyHistory", () => {
  it("a bad config does not throw, illegal entries are dropped one by one", () => {
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

  it("a non-object returns an empty history", () => {
    expect(normalizeStudyHistory(null)).toEqual(emptyStudyHistory());
    expect(normalizeStudyHistory("nope")).toEqual(emptyStudyHistory());
  });
});

describe("pdfHistoryForVault", () => {
  it("only lists the PDFs of the current vault (records from another vault cannot be opened)", () => {
    let h = emptyStudyHistory();
    h = pushPdfEntry(h, pdf("/v1/pdfs/a.pdf"));
    h = pushPdfEntry(h, pdf("/v2/pdfs/b.pdf"));
    h = pushPdfEntry(h, pdf("/v1x/pdfs/c.pdf"));
    expect(pdfHistoryForVault(h, "/v1").map((e) => e.path)).toEqual(["/v1/pdfs/a.pdf"]);
  });

  it("returns the entries unchanged when there is no vault", () => {
    let h = emptyStudyHistory();
    h = pushPdfEntry(h, pdf("/v1/pdfs/a.pdf"));
    expect(pdfHistoryForVault(h, null)).toEqual(h.pdfs);
  });

  it("a bad record mixed in at runtime does not throw (only that row is dropped)", () => {
    const bad = {
      pdfs: [{ title: "坏", relPath: "x", at: 1 }],
      urls: [],
    } as unknown as Parameters<typeof pdfHistoryForVault>[0];
    expect(pdfHistoryForVault(bad, "/v1")).toEqual([]);
  });
});

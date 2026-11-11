import { describe, expect, it } from "vitest";
import { fileUrlFromPath, normalizeStudyUrl, studyUrlName } from "./webUrl";

describe("normalizeStudyUrl", () => {
  it("keeps http(s) addresses and adds https to a bare host", () => {
    expect(normalizeStudyUrl("https://x.com/a")).toBe("https://x.com/a");
    expect(normalizeStudyUrl("http://127.0.0.1:8080/a.html")).toBe("http://127.0.0.1:8080/a.html");
    expect(normalizeStudyUrl("  x.com/poteto  ")).toBe("https://x.com/poteto");
  });

  it("turns an absolute path into a file url", () => {
    expect(normalizeStudyUrl("/Users/me/learning/01.html")).toBe(
      "file:///Users/me/learning/01.html",
    );
    // The path is percent-encoded, because that is what the webview and the
    // backend see; the identity of the material must not differ between them.
    expect(normalizeStudyUrl("/Users/me/a b/01.html")).toBe("file:///Users/me/a%20b/01.html");
  });

  it("accepts a typed file url and keeps its anchor", () => {
    expect(normalizeStudyUrl("file:///Users/me/01.html")).toBe("file:///Users/me/01.html");
    expect(normalizeStudyUrl("file:///Users/me/a b.html#part2")).toBe(
      "file:///Users/me/a%20b.html#part2",
    );
  });

  it("an empty input stays empty", () => {
    expect(normalizeStudyUrl("   ")).toBe("");
  });
});

describe("fileUrlFromPath", () => {
  it("encodes every segment and keeps the leading slash", () => {
    expect(fileUrlFromPath("/Users/me/01.html")).toBe("file:///Users/me/01.html");
    expect(fileUrlFromPath("/Users/me/中文 目录/a%20b.html")).toBe(
      "file:///Users/me/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/a%2520b.html",
    );
  });
});

describe("studyUrlName", () => {
  it("names a remote page by its host and a local page by its file name", () => {
    expect(studyUrlName("https://x.com/poteto/article")).toBe("x.com");
    expect(studyUrlName("file:///Users/me/learning/01-electron-model.html")).toBe(
      "01-electron-model.html",
    );
    expect(studyUrlName("file:///Users/me/a%20b.html")).toBe("a b.html");
  });
});

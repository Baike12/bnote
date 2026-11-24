import { describe, expect, it, vi } from "vitest";

// The asset protocol does not exist outside Tauri; the resolver's contract is
// "ask imageSrc for the URL of this project-relative path", which is what this
// mock records.
vi.mock("./image", () => ({
  imageSrc: (root: string, path: string) => `asset://${root}/${path}`,
}));

import { markdownImageHtml, markdownImageResolver } from "./markdownPreview";

describe("markdownImageHtml", () => {
  it("resolves a path relative to the markdown file", () => {
    expect(markdownImageHtml("/proj", "docs/api/a.md", "../img/x.png", "图")).toBe(
      '<img src="asset:///proj/docs/img/x.png" alt="图">',
    );
  });

  it("reads a leading slash from the project root", () => {
    expect(markdownImageHtml("/proj", "docs/a.md", "/img/x.png", "")).toBe(
      '<img src="asset:///proj/img/x.png" alt="">',
    );
  });

  it("percent-decodes the reference", () => {
    expect(markdownImageHtml("/proj", "a.md", "img/a%20b.png", "x")).toContain(
      "asset:///proj/img/a b.png",
    );
  });

  it("keeps remote and data URLs as they are", () => {
    expect(markdownImageHtml("/proj", "a.md", "https://x/y.png", "r")).toBe(
      '<img src="https://x/y.png" alt="r">',
    );
    expect(markdownImageHtml("/proj", "a.md", "data:image/png;base64,AA", "")).toContain(
      "data:image/png;base64,AA",
    );
  });

  it("escapes the alt text and the URL", () => {
    const html = markdownImageHtml("/proj", "a.md", 'https://x/a?b=1&c="2"', "<b>");
    expect(html).toContain("&amp;c=&quot;2&quot;");
    expect(html).toContain('alt="&lt;b&gt;"');
  });

  it("refuses a scheme that is not an image", () => {
    expect(markdownImageHtml("/proj", "a.md", "blob:abc", "")).toBeNull();
    expect(markdownImageHtml("/proj", "a.md", "mailto:a@b", "")).toBeNull();
  });

  it("an empty reference resolves to nothing", () => {
    expect(markdownImageHtml("/proj", "a.md", "  ", "")).toBeNull();
  });
});

describe("markdownImageResolver", () => {
  it("binds the root and the file path", () => {
    const resolve = markdownImageResolver("/proj", "notes/a.md");
    expect(resolve("p.png", "")).toBe('<img src="asset:///proj/notes/p.png" alt="">');
  });
});

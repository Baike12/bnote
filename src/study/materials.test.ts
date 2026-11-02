import { describe, expect, it } from "vitest";
import { studyIdentity, sessionFilePath, materialAbsDir } from "./materials";

describe("studyIdentity", () => {
  it("a PDF uses its path, a web page uses its URL (trailing slashes are ignored)", () => {
    expect(studyIdentity({ kind: "pdf", path: "/v/a.pdf", title: "A" })).toBe("pdf:/v/a.pdf");
    expect(studyIdentity({ kind: "url", url: "https://x.com/a/", title: "x" })).toBe(
      "url:https://x.com/a",
    );
    expect(studyIdentity({ kind: "url", url: "https://x.com/a", title: "x" })).toBe(
      "url:https://x.com/a",
    );
  });
});

describe("the materials directory path", () => {
  it("it lands in <vault>/.bnote/materials/<kind>/<dir>", () => {
    expect(materialAbsDir("/v", "materials/pdfs/ji_qi_xue_xi")).toBe(
      "/v/.bnote/materials/pdfs/ji_qi_xue_xi",
    );
    expect(sessionFilePath("/v", "materials/wxreads/san_ti", "s1-0")).toBe(
      "/v/.bnote/materials/wxreads/san_ti/sessions/s1-0.jsonl",
    );
  });

  it("a trailing slash on the vault path does not produce a double slash", () => {
    expect(materialAbsDir("/v/", "materials/pdfs/a")).toBe("/v/.bnote/materials/pdfs/a");
  });
});

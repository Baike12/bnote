import { describe, expect, it } from "vitest";
import { studyIdentity, sessionFilePath, materialAbsDir } from "./materials";

describe("studyIdentity", () => {
  it("PDF 用路径,网页用网址(忽略末尾斜杠)", () => {
    expect(studyIdentity({ kind: "pdf", path: "/v/a.pdf", title: "A" })).toBe("pdf:/v/a.pdf");
    expect(studyIdentity({ kind: "url", url: "https://x.com/a/", title: "x" })).toBe(
      "url:https://x.com/a",
    );
    expect(studyIdentity({ kind: "url", url: "https://x.com/a", title: "x" })).toBe(
      "url:https://x.com/a",
    );
  });
});

describe("材料目录路径", () => {
  it("落到 <vault>/.bnote/materials/<kind>/<dir>", () => {
    expect(materialAbsDir("/v", "materials/pdfs/ji_qi_xue_xi")).toBe(
      "/v/.bnote/materials/pdfs/ji_qi_xue_xi",
    );
    expect(sessionFilePath("/v", "materials/wxreads/san_ti", "s1-0")).toBe(
      "/v/.bnote/materials/wxreads/san_ti/sessions/s1-0.jsonl",
    );
  });

  it("vault 路径末尾斜杠不产生双斜杠", () => {
    expect(materialAbsDir("/v/", "materials/pdfs/a")).toBe("/v/.bnote/materials/pdfs/a");
  });
});

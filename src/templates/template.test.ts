import { describe, expect, it } from "vitest";
import { normalizeTemplateDir, renderTemplate, templateFiles, templateLabel } from "./template";

describe("template: variable substitution", () => {
  it("replaces date/title and allows whitespace inside and outside the braces", () => {
    expect(
      renderTemplate("# {{date}}\n\n{{ title }} 的笔记\n", {
        date: "2026-11-01",
        title: "会议",
      }),
    ).toBe("# 2026-11-01\n\n会议 的笔记\n");
  });

  it("unknown variables and plain braces are kept as is", () => {
    expect(
      renderTemplate("{{time}} {{date}} {{code}} {{ x }}", {
        date: "2026-11-01",
        title: "t",
      }),
    ).toBe("{{time}} 2026-11-01 {{code}} {{ x }}");
  });

  it("braces inside a variable value are not substituted a second time", () => {
    expect(renderTemplate("{{title}}", { date: "d", title: "{{date}}" })).toBe("{{date}}");
  });
});

describe("template: directory and file list", () => {
  const files = [
    "Templates/日记.md",
    "Templates/会议/周会.md",
    "Templates.md",
    "Notes/日记.md",
    "Daily/2026-11-01.md",
  ];

  it("directory normalization: whitespace, leading/trailing slashes and `.` segments are removed and backslashes become `/`", () => {
    expect(normalizeTemplateDir("  /Templates/  ")).toBe("Templates");
    expect(normalizeTemplateDir("./Templates//会议")).toBe("Templates/会议");
    expect(normalizeTemplateDir("Templates\\会议")).toBe("Templates/会议");
    expect(normalizeTemplateDir("")).toBe("");
    expect(normalizeTemplateDir("  /  ")).toBe("");
  });

  it("a directory containing `..` counts as unset (no file outside the repo is read)", () => {
    expect(normalizeTemplateDir("../Templates")).toBe("");
    expect(normalizeTemplateDir("Templates/../x")).toBe("");
  });

  it("only files inside the directory are listed (including subdirectories), sorted by path", () => {
    expect(templateFiles(files, "Templates")).toEqual([
      "Templates/会议/周会.md",
      "Templates/日记.md",
    ]);
    // The prefix must carry the slash: `Templates.md` is not a file inside the `Templates` directory.
    expect(templateFiles(files, "Templates/")).toEqual([
      "Templates/会议/周会.md",
      "Templates/日记.md",
    ]);
    expect(templateFiles(files, "Template")).toEqual([]);
    expect(templateFiles(files, "")).toEqual([]);
  });

  it("the option label is relative to the template directory; paths outside the directory are shown as is", () => {
    expect(templateLabel("Templates/会议/周会.md", "Templates")).toBe("会议/周会.md");
    expect(templateLabel("Other/x.md", "Templates")).toBe("Other/x.md");
    expect(templateLabel("Other/x.md", "")).toBe("Other/x.md");
  });
});

describe("template: comparison branches", () => {
  it("two identical paths compare equal in the sort, a shorter prefix sorts before it", () => {
    // The comparator has three arms (a < b / a > b / equal); a directory holding a
    // single template never reaches the equal and greater arms on its own, so the
    // list is fed duplicates and a longer name explicitly.
    expect(templateFiles(["Templates/a.md", "Templates/a.md"], "Templates")).toEqual([
      "Templates/a.md",
      "Templates/a.md",
    ]);
    expect(
      templateFiles(["Templates/b.md", "Templates/a.md", "Templates/aa.md"], "Templates"),
    ).toEqual(["Templates/a.md", "Templates/aa.md", "Templates/b.md"]);
  });
});

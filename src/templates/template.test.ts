import { describe, expect, it } from "vitest";
import {
  normalizeTemplateDir,
  renderTemplate,
  templateFiles,
  templateLabel,
} from "./template";

describe("模板:变量替换", () => {
  it("替换 date/title,允许花括号内外留白", () => {
    expect(
      renderTemplate("# {{date}}\n\n{{ title }} 的笔记\n", {
        date: "2026-11-01",
        title: "会议",
      }),
    ).toBe("# 2026-11-01\n\n会议 的笔记\n");
  });

  it("未知变量与普通花括号原样保留", () => {
    expect(
      renderTemplate("{{time}} {{date}} {{code}} {{ x }}", {
        date: "2026-11-01",
        title: "t",
      }),
    ).toBe("{{time}} 2026-11-01 {{code}} {{ x }}");
  });

  it("变量值里的花括号不会被二次替换", () => {
    expect(renderTemplate("{{title}}", { date: "d", title: "{{date}}" })).toBe(
      "{{date}}",
    );
  });
});

describe("模板:目录与文件列表", () => {
  const files = [
    "Templates/日记.md",
    "Templates/会议/周会.md",
    "Templates.md",
    "Notes/日记.md",
    "Daily/2026-11-01.md",
  ];

  it("目录规范化:去掉空白、首尾斜杠与 `.` 段,反斜杠转 `/`", () => {
    expect(normalizeTemplateDir("  /Templates/  ")).toBe("Templates");
    expect(normalizeTemplateDir("./Templates//会议")).toBe("Templates/会议");
    expect(normalizeTemplateDir("Templates\\会议")).toBe("Templates/会议");
    expect(normalizeTemplateDir("")).toBe("");
    expect(normalizeTemplateDir("  /  ")).toBe("");
  });

  it("含 `..` 的目录视为未设置(不读仓库外文件)", () => {
    expect(normalizeTemplateDir("../Templates")).toBe("");
    expect(normalizeTemplateDir("Templates/../x")).toBe("");
  });

  it("只列目录内文件(含子目录),按路径排序", () => {
    expect(templateFiles(files, "Templates")).toEqual([
      "Templates/会议/周会.md",
      "Templates/日记.md",
    ]);
    // 前缀必须带斜杠:`Templates.md` 不是 `Templates` 目录里的文件。
    expect(templateFiles(files, "Templates/")).toEqual([
      "Templates/会议/周会.md",
      "Templates/日记.md",
    ]);
    expect(templateFiles(files, "Template")).toEqual([]);
    expect(templateFiles(files, "")).toEqual([]);
  });

  it("选项显示名相对模板目录;目录外的路径原样显示", () => {
    expect(templateLabel("Templates/会议/周会.md", "Templates")).toBe("会议/周会.md");
    expect(templateLabel("Other/x.md", "Templates")).toBe("Other/x.md");
    expect(templateLabel("Other/x.md", "")).toBe("Other/x.md");
  });
});

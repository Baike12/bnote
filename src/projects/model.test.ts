import { describe, expect, it } from "vitest";
import {
  PROJECTS_DIR,
  isProjectPath,
  projectNameOf,
  projectPathFor,
  projectTodos,
  sanitizeProjectName,
} from "./model";

describe("项目模型", () => {
  it("项目文件固定在 <vault>/.bnote/projects 下", () => {
    expect(PROJECTS_DIR).toBe(".bnote/projects");
    expect(projectPathFor("/v", "读书")).toBe("/v/.bnote/projects/读书.md");
    expect(projectPathFor("/v/", "读书")).toBe("/v/.bnote/projects/读书.md");
  });

  it("项目名 = 文件名去掉 .md(日记侧的来源标签直接用它)", () => {
    expect(projectNameOf("/v/.bnote/projects/读书.md")).toBe("读书");
    expect(projectNameOf("/v/.bnote/projects/项目 2.md")).toBe("项目 2");
  });

  it("只有 projects 目录下的绝对路径算项目文件", () => {
    expect(isProjectPath("/v/.bnote/projects/读书.md")).toBe(true);
    expect(isProjectPath("/v/notes/读书.md")).toBe(false);
    expect(isProjectPath("读书.md")).toBe(false);
    expect(isProjectPath(".bnote/projects/读书.md")).toBe(false);
  });

  it("文件名过滤非法字符、压空白、去掉首部点", () => {
    expect(sanitizeProjectName("  读/书:计划  ")).toBe("读 书 计划");
    expect(sanitizeProjectName("a\\b*c?d")).toBe("a b c d");
    expect(sanitizeProjectName("...hidden")).toBe("hidden");
    expect(sanitizeProjectName("///")).toBe("");
    expect(sanitizeProjectName("x".repeat(100))).toHaveLength(60);
  });

  it("待办行解析保留行号/缩进/完成态/身份文本", () => {
    const text = [
      "# 标题",
      "- [ ] 甲",
      "  - [x] 乙 ✅ 2026-10-29",
      "- 普通项目",
      "- [ ] ",
    ].join("\n");
    expect(projectTodos(text).map((t) => [t.line, t.indent, t.done, t.text])).toEqual([
      [2, 0, false, "甲"],
      [3, 2, true, "乙"],
      [5, 0, false, ""],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  PROJECTS_DIR,
  isProjectPath,
  projectNameOf,
  projectPathFor,
  projectTodos,
  sanitizeProjectName,
} from "./model";

describe("project model", () => {
  it("project files always live under <vault>/.bnote/projects", () => {
    expect(PROJECTS_DIR).toBe(".bnote/projects");
    expect(projectPathFor("/v", "读书")).toBe("/v/.bnote/projects/读书.md");
    expect(projectPathFor("/v/", "读书")).toBe("/v/.bnote/projects/读书.md");
  });

  it("project name = file name without .md (the daily note side uses it directly as the source label)", () => {
    expect(projectNameOf("/v/.bnote/projects/读书.md")).toBe("读书");
    expect(projectNameOf("/v/.bnote/projects/项目 2.md")).toBe("项目 2");
  });

  it("only absolute paths under the projects directory count as project files", () => {
    expect(isProjectPath("/v/.bnote/projects/读书.md")).toBe(true);
    expect(isProjectPath("/v/notes/读书.md")).toBe(false);
    expect(isProjectPath("读书.md")).toBe(false);
    expect(isProjectPath(".bnote/projects/读书.md")).toBe(false);
  });

  it("the file name filters illegal characters, collapses whitespace and drops leading dots", () => {
    expect(sanitizeProjectName("  读/书:计划  ")).toBe("读 书 计划");
    expect(sanitizeProjectName("a\\b*c?d")).toBe("a b c d");
    expect(sanitizeProjectName("...hidden")).toBe("hidden");
    expect(sanitizeProjectName("///")).toBe("");
    expect(sanitizeProjectName("x".repeat(100))).toHaveLength(60);
  });

  it("todo line parsing keeps the line number, indentation, done state and identity text", () => {
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

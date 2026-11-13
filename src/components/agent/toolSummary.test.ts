import { describe, expect, it } from "vitest";

import { toolSummary, stripAgentTrailer, workDurationLabel } from "./toolSummary";

describe("toolSummary", () => {
  it("labels Read with the file path", () => {
    expect(toolSummary("Read", { file_path: "src/lib.rs" }, false)).toEqual({
      kind: "读取",
      primary: "src/lib.rs",
      diff: null,
    });
    expect(toolSummary("Read", { file_path: "src/lib.rs" }, true).kind).toBe("正在读取");
  });

  it("labels Edit with the path and the +/− line counts", () => {
    const s = toolSummary(
      "Edit",
      { file_path: "a.rs", old_string: "a\nb", new_string: "x" },
      false,
    );
    expect(s.kind).toBe("编辑");
    expect(s.primary).toBe("a.rs");
    expect(s.diff).toEqual({ added: 1, removed: 2 });
  });

  it("labels Bash with the collapsed command", () => {
    const s = toolSummary("Bash", { command: "cargo   test\n  --lib" }, false);
    expect(s.primary).toBe("cargo test --lib");
  });

  it("resolves legacy snake_case names to the same labels", () => {
    expect(toolSummary("edit_file", { file_path: "a" }, false).kind).toBe("编辑");
    expect(toolSummary("bash", { command: "ls" }, false).kind).toBe("执行");
    expect(toolSummary("task", { description: "探索目录" }, false).kind).toBe("子代理");
  });

  it("falls back to the tool name for unknown tools", () => {
    expect(toolSummary("Custom", {}, false).kind).toBe("Custom");
  });

  it("TodoWrite counts the items; Skill shows the name", () => {
    expect(toolSummary("TodoWrite", { todos: [{}, {}, {}] }, false)).toEqual({
      kind: "任务清单",
      primary: "3 项",
      diff: null,
    });
    expect(toolSummary("TodoRead", {}, false)).toEqual({
      kind: "查看任务清单",
      primary: "",
      diff: null,
    });
    expect(toolSummary("Skill", { skill: "html-blog" }, false).primary).toBe("html-blog");
  });
});

describe("workDurationLabel", () => {
  it("formats seconds, minutes and the two-unit style", () => {
    expect(workDurationLabel(null)).toBe("");
    expect(workDurationLabel(9500)).toBe("10 秒");
    expect(workDurationLabel(90_000)).toBe("1 分 30 秒");
    expect(workDurationLabel(120_000)).toBe("2 分钟");
  });
});

describe("stripAgentTrailer", () => {
  it("drops the agent id line an Agent result carries for the model", () => {
    const output =
      "Scope: src\nResult: 完成\n\nagentId: s1-7-agent-1700000000000-1\n<usage>total_tokens: 1200\nduration_ms: 8000</usage>";
    const shown = stripAgentTrailer(output);
    expect(shown).not.toContain("agentId");
    expect(shown).toContain("Result: 完成");
    // The usage line is the user's information (tokens, duration) and stays.
    expect(shown).toContain("total_tokens: 1200");
  });

  it("also drops it from a background launch acknowledgement", () => {
    const shown = stripAgentTrailer(
      "Async agent launched successfully.\nagentId: a-1\nIt is working in the background.",
    );
    expect(shown).not.toContain("agentId");
    expect(shown).toContain("Async agent launched successfully.");
  });
});

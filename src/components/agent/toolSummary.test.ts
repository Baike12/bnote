import { describe, expect, it } from "vitest";

import {
  canonicalToolName,
  stripAgentTrailer,
  toolSummary,
  workDurationLabel,
} from "./toolSummary";

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
    expect(toolSummary("Custom", {}, true).kind).toBe("正在调用");
    expect(toolSummary("Custom", {}, false).primary).toBe("");
    expect(toolSummary("Custom", {}, false).diff).toBeNull();
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

  it("a malformed input never throws and yields empty fields", () => {
    expect(toolSummary("Read", null, false)).toEqual({ kind: "读取", primary: "", diff: null });
    expect(toolSummary("Read", "a string", false).primary).toBe("");
    expect(toolSummary("Edit", 42, false).diff).toBeNull();
    expect(toolSummary("Bash", { command: 7 }, false).primary).toBe("");
    expect(toolSummary("Glob", { pattern: null }, false).primary).toBe("");
    // The tool input arrives as unknown JSON: an array is not a record either.
    expect(toolSummary("Read", ["file_path"], false).primary).toBe("");
  });

  it("TodoWrite counts only a real list, and a missing list is zero items", () => {
    expect(toolSummary("TodoWrite", {}, false).primary).toBe("0 项");
    expect(toolSummary("TodoWrite", { todos: "nope" }, false).primary).toBe("0 项");
    expect(toolSummary("TodoWrite", { todos: [] }, true).kind).toBe("更新任务清单");
  });

  it("Read accepts notebook_path and a bare path", () => {
    expect(toolSummary("Read", { path: "b.md" }, false).primary).toBe("b.md");
    expect(toolSummary("Read", { notebook_path: "n.ipynb" }, false).primary).toBe("n.ipynb");
  });

  it("Write names the file it creates", () => {
    expect(toolSummary("Write", { file_path: "out.md" }, false)).toEqual({
      kind: "写入",
      primary: "out.md",
      diff: null,
    });
    expect(toolSummary("write_file", { path: "out.md" }, true).kind).toBe("正在写入");
  });

  it("an Edit with only additions or only removals still shows the diff", () => {
    expect(toolSummary("Edit", { old_string: "", new_string: "x" }, false).diff).toEqual({
      added: 1,
      removed: 0,
    });
    expect(toolSummary("Edit", { old_string: "a\nb", new_string: "" }, false).diff).toEqual({
      added: 0,
      removed: 2,
    });
    // Both sides empty: nothing to show, so the row keeps its plain title.
    expect(toolSummary("Edit", { old_string: "", new_string: "" }, false).diff).toBeNull();
  });

  it("a search shows the pattern, a listing names the project", () => {
    expect(toolSummary("Glob", { pattern: "**/*.ts" }, false)).toEqual({
      kind: "搜索",
      primary: "**/*.ts",
      diff: null,
    });
    expect(toolSummary("grep", { pattern: "TODO" }, true)).toEqual({
      kind: "正在搜索",
      primary: "TODO",
      diff: null,
    });
    expect(toolSummary("list_files", {}, false)).toEqual({
      kind: "列出",
      primary: "项目文件",
      diff: null,
    });
    expect(toolSummary("WebFetch", { url: "https://a" }, false).primary).toBe("https://a");
    expect(toolSummary("read_url", { url: "https://b" }, true).kind).toBe("正在获取");
  });

  it("an Agent row names the dispatch, never the internal id", () => {
    expect(toolSummary("Agent", { description: "调研 API" }, false)).toEqual({
      kind: "子代理",
      primary: "调研 API",
      diff: null,
    });
    expect(toolSummary("Agent", { subagent_type: "explore" }, false).primary).toBe("explore");
    expect(toolSummary("Agent", {}, false).primary).toBe("通用");
    // Only an absent field falls back; a present description is shown verbatim.
    expect(toolSummary("Agent", { description: "" }, false).primary).toBe("通用");
  });

  it("the v2 task tools share the 任务 title and name their target", () => {
    expect(toolSummary("TaskCreate", { subject: "写测试" }, false)).toEqual({
      kind: "任务",
      primary: "写测试",
      diff: null,
    });
    expect(toolSummary("TaskUpdate", { taskId: "7" }, false).primary).toBe("7");
    expect(toolSummary("TaskUpdate", { task_id: "8" }, false).primary).toBe("8");
    expect(toolSummary("TaskGet", { taskId: "9" }, false).primary).toBe("9");
    expect(toolSummary("task_get", { task_id: "10" }, false).primary).toBe("10");
    expect(toolSummary("TaskList", {}, false)).toEqual({
      kind: "任务",
      primary: "全部任务",
      diff: null,
    });
  });

  it("the background task tools show the id they address", () => {
    expect(toolSummary("TaskOutput", { task_id: "b1" }, false)).toEqual({
      kind: "后台输出",
      primary: "#b1",
      diff: null,
    });
    expect(toolSummary("bash_output", { id: "b2" }, true)).toEqual({
      kind: "正在读取输出",
      primary: "#b2",
      diff: null,
    });
    expect(toolSummary("TaskStop", {}, false)).toEqual({
      kind: "停止任务",
      primary: "",
      diff: null,
    });
    expect(toolSummary("bash_kill", { id: "b3" }, false).primary).toBe("#b3");
  });

  it("SendMessage names its recipient; AskUserQuestion waits on the user", () => {
    expect(toolSummary("send_message", { to: "a1" }, false)).toEqual({
      kind: "发消息",
      primary: "a1",
      diff: null,
    });
    expect(toolSummary("AskUserQuestion", {}, false)).toEqual({
      kind: "提问",
      primary: "等待你的选择",
      diff: null,
    });
  });

  it("plan mode and the study/preview tools get their own words", () => {
    expect(toolSummary("EnterPlanMode", {}, true).kind).toBe("进入计划模式");
    expect(toolSummary("ExitPlanMode", {}, false)).toEqual({
      kind: "计划",
      primary: "",
      diff: null,
    });
    expect(toolSummary("preview_html", { path: "a.html" }, false)).toEqual({
      kind: "预览",
      primary: "a.html",
      diff: null,
    });
    expect(toolSummary("read_study_content", {}, true).kind).toBe("正在读取");
  });

  it("Skill falls back to `name` and TaskStop shows no id when none was given", () => {
    expect(toolSummary("Skill", { name: "html-blog" }, false).primary).toBe("html-blog");
    expect(toolSummary("Skill", {}, true).kind).toBe("正在加载技能");
    expect(toolSummary("TaskOutput", {}, true).primary).toBe("");
  });
});

describe("canonicalToolName", () => {
  it("maps every legacy name and leaves the canonical ones alone", () => {
    expect(canonicalToolName("read_file")).toBe("Read");
    expect(canonicalToolName("write_file")).toBe("Write");
    expect(canonicalToolName("list_files")).toBe("LS");
    expect(canonicalToolName("todo")).toBe("TodoWrite");
    expect(canonicalToolName("task")).toBe("Agent");
    expect(canonicalToolName("todo_read")).toBe("TodoRead");
    expect(canonicalToolName("task_create")).toBe("TaskCreate");
    expect(canonicalToolName("task_update")).toBe("TaskUpdate");
    expect(canonicalToolName("task_list")).toBe("TaskList");
    expect(canonicalToolName("task_get")).toBe("TaskGet");
    expect(canonicalToolName("send_message")).toBe("SendMessage");
    expect(canonicalToolName("ask_user_question")).toBe("AskUserQuestion");
    expect(canonicalToolName("read_url")).toBe("WebFetch");
    expect(canonicalToolName("skill")).toBe("Skill");
    expect(canonicalToolName("bash_output")).toBe("TaskOutput");
    expect(canonicalToolName("bash_kill")).toBe("TaskStop");
    expect(canonicalToolName("Bash")).toBe("Bash");
    expect(canonicalToolName("EnterPlanMode")).toBe("EnterPlanMode");
  });
});

describe("workDurationLabel", () => {
  it("formats seconds, minutes and the two-unit style", () => {
    expect(workDurationLabel(null)).toBe("");
    expect(workDurationLabel(0)).toBe("");
    expect(workDurationLabel(-1)).toBe("");
    expect(workDurationLabel(400)).toBe("0 秒");
    expect(workDurationLabel(9500)).toBe("10 秒");
    expect(workDurationLabel(90_000)).toBe("1 分 30 秒");
    expect(workDurationLabel(120_000)).toBe("2 分钟");
  });

  it("switches to hours past sixty minutes", () => {
    expect(workDurationLabel(3_600_000)).toBe("1 时 0 分");
    expect(workDurationLabel(3_930_000)).toBe("1 时 5 分");
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

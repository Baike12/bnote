import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { todoFromInput, todoMark, todoPercent, todoRows, todoSummary } from "./todos";

/**
 * The todo list's rules, shared by the panel above the composer and the
 * TodoWrite tool card. What is pinned: the header's numbers, the marks, and the
 * model-input parsing (a TodoWrite input is model output, not a trusted shape).
 */

const todo = (content: string, status: "pending" | "in_progress" | "completed", active = "") => ({
  content,
  status,
  active_form: active,
});

describe("the session's list", () => {
  it("counts what is done and what is running", () => {
    const todos = [
      todo("读代码", "completed"),
      todo("修 bug", "in_progress", "修 bug 中"),
      todo("跑测试", "pending"),
    ];
    expect(todoSummary(todos)).toEqual({ total: 3, done: 1, current: "修 bug 中" });
    expect(todoPercent(todoSummary(todos))).toBe(33);
    expect(todoPercent(todoSummary([]))).toBe(0);
  });

  it("falls back to the imperative form when active_form is empty", () => {
    const rows = todoRows([todo("修 bug", "in_progress")]);
    expect(rows[0]?.activeForm).toBe("修 bug");
    expect(todoSummary([todo("修 bug", "in_progress")]).current).toBe("修 bug");
  });

  it("marks each state", () => {
    expect(todoMark("completed")).toBe("✓");
    expect(todoMark("in_progress")).toBe("●");
    expect(todoMark("pending")).toBe("○");
  });
});

describe("a TodoWrite call's input", () => {
  it("parses the list the call wrote", () => {
    const rows = todoFromInput({
      todos: [
        { content: "读代码", status: "completed" },
        { content: "修 bug", status: "in_progress", active_form: "修 bug 中" },
        { content: "跑测试", status: "pending" },
      ],
    });
    expect(rows.map((row) => row.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(rows[1]?.activeForm).toBe("修 bug 中");
  });

  it("drops anything the writer would reject instead of drawing an empty row", () => {
    const rows = todoFromInput({
      todos: [
        { content: "  ", status: "pending" },
        { content: "done-ish", status: "done" },
        { content: "ok", status: "pending" },
        { content: "first", status: "in_progress" },
        { content: "second", status: "in_progress" },
      ],
    });
    expect(rows.map((row) => row.content)).toEqual(["ok", "first"]);
  });

  it("survives a malformed input", () => {
    expect(todoFromInput(null)).toEqual([]);
    expect(todoFromInput({})).toEqual([]);
    expect(todoFromInput({ todos: "nope" })).toEqual([]);
    expect(todoFromInput({ todos: [null, 42, { content: "a", status: "pending" }] })).toHaveLength(
      1,
    );
  });

  it("drops a non-string content or active_form instead of duck-typing it", () => {
    expect(todoFromInput({ todos: [{ content: 42, status: "pending" }] })).toEqual([]);
    expect(todoFromInput({ todos: [{ content: "a", status: "pending", active_form: 7 }] })).toEqual(
      [{ content: "a", activeForm: "a", status: "pending" }],
    );
  });
});

/**
 * The panel is the third writer of the list (after the `todos` event): a
 * restored session gets its list from the start payload, and the block sits
 * above the composer. Both are wiring, so they are pinned by source.
 */
describe("where the list comes from and where it sits", () => {
  const panel = readFileSync("src/components/agent/AgentPanel.tsx", "utf8");

  it("a restored session takes the list the backend loaded", () => {
    expect(panel).toContain("todos: info.todos ?? c.todos");
  });

  it("the panel renders above the composer", () => {
    const todosAt = panel.indexOf("<AgentTodos");
    const composerAt = panel.indexOf('className="agent-composer"');
    expect(todosAt).toBeGreaterThan(0);
    expect(composerAt).toBeGreaterThan(0);
    expect(todosAt).toBeLessThan(composerAt);
  });
});

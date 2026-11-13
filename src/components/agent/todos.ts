import type { AgentTodoItem } from "@/lib/tauri";

/**
 * The todo list as the panel and the tool cards draw it.
 *
 * Two consumers share these rules so they can never disagree: the panel above
 * the composer (the session's current list, from the `todos` event and the
 * start payload) and the TodoWrite tool card (the list that call wrote, parsed
 * from its input). Everything here is pure — the same rows, marks and counts
 * are unit-tested outside React.
 */

export type TodoStatus = AgentTodoItem["status"];

export interface TodoRow {
  content: string;
  /** The present-progress form shown while the item runs. */
  activeForm: string;
  status: TodoStatus;
}

/** What the collapsed header says: how far along, and what is running now. */
export interface TodoSummary {
  total: number;
  done: number;
  /** The in-progress item's active form (empty when nothing runs). */
  current: string;
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

/** The session's list, in order (the writer already validated it). */
export function todoRows(todos: AgentTodoItem[]): TodoRow[] {
  return todos.map((todo) => ({
    content: todo.content,
    activeForm: todo.active_form || todo.content,
    status: todo.status,
  }));
}

export function todoSummary(todos: AgentTodoItem[]): TodoSummary {
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  return {
    total: todos.length,
    done,
    current: active ? active.active_form || active.content : "",
  };
}

/** `done/total` as a percentage for the header's bar (0 when the list is empty). */
export function todoPercent(summary: TodoSummary): number {
  if (summary.total <= 0) return 0;
  return Math.round((summary.done / summary.total) * 100);
}

export function todoMark(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "●";
    default:
      return "○";
  }
}

/**
 * A TodoWrite call's own list, parsed from its input. The input is model
 * output, so every field is checked here: an item without text or with an
 * unknown status is dropped rather than drawn as an empty row, and only the
 * first in-progress item is kept (the invariant the tool enforces).
 */
export function todoFromInput(input: unknown): TodoRow[] {
  const list = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(list)) return [];
  const rows: TodoRow[] = [];
  let seenActive = false;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { content?: unknown; status?: unknown; active_form?: unknown };
    const content = typeof item.content === "string" ? item.content.trim() : "";
    const status = STATUSES.find((candidate) => candidate === item.status);
    if (content === "" || !status) continue;
    if (status === "in_progress") {
      if (seenActive) continue;
      seenActive = true;
    }
    const activeForm = typeof item.active_form === "string" ? item.active_form.trim() : "";
    rows.push({ content, activeForm: activeForm || content, status });
  }
  return rows;
}

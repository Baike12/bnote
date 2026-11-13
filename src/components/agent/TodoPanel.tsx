import { useState } from "react";
import type { AgentTodoItem } from "@/lib/tauri";
import { todoMark, todoPercent, todoRows, todoSummary, type TodoRow } from "./todos";

/**
 * The session's todo list, pinned above the composer.
 *
 * Collapsed by default: the header already answers "how far along" (done/total,
 * the item running now, a thin progress bar), and the items themselves are one
 * click away — the model rewrites the whole list on every TodoWrite, so a
 * permanently expanded block would jump between two and ten rows mid-turn.
 *
 * The rows are the same component the TodoWrite tool card draws, so what the
 * user reads in the card and in the panel can never disagree.
 */
export function AgentTodos({ todos }: { todos: AgentTodoItem[] }) {
  const rows = todoRows(todos);
  const summary = todoSummary(todos);
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="agent-todos" aria-label="待办">
      <button
        className="agent-todos-head"
        aria-expanded={open}
        title={open ? "收起待办" : "展开待办"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-todos-title">待办</span>
        <span className="agent-todos-count">
          {summary.done}/{summary.total}
        </span>
        {summary.current && <span className="agent-todos-now">{summary.current}</span>}
        <span className="agent-todos-bar" aria-hidden="true">
          <span style={{ width: `${todoPercent(summary)}%` }} />
        </span>
        <svg
          className="agent-tool-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
      {open && (
        <div className="agent-todos-body">
          {rows.map((row, i) => (
            <TodoRowView key={`${i}:${row.content}`} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One item: mark, text, and the in-progress form while it runs. */
export function TodoRowView({ row }: { row: TodoRow }) {
  return (
    <div className={`agent-todo is-${row.status}`}>
      <span className="agent-todo-mark" aria-hidden="true">
        {todoMark(row.status)}
      </span>
      <span className="agent-todo-text">
        {row.status === "in_progress" ? row.activeForm : row.content}
      </span>
    </div>
  );
}

/**
 * The subagent runs of one conversation, as the panel shows them.
 *
 * A run is a view over a child session: the panel creates a `Conv` per agent
 * (routed by the child's own session id) and keeps this small record beside
 * the parent for the overview strip. The rules here are pure so they can be
 * tested without the component tree:
 *
 * - one record per agent id (a resumed agent flips back to `running` instead
 *   of adding a second row);
 * - the label is what the model wrote in `description` — an id is never
 *   rendered;
 * - a finished run keeps its report and token count for the row's tooltip.
 */

export type SubagentStatus = "running" | "done" | "failed" | "stopped";

export interface SubagentRun {
  /** Routing key only (matches the child session id); never rendered. */
  agentId: string;
  /** The user-visible name: the call's description, else the definition name. */
  label: string;
  /** The definition id (general-purpose / explore / fork …). */
  kind: string;
  model: string;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
  /** Total tokens of the run (null until it ends). */
  tokens: number | null;
  report: string | null;
  background: boolean;
  /** The conv key holding this agent's live transcript. */
  convKey: string;
}

/** The conv key of one agent: unique per parent, stable across events. */
export function agentConvKey(parentKey: string, agentId: string): string {
  return `${parentKey}::agent::${agentId}`;
}

export function newSubagentRun(
  start: { agentId: string; label: string; kind: string; model: string; background: boolean },
  parentKey: string,
  now: number,
): SubagentRun {
  return {
    agentId: start.agentId,
    label: displayLabel(start.label, start.kind),
    kind: start.kind,
    model: start.model,
    status: "running",
    startedAt: now,
    endedAt: null,
    tokens: null,
    report: null,
    background: start.background,
    convKey: agentConvKey(parentKey, start.agentId),
  };
}

/**
 * A start event: append a new row, or flip an existing one back to running
 * (SendMessage resumes an agent that already finished — same agent, new turn).
 * The label of an existing row wins: the resume event only knows the
 * definition, the original description is the better name.
 */
export function applyStart(
  runs: SubagentRun[],
  start: { agentId: string; label: string; kind: string; model: string; background: boolean },
  parentKey: string,
  now: number,
): SubagentRun[] {
  const index = runs.findIndex((run) => run.agentId === start.agentId);
  if (index < 0) return [...runs, newSubagentRun(start, parentKey, now)];
  return runs.map((run, i) =>
    i === index
      ? {
          ...run,
          status: "running",
          startedAt: now,
          endedAt: null,
          tokens: null,
          report: null,
        }
      : run,
  );
}

/** An end event: freeze the row. Unknown ids are ignored (an end without a start). */
export function applyEnd(
  runs: SubagentRun[],
  end: { agentId: string; ok: boolean; stopped: boolean; report: string; tokens: number },
  now: number,
): SubagentRun[] {
  return runs.map((run) =>
    run.agentId === end.agentId
      ? {
          ...run,
          status: end.stopped ? "stopped" : end.ok ? "done" : "failed",
          endedAt: now,
          tokens: end.tokens,
          report: end.report,
        }
      : run,
  );
}

/** The runs of one parent, in start order (the strip's order). */
export function runsOf(runs: SubagentRun[]): SubagentRun[] {
  return [...runs].sort((a, b) => a.startedAt - b.startedAt);
}

export function runningCount(runs: SubagentRun[]): number {
  return runs.filter((run) => run.status === "running").length;
}

/** The status word of a row. */
export function statusLabel(status: SubagentStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
    case "stopped":
      return "已停止";
  }
}

/** Elapsed milliseconds of a row (frozen at `endedAt` once it finishes). */
export function elapsedMs(run: SubagentRun, now: number): number {
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

/** `2.1k tokens` / `860 tokens`; empty before the count is known. */
export function tokenLabel(tokens: number | null): string {
  if (tokens == null || tokens <= 0) return "";
  if (tokens < 1000) return `${tokens} tokens`;
  const k = tokens / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k tokens`;
}

/** A label that never leaks an internal id: the description, else the kind, else a generic word. */
function displayLabel(label: string, kind: string): string {
  const trimmed = label.trim();
  if (trimmed) return trimmed;
  const kindName = kind.trim();
  if (kindName) return kindName;
  return "子代理";
}

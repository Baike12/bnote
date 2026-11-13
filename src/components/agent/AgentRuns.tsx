import { useEffect, useState } from "react";
import { workDurationLabel } from "./toolSummary";
import {
  elapsedMs,
  runningCount,
  runsOf,
  statusLabel,
  tokenLabel,
  type SubagentRun,
} from "./subagents";

/**
 * The subagent overview above the transcript: one line per agent the current
 * conversation dispatched.
 *
 * Why a strip and not only the Agent tool card: the card scrolls away with the
 * turn, while "which agents are running right now" has to stay visible in a
 * side panel whose transcript is long. ZCode solves it with a status-panel
 * group, Zed with per-card spinners plus a full-screen view; this is the flat
 * version of both — the rows live in one place and a row click drills into that
 * agent's own timeline.
 *
 * The rows never show the agent id: the label is the description the model
 * wrote for the task, which is what a user can actually recognize.
 */
export function AgentRuns({
  runs,
  activeKey,
  onOpen,
  onStop,
}: {
  runs: SubagentRun[];
  /** The conv currently on screen (the row of a drilled-in agent is marked). */
  activeKey: string | null;
  onOpen: (convKey: string) => void;
  onStop: (run: SubagentRun) => void;
}) {
  const ordered = runsOf(runs);
  const running = runningCount(ordered);
  // null = automatic (open while something runs); a click pins the choice,
  // the same rule the turn's work section follows.
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? running > 0;
  // One second of interval for the whole strip, only while it matters.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (running === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (ordered.length === 0) return null;
  // A controlled disclosure, not <details>: the rows are rendered only while
  // open, so a collapsed strip costs no layout and the open state has exactly
  // one writer (this component).
  return (
    <div className="agent-runs">
      <button className="agent-runs-head" aria-expanded={open} onClick={() => setPinned(!open)}>
        <span className={`agent-runs-dot${running > 0 ? " is-running" : ""}`} aria-hidden="true" />
        <span className="agent-runs-title">代理</span>
        <span className="agent-runs-count">
          {running > 0 ? `${running} 运行中` : `${ordered.length} 个已结束`}
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
        <div className="agent-runs-body">
          {ordered.map((run) => (
            <AgentRunRow
              key={run.agentId}
              run={run}
              now={now}
              onScreen={run.convKey === activeKey}
              onOpen={() => onOpen(run.convKey)}
              onStop={() => onStop(run)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRunRow({
  run,
  now,
  onScreen,
  onOpen,
  onStop,
}: {
  run: SubagentRun;
  now: number;
  onScreen: boolean;
  onOpen: () => void;
  onStop: () => void;
}) {
  const live = run.status === "running";
  const meta = [workDurationLabel(elapsedMs(run, now)), tokenLabel(run.tokens)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={`agent-run${onScreen ? " is-active" : ""}`}
      data-status={run.status}
      role="button"
      tabIndex={0}
      title={run.report ?? run.label}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className={`agent-run-dot is-${run.status}`} aria-hidden="true" />
      <span className="agent-run-label">{run.label}</span>
      <span className="agent-run-meta">
        {live ? meta || "刚刚开始" : `${statusLabel(run.status)}${meta ? ` · ${meta}` : ""}`}
      </span>
      {live && (
        <button
          className="agent-run-stop"
          title="停止这个子代理"
          aria-label="停止这个子代理"
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
            aria-hidden="true"
            width="10"
            height="10"
          >
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      )}
    </div>
  );
}

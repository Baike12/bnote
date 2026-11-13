import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  agentConvKey,
  applyEnd,
  applyStart,
  elapsedMs,
  newSubagentRun,
  statusLabel,
  tokenLabel,
  type SubagentRun,
} from "./subagents";

/**
 * The subagent rows the panel lists.
 *
 * What is pinned here is what the user reads and how the rows survive the two
 * awkward cases: a resumed agent (a second `subagent_start` for an id that
 * already has a row) and an `end` that arrives without a start. The id is a
 * routing key and must never become a label.
 */

const start = (agentId: string, label = "调研 API", toolUseId = `call-${agentId}`) => ({
  agentId,
  toolUseId,
  label,
  kind: "general-purpose",
  model: "deepseek-flash",
  background: false,
});

describe("subagent rows", () => {
  it("use the task description as the label, never the id", () => {
    const run = newSubagentRun(start("s1-7-agent-1-1"), "c1", 1000);
    expect(run.label).toBe("调研 API");
    expect(run.label).not.toContain("agent-");
  });

  it("fall back to the definition name when the model wrote no description", () => {
    const run = newSubagentRun(start("a1", ""), "c1", 1000);
    expect(run.label).toBe("general-purpose");
  });

  it("append one row per agent, in start order", () => {
    let runs: SubagentRun[] = [];
    runs = applyStart(runs, start("a1", "第一"), "c1", 1000);
    runs = applyStart(runs, start("a2", "第二"), "c1", 2000);
    expect(runs.map((r) => r.label)).toEqual(["第一", "第二"]);
  });

  it("a resumed agent flips back to running instead of adding a second row", () => {
    // SendMessage resumes an agent that already finished: same agent, new turn.
    let runs = applyStart([], start("a1", "原始任务"), "c1", 1000);
    runs = applyEnd(
      runs,
      { agentId: "a1", ok: true, stopped: false, report: "done", tokens: 1200 },
      2000,
    );
    expect(runs[0]?.status).toBe("done");
    runs = applyStart(runs, start("a1", "general-purpose"), "c1", 3000);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.label).toBe("原始任务");
    expect(runs[0]?.report).toBeNull();
    expect(runs.filter((run) => run.status === "running")).toHaveLength(1);
  });

  it("keep the same conv key across a resume (the transcript stays readable)", () => {
    const key = agentConvKey("c1", "a1");
    let runs = applyStart([], start("a1"), "c1", 1000);
    runs = applyEnd(runs, { agentId: "a1", ok: true, stopped: false, report: "", tokens: 0 }, 2000);
    runs = applyStart(runs, start("a1"), "c1", 3000);
    expect(runs[0]?.convKey).toBe(key);
  });

  it("keep the card at the call that created the agent when it is resumed", () => {
    // The resume rides on a SendMessage row, not on a second Agent call: the
    // card must stay where the agent was dispatched.
    let runs = applyStart([], start("a1", "原始任务", "call-first"), "c1", 1000);
    runs = applyEnd(runs, { agentId: "a1", ok: true, stopped: false, report: "", tokens: 0 }, 2000);
    runs = applyStart(runs, start("a1", "general-purpose", "call-resume"), "c1", 3000);
    expect(runs[0]?.toolUseId).toBe("call-first");
  });

  it("close a row as done, failed or stopped", () => {
    let runs = applyStart([], start("a1"), "c1", 1000);
    runs = applyStart(runs, start("a2"), "c1", 1000);
    runs = applyStart(runs, start("a3"), "c1", 1000);
    runs = applyEnd(
      runs,
      { agentId: "a1", ok: true, stopped: false, report: "r", tokens: 10 },
      4000,
    );
    runs = applyEnd(
      runs,
      { agentId: "a2", ok: false, stopped: false, report: "boom", tokens: 5 },
      4000,
    );
    runs = applyEnd(runs, { agentId: "a3", ok: false, stopped: true, report: "", tokens: 5 }, 4000);
    expect(runs.map((r) => r.status)).toEqual(["done", "failed", "stopped"]);
    expect(statusLabel("stopped")).toBe("已停止");
    expect(statusLabel("failed")).toBe("失败");
  });

  it("ignore an end whose start was missed", () => {
    const runs = applyEnd(
      [],
      { agentId: "ghost", ok: true, stopped: false, report: "", tokens: 0 },
      1,
    );
    expect(runs).toEqual([]);
  });

  it("freeze the elapsed clock at the end and keep counting while running", () => {
    let runs = applyStart([], start("a1"), "c1", 1000);
    expect(elapsedMs(runs[0]!, 3500)).toBe(2500);
    runs = applyEnd(runs, { agentId: "a1", ok: true, stopped: false, report: "", tokens: 0 }, 4000);
    expect(elapsedMs(runs[0]!, 90_000)).toBe(3000);
  });
});

describe("token labels", () => {
  it("stay short and readable", () => {
    expect(tokenLabel(null)).toBe("");
    expect(tokenLabel(0)).toBe("");
    expect(tokenLabel(860)).toBe("860 tokens");
    expect(tokenLabel(2100)).toBe("2.1k tokens");
    expect(tokenLabel(42_000)).toBe("42k tokens");
  });
});

/**
 * The id must stay a routing key. A user-facing row that prints it is the
 * defect this module exists to remove, so the render paths are pinned by
 * source: the strip and the tool card never interpolate an agent id.
 */
describe("no agent id on screen", () => {
  const transcript = readFileSync("src/components/agent/Transcript.tsx", "utf8");

  it("the subagent card renders the label, never the id", () => {
    // `agentId`/`toolUseId` are routing keys: any interpolation of them into a
    // text node would print them on screen. The card's visible name is the
    // description the model wrote.
    expect(transcript).toContain("{run.label}");
    expect(transcript).not.toContain("{run.agentId}");
    expect(transcript).not.toContain("{run.toolUseId}");
  });

  it("the Agent tool card drops the model-addressed trailer", () => {
    expect(transcript).toContain("stripAgentTrailer");
  });

  it("the panel feeds the cards from its own convs and pins no strip", () => {
    // One display model: the card lives in the transcript at the Agent call.
    // A second, sticky list would be a second writer of the same thing.
    const panel = readFileSync("src/components/agent/AgentPanel.tsx", "utf8");
    expect(panel).toContain("collectAgentCards(convs)");
    expect(panel).toContain("agents={agentCards}");
    expect(panel).not.toContain("AgentRuns");
  });
});

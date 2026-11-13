import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/tauri";
import { finalText, type Conv, type Turn } from "./model";
import { createStreamHandler, type StreamContext } from "./streamEvents";

/** One step as a short label: the row order is what these tests pin down. */
function rows(turn: Turn | undefined): string[] {
  return (turn?.steps ?? []).map((step) =>
    step.kind === "thinking"
      ? `think:${step.start}`
      : step.kind === "text"
        ? `text:${step.start}-${step.end}`
        : step.id,
  );
}

/**
 * The stream reducer's contract: what one backend event does to the
 * conversation. This is the layer that used to be reachable only through the
 * mounted panel, so the ordering rules (a round's thinking before its tool
 * rows, one record flush per round) had no test at all.
 */

function makeConv(key: string, sessionId: string | null): Conv {
  return {
    key,
    sessionId,
    entries: [],
    label: "主会话",
    parent: null,
    basedOn: "",
    forkAt: 0,
    titleSource: "first-message",
    mcpErrors: [],
    transcriptPath: "/tmp/s1.jsonl",
    sessionFileId: "s1",
    model: null,
    usage: null,
    todos: [],
  };
}

function makeHarness() {
  let convs: Conv[] = [makeConv("c1", "s1")];
  const turns = new Map<string, Turn>();
  const sessionIndex = new Map<string, { convKey: string; path: string | null; home: boolean }>();
  const persisted: { convKey: string; turn: Turn; force: boolean }[] = [];
  const cleared: string[] = [];
  const closed: string[] = [];
  const scrolled: string[] = [];
  const approvals: unknown[] = [];
  const questions: unknown[] = [];

  const build = (): StreamContext => ({
    convs: () => convs,
    turns,
    sessionIndex,
    patchConvs: (patch) => {
      convs = patch(convs);
    },
    updateConv: (key, patch) => {
      convs = convs.map((c) => (c.key === key ? patch(c) : c));
    },
    persistTurn: (convKey, turn, _pathOverride, force = true) => {
      persisted.push({ convKey, turn, force });
    },
    clearBusy: (sessionId) => cleared.push(sessionId),
    setApproval: (a) => approvals.push(a),
    setPendingQuestion: (q) => questions.push(q),
    setPlanActive: () => {},
    onTurnClosed: (convKey) => closed.push(convKey),
    afterEvent: (convKey) => scrolled.push(convKey),
  });

  const handler = createStreamHandler(build());
  const send = (event: AgentEvent) => handler("s1", event);
  const entry = () => convs[0]?.entries[0];
  return { send, convs: () => convs, entry, turns, persisted, cleared, closed, scrolled };
}

describe("stream events: the work rows keep the stream order", () => {
  it("interleaves two rounds' thinking and tools, then commits one turn", () => {
    const h = makeHarness();
    h.send({ type: "thinking_delta", text: "look" });
    h.send({ type: "thinking_block_end", signature: "sig1" });
    h.send({ type: "tool_start", id: "t1", name: "Read", input: {} });
    h.send({ type: "tool_end", id: "t1", ok: true, output: "ok" });
    h.send({ type: "thinking_delta", text: "read" });
    h.send({ type: "tool_start", id: "t2", name: "Grep", input: {} });
    h.send({ type: "tool_end", id: "t2", ok: true, output: "x" });
    h.send({ type: "text_delta", text: "done" });
    h.send({ type: "turn_end", reason: "end_turn", items: 3 });

    const turn = h.entry()?.turn;
    expect(h.entry()?.role).toBe("assistant");
    expect(turn?.text).toBe("done");
    expect(turn?.thinking).toBe("lookread");
    // The rows are in arrival order, not "all thinking, then all tools".
    expect(rows(turn)).toEqual(["think:0", "t1", "think:4", "t2", "text:0-4"]);
    // The trailing text is the answer drawn below the work section.
    expect(turn ? finalText(turn) : null).toBe("done");
    expect(turn?.thinkingSeals).toEqual([{ end: 4, signature: "sig1" }]);
    // The live turn is finished and handed off.
    expect(h.turns.has("c1")).toBe(false);
    expect(h.cleared).toEqual(["s1"]);
    expect(h.closed).toEqual(["c1"]);
    // Every handled event lets the on-screen transcript follow; only the
    // unknown-session path returns before it.
    expect(h.scrolled).toHaveLength(9);
    expect(new Set(h.scrolled)).toEqual(new Set(["c1"]));
    // The final flush wrote the whole turn (thinking + tools + text).
    expect(h.persisted[h.persisted.length - 1]).toMatchObject({ convKey: "c1", force: true });
  });

  it("a thinking delta after a tool row opens a new block instead of extending the closed one", () => {
    const h = makeHarness();
    h.send({ type: "thinking_delta", text: "a" });
    h.send({ type: "tool_start", id: "t1", name: "Read", input: {} });
    h.send({ type: "thinking_delta", text: "b" });

    const turn = h.turns.get("c1");
    expect(turn?.steps.map((step) => step.kind)).toEqual(["thinking", "tool", "thinking"]);
    expect(turn?.thinking).toBe("ab");
  });

  it("the text delta closes the thinking block and opens a text row (its duration is frozen, the answer starts)", () => {
    const h = makeHarness();
    h.send({ type: "thinking_delta", text: "a" });
    h.send({ type: "text_delta", text: "answer" });

    const turn = h.turns.get("c1");
    const first = turn?.steps[0];
    expect(first?.kind === "thinking" ? first.seconds : null).not.toBeNull();
    expect(rows(turn)).toEqual(["think:0", "text:0-6"]);
  });

  it("mid-turn narration keeps its place instead of piling up after the last tool call", () => {
    const h = makeHarness();
    // Round one: a preamble, then its tool calls.
    h.send({ type: "text_delta", text: "先定位" });
    h.send({ type: "tool_start", id: "t1", name: "Grep", input: {} });
    h.send({ type: "tool_end", id: "t1", ok: true, output: "x" });
    // Round two: another preamble, another batch.
    h.send({ type: "text_delta", text: "再看" });
    h.send({ type: "tool_start", id: "t2", name: "Read", input: {} });
    h.send({ type: "tool_end", id: "t2", ok: true, output: "y" });
    // Round three: the answer.
    h.send({ type: "text_delta", text: "结论" });
    h.send({ type: "turn_end", reason: "end_turn", items: 5 });

    const turn = h.entry()?.turn;
    expect(rows(turn)).toEqual(["text:0-3", "t1", "text:3-5", "t2", "text:5-7"]);
    // Only the last stretch is the answer; the two preambles stay in the work rows.
    expect(turn ? finalText(turn) : null).toBe("结论");
    expect(turn?.text).toBe("先定位再看结论");
  });

  it("a turn that ends on a tool round has no answer text outside the work rows", () => {
    const h = makeHarness();
    h.send({ type: "text_delta", text: "先看看" });
    h.send({ type: "tool_start", id: "t1", name: "Bash", input: {} });
    h.send({ type: "tool_end", id: "t1", ok: true, output: "ok" });
    h.send({ type: "turn_end", reason: "max_turns", items: 2 });

    const turn = h.entry()?.turn;
    expect(turn ? finalText(turn) : null).toBe("");
    expect(rows(turn)).toEqual(["text:0-3", "t1"]);
  });

  it("a stopped turn keeps the reason, so the row reads 已停止 instead of 已工作", () => {
    const h = makeHarness();
    h.send({ type: "thinking_delta", text: "working" });
    h.send({ type: "tool_start", id: "t1", name: "Bash", input: {} });
    h.send({ type: "turn_end", reason: "aborted", items: 2 });

    const turn = h.entry()?.turn;
    expect(turn?.stopReason).toBe("aborted");
    expect(h.cleared).toEqual(["s1"]);
  });
});

describe("stream events: sessions that are not on screen", () => {
  it("an event for an unknown session is dropped, but a terminating event still clears the busy flag", () => {
    const h = makeHarness();
    // The conv left the list (material switched): nothing owns this session id any more.
    h.convs()[0].sessionId = "other";
    h.send({ type: "thinking_delta", text: "half an answer" });
    expect(h.turns.size).toBe(0);
    h.send({ type: "turn_end", reason: "end_turn", items: 1 });
    expect(h.cleared).toEqual(["s1"]);
    expect(h.closed).toEqual([]);
  });

  it("permission requests and questions do not touch the transcript", () => {
    const h = makeHarness();
    h.send({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "ls" } });
    h.send({ type: "question", id: "q1", questions: [{ question: "which?" }] });
    expect(h.convs()[0].entries).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });
});

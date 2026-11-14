import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/tauri";
import type { ApprovalRequest } from "@/components/agent/ApprovalCard";
import type { PendingQuestion } from "@/components/agent/QuestionCard";
import { finalText, newTurn, type Conv, type Turn } from "./model";
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
  const persisted: { convKey: string; turn: Turn; path?: string; force: boolean }[] = [];
  const cleared: string[] = [];
  const closed: string[] = [];
  const scrolled: string[] = [];
  const approvals: (ApprovalRequest | null)[] = [];
  const questions: (PendingQuestion | null)[] = [];
  const plans: boolean[] = [];
  const subagentStarts: string[] = [];
  const subagentEnds: string[] = [];

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
    persistTurn: (convKey, turn, pathOverride, force = true) => {
      persisted.push({ convKey, turn, path: pathOverride, force });
    },
    clearBusy: (sessionId) => cleared.push(sessionId),
    setApproval: (a) => approvals.push(a),
    setPendingQuestion: (q) => questions.push(q),
    setPlanActive: (active) => plans.push(active),
    onTurnClosed: (convKey) => closed.push(convKey),
    onSubagentStart: (_parent, event) => subagentStarts.push(event.agentId),
    onSubagentEnd: (_parent, event) => subagentEnds.push(event.agentId),
    afterEvent: (convKey) => scrolled.push(convKey),
  });

  const handler = createStreamHandler(build());
  const send = (event: AgentEvent) => handler("s1", event);
  const entry = () => convs[0]?.entries[0];
  return {
    send,
    convs: () => convs,
    entry,
    turns,
    sessionIndex,
    persisted,
    cleared,
    closed,
    scrolled,
    approvals,
    questions,
    plans,
    subagentStarts,
    subagentEnds,
  };
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

describe("stream events: the streaming draft keeps one entry", () => {
  it("a delta after a notice opens a new assistant entry instead of editing the notice", () => {
    const h = makeHarness();
    h.send({ type: "notice", text: "子代理完成" });
    h.send({ type: "text_delta", text: "答" });
    const entries = h.convs()[0]?.entries ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: "notice" });
    expect(entries[1]).toMatchObject({ role: "assistant", text: "答" });
    expect(entries[1]?.turn).toBe(h.turns.get("c1"));
  });

  it("an existing draft of another turn is not extended", () => {
    const h = makeHarness();
    // A restored entry of an earlier turn sits at the end of the list.
    h.convs()[0].entries.push({ role: "assistant", text: "旧答", at: 1, items: null });
    h.send({ type: "text_delta", text: "新答" });
    const entries = h.convs()[0]?.entries ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[1]?.text).toBe("新答");
  });

  it("a turn with no start time never claims a duration", () => {
    const h = makeHarness();
    h.turns.set("c1", newTurn(null));
    h.send({ type: "turn_end", reason: "end_turn", items: 0 });
    const turn = h.convs()[0]?.entries[0]?.turn;
    expect(turn?.startedAt).toBeNull();
    expect(turn?.turnMs).toBeNull();
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

  it("still writes the round of a switched-away session into its own record", () => {
    const h = makeHarness();
    // The conv left the list, but its live turn and record path are indexed.
    const turn = newTurn(1_000);
    turn.text = "半句话";
    h.turns.set("c1", turn);
    h.sessionIndex.set("s1", { convKey: "c1", path: "/v/old.jsonl", home: false });
    h.convs()[0].sessionId = "other";

    h.send({ type: "turn_end", reason: "end_turn", items: 1 });

    expect(h.persisted).toEqual([{ convKey: "c1", turn, path: "/v/old.jsonl", force: true }]);
    expect(turn.turnMs).not.toBeNull();
    expect(h.turns.has("c1")).toBe(false);
    expect(h.cleared).toEqual(["s1"]);
    // The index entry is consumed: a late duplicate cannot write the turn twice.
    h.send({ type: "turn_end", reason: "end_turn", items: 1 });
    expect(h.persisted).toHaveLength(1);
    expect(h.scrolled).toEqual([]);
  });

  it("a terminating event on a switched-away session without a live turn only clears busy", () => {
    const h = makeHarness();
    // The index knows the record but the live turn is gone (already committed).
    h.sessionIndex.set("s1", { convKey: "c1", path: "/v/old.jsonl", home: false });
    h.convs()[0].sessionId = "other";
    h.send({ type: "error", message: "boom", items: 0 });
    expect(h.persisted).toHaveLength(0);
    expect(h.cleared).toEqual(["s1"]);
    expect(h.sessionIndex.has("s1")).toBe(false);
  });

  it("a switched-away turn that already has its duration keeps it (no second measurement)", () => {
    const h = makeHarness();
    const turn = newTurn(1_000);
    turn.turnMs = 4_000;
    h.turns.set("c1", turn);
    h.sessionIndex.set("s1", { convKey: "c1", path: "/v/old.jsonl", home: false });
    h.convs()[0].sessionId = "other";
    h.send({ type: "turn_end", reason: "end_turn", items: 1 });
    expect(turn.turnMs).toBe(4_000);
  });

  it("a terminating error on a switched-away session freezes the live turn and persists it with its override path", () => {
    const h = makeHarness();
    const turn = newTurn(1_000);
    turn.text = "partial";
    h.turns.set("c1", turn);
    h.sessionIndex.set("s1", { convKey: "c1", path: null, home: false });
    h.convs()[0].sessionId = "other";

    h.send({ type: "error", message: "gateway 500", items: 0 });

    expect(turn.error).toBe("gateway 500");
    expect(turn.turnMs).not.toBeNull();
    // No path in the index: the writer resolves the conv's own record.
    expect(h.persisted).toEqual([{ convKey: "c1", turn, path: undefined, force: true }]);
    expect(h.cleared).toEqual(["s1"]);
  });
});

describe("stream events: subagent lifecycle stays out of the transcript", () => {
  it("forwards start and end to the panel without adding an entry", () => {
    const h = makeHarness();
    h.send({
      type: "subagent_start",
      agentId: "a1",
      toolUseId: "call-1",
      label: "调研 API",
      kind: "general-purpose",
      model: "deepseek",
      background: false,
    });
    h.send({
      type: "subagent_end",
      agentId: "a1",
      ok: true,
      stopped: false,
      report: "done",
      durationMs: 900,
      tokens: 12,
    });
    expect(h.subagentStarts).toEqual(["a1"]);
    expect(h.subagentEnds).toEqual(["a1"]);
    expect(h.convs()[0]?.entries).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });
});

describe("stream events: event kinds that never touch the transcript", () => {
  it("usage replaces the conv's token counters", () => {
    const h = makeHarness();
    h.send({
      type: "usage",
      input: 100,
      output: 20,
      cacheRead: 30,
      sessionInput: 400,
      sessionCacheRead: 90,
      sessionRequests: 2,
    });
    expect(h.convs()[0]?.usage).toEqual({
      input: 100,
      output: 20,
      cacheRead: 30,
      sessionInput: 400,
      sessionCacheRead: 90,
      sessionRequests: 2,
    });
    expect(h.convs()[0]?.entries).toHaveLength(0);
  });

  it("todos replaces the session's list", () => {
    const h = makeHarness();
    h.send({
      type: "todos",
      todos: [{ content: "读代码", status: "in_progress", active_form: "读代码中" }],
    });
    expect(h.convs()[0]?.todos).toEqual([
      { content: "读代码", status: "in_progress", active_form: "读代码中" },
    ]);
  });

  it("tasks is acknowledged but adds nothing (the tool cards are the record)", () => {
    const h = makeHarness();
    h.send({
      type: "tasks",
      tasks: [
        {
          id: "1",
          subject: "a",
          description: "",
          active_form: "",
          status: "pending",
          blocks: [],
          blocked_by: [],
        },
      ],
    });
    expect(h.convs()[0]?.entries).toHaveLength(0);
    expect(h.scrolled).toEqual(["c1"]);
  });

  it("a notice is a display-only entry and is never persisted", () => {
    const h = makeHarness();
    h.send({ type: "notice", text: "正在压缩上下文" });
    expect(h.convs()[0]?.entries).toHaveLength(1);
    expect(h.convs()[0]?.entries[0]).toMatchObject({ role: "notice", text: "正在压缩上下文" });
    expect(h.persisted).toHaveLength(0);
  });
});

describe("stream events: the docked cards", () => {
  it("a permission request carries the session and its tool", () => {
    const h = makeHarness();
    h.send({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "rm -rf x" } });
    expect(h.approvals).toEqual([
      { sessionId: "s1", id: "p1", tool: "Bash", input: { command: "rm -rf x" } },
    ]);
  });

  it("a question is narrowed before it reaches the card", () => {
    const h = makeHarness();
    h.send({
      type: "question",
      id: "q1",
      questions: [
        { question: "装哪个?", options: [{ label: "A" }, { nope: 1 }, null] },
        { nope: true },
      ],
    });
    expect(h.questions).toHaveLength(1);
    const pending = h.questions[0];
    expect(pending?.sessionId).toBe("s1");
    expect(pending?.id).toBe("q1");
    // The unusable items are dropped instead of rendering an empty card.
    expect(pending?.questions).toEqual([
      {
        question: "装哪个?",
        header: undefined,
        multiSelect: false,
        options: [{ label: "A", description: undefined }],
      },
    ]);
  });

  it("plan mode toggles the flag and leaves a readable notice", () => {
    const h = makeHarness();
    h.send({ type: "plan_mode", enabled: true });
    h.send({ type: "plan_mode", enabled: false });
    expect(h.plans).toEqual([true, false]);
    const notices = h.convs()[0]?.entries.map((e) => e.text) ?? [];
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("计划模式");
    expect(notices[1]).toContain("恢复编辑");
    expect(h.persisted).toHaveLength(0);
  });
});

describe("stream events: a turn that fails without streaming", () => {
  it("an error with no live turn becomes an assistant entry that is written to the record", () => {
    const h = makeHarness();
    h.send({ type: "error", message: "连接失败", items: 0 });
    const entry = h.convs()[0]?.entries[0];
    expect(entry).toMatchObject({ role: "assistant", text: "", items: null });
    expect(entry?.turn?.error).toBe("连接失败");
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]?.turn.error).toBe("连接失败");
    expect(h.persisted[0]?.force).toBe(true);
    expect(h.cleared).toEqual(["s1"]);
    // No turn was committed, so nothing may be reported as "a whole turn".
    expect(h.closed).toEqual([]);
  });

  it("an error after items were counted keeps the count on the entry", () => {
    const h = makeHarness();
    h.send({ type: "error", message: "boom", items: 3 });
    expect(h.convs()[0]?.entries[0]?.items).toBe(3);
  });

  it("an error with a live turn commits it with the message instead of adding a second entry", () => {
    const h = makeHarness();
    h.send({ type: "text_delta", text: "答了一半" });
    h.send({ type: "error", message: "连接中断", items: 0 });

    const entries = h.convs()[0]?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.turn?.error).toBe("连接中断");
    expect(entries[0]?.turn?.text).toBe("答了一半");
    expect(h.turns.has("c1")).toBe(false);
    // The committed turn is flushed once, with the error inside it.
    expect(h.persisted[h.persisted.length - 1]?.turn.error).toBe("连接中断");
    expect(h.cleared).toEqual(["s1"]);
    // A failed turn is not a successfully closed one.
    expect(h.closed).toEqual([]);
  });
});

describe("stream events: a turn end with no live turn", () => {
  it("still closes the busy flag and reports the turn, writing nothing", () => {
    const h = makeHarness();
    h.send({ type: "turn_end", reason: "end_turn", items: 2 });
    expect(h.convs()[0]?.entries).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
    expect(h.closed).toEqual(["c1"]);
    expect(h.cleared).toEqual(["s1"]);
  });
});

describe("stream events: one conversation's events never touch another", () => {
  it("a delta for c1 leaves c2's entries alone", () => {
    const h = makeHarness();
    h.convs().push(makeConv("c2", "s2"));
    h.send({ type: "text_delta", text: "只属于 c1" });
    expect(h.convs()[1]?.entries).toHaveLength(0);
    expect(h.convs()[0]?.entries[0]?.text).toBe("只属于 c1");
  });
});

describe("stream events: events without a live turn are no-ops", () => {
  it("a tool end and a thinking seal for a turn that never started change nothing", () => {
    const h = makeHarness();
    h.send({ type: "tool_end", id: "t1", ok: true, output: "x" });
    h.send({ type: "thinking_block_end", signature: "sig" });
    expect(h.turns.size).toBe(0);
    expect(h.convs()[0]?.entries).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });

  it("a tool end updates only the call it names", () => {
    const h = makeHarness();
    h.send({ type: "tool_start", id: "t1", name: "Read", input: {} });
    h.send({ type: "tool_start", id: "t2", name: "Write", input: {} });
    h.send({ type: "tool_end", id: "t2", ok: false, output: "denied" });
    const tools = h.turns.get("c1")?.tools ?? [];
    expect(tools[0]).toMatchObject({ id: "t1" });
    expect(tools[0]?.output).toBeUndefined();
    expect(tools[1]).toMatchObject({ id: "t2", ok: false, output: "denied" });
  });
});

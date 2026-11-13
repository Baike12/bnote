import { describe, expect, it, vi } from "vitest";
import { collectAgentCards, createAgentCards } from "./agentCards";
import type { ChatEntry, Conv } from "./model";
import { newSubagentRun, type SubagentRun } from "./subagents";

/**
 * The card registry: the map the transcript's rows subscribe to.
 *
 * What is pinned here is the reference discipline, because it is the whole
 * reason the registry exists: a child streams tens of deltas per second and the
 * parent transcript must not re-render for them. A card keeps its object until
 * its own run or entries move, and an unchanged write wakes nobody.
 */

function conv(key: string, extra: Partial<Conv> = {}): Conv {
  return {
    key,
    sessionId: null,
    entries: [],
    label: key,
    parent: null,
    basedOn: "",
    forkAt: 0,
    titleSource: "first-message",
    mcpErrors: [],
    transcriptPath: null,
    sessionFileId: null,
    model: null,
    usage: null,
    todos: [],
    ...extra,
  };
}

function entry(text: string): ChatEntry {
  return { role: "assistant", text, at: 1, items: null };
}

function run(agentId: string, toolUseId: string, parentKey = "p"): SubagentRun {
  return newSubagentRun(
    {
      agentId,
      toolUseId,
      label: "调研 API",
      kind: "general-purpose",
      model: "deepseek-flash",
      background: false,
    },
    parentKey,
    1000,
  );
}

describe("collectAgentCards", () => {
  it("keys each agent by the Agent call that launched it", () => {
    const child = conv("p::agent::a1", { sessionId: "a1", entries: [entry("看到了")] });
    const parent = conv("p", { agents: [run("a1", "call-1")] });
    const cards = collectAgentCards([parent, child]);
    expect([...cards.keys()]).toEqual(["call-1"]);
    expect(cards.get("call-1")?.run.agentId).toBe("a1");
    expect(cards.get("call-1")?.entries).toBe(child.entries);
  });

  it("skips a run with no tool call (an older backend) and a child that is gone", () => {
    const noCall = { ...run("a1", ""), toolUseId: "" };
    const parent = conv("p", { agents: [noCall, run("a2", "call-2")] });
    const cards = collectAgentCards([parent]);
    expect([...cards.keys()]).toEqual(["call-2"]);
    // The child conv is missing: the card still exists (the run does), empty.
    expect(cards.get("call-2")?.entries).toEqual([]);
  });
});

describe("the card registry", () => {
  it("hands out the same reference until that card changes", () => {
    const cards = createAgentCards();
    const runA = run("a1", "call-1");
    const runB = run("b1", "call-2");
    const first = new Map([
      ["call-1", { run: runA, entries: [] }],
      ["call-2", { run: runB, entries: [] }],
    ]);
    cards.replace(first);
    const a = cards.get("call-1");
    expect(a).toBe(cards.get("call-1"));
    // The same content again: nothing changed, so the references survive.
    cards.replace(
      new Map([
        ["call-1", { run: runA, entries: a?.entries ?? [] }],
        ["call-2", { run: runB, entries: [] }],
      ]),
    );
    expect(cards.get("call-1")).toBe(a);
  });

  it("wakes the subscribers only when a card actually moved", () => {
    const cards = createAgentCards();
    const listener = vi.fn();
    cards.subscribe(listener);
    const runA = run("a1", "call-1");
    const entriesA: ChatEntry[] = [];
    cards.replace(new Map([["call-1", { run: runA, entries: entriesA }]]));
    expect(listener).toHaveBeenCalledTimes(1);
    cards.replace(new Map([["call-1", { run: runA, entries: entriesA }]]));
    expect(listener).toHaveBeenCalledTimes(1);
    // One delta on the child: that card changes (new run object, new entries
    // array), the wake happens once.
    cards.replace(new Map([["call-1", { run: { ...runA }, entries: [entry("hi")] }]]));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(cards.get("call-1")?.entries).toHaveLength(1);
  });

  it("unsubscribes", () => {
    const cards = createAgentCards();
    const listener = vi.fn();
    const off = cards.subscribe(listener);
    off();
    cards.replace(new Map([["call-1", { run: run("a1", "call-1"), entries: [] }]]));
    expect(listener).not.toHaveBeenCalled();
  });
});

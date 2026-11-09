import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendThinking, closeThinking, newTurn, pushToolStep } from "./model";
import { createTranscriptWriter } from "./transcriptWriter";

/**
 * The record writer's contract: one append per completed round, the metadata
 * line exactly once and first, and every write of one record in queue order.
 * The panel used to hold this code inline; these are the rules that were only
 * reachable through the mounted panel before.
 */

const sink = vi.hoisted(() => ({
  appended: [] as { target: string; data: string }[],
  /** When set, the next append waits for it (the slow write of the ordering test). */
  gate: null as Promise<void> | null,
  refresh: 0,
}));

vi.mock("@/study/transcriptIO", () => ({
  transcriptIO: (home: boolean) => ({
    read: async () => null,
    write: async () => {},
    append: async (path: string, data: string) => {
      const gate = sink.gate;
      if (gate) {
        sink.gate = null;
        await gate;
      }
      sink.appended.push({ target: `${home ? "home" : "vault"}:${path}`, data });
    },
  }),
}));

function makeWriter() {
  return createTranscriptWriter({
    pathOf: () => "/v/s1.jsonl",
    homeOf: () => false,
    modelOf: () => ({
      provider: "anthropic",
      model: "m",
      baseUrl: "",
      maxTokens: 8192,
      contextWindow: 128_000,
    }),
    refreshSessions: () => {
      sink.refresh += 1;
    },
  });
}

const lines = (data: string) =>
  data
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

beforeEach(() => {
  sink.appended.length = 0;
  sink.gate = null;
  sink.refresh = 0;
});

describe("transcript writer: the metadata line", () => {
  it("rides in front of the first user message and is never written twice", async () => {
    const writer = makeWriter();
    writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    writer.persistUserLine("c1", { type: "user", at: 2, text: "再问" });
    await vi.waitFor(() => expect(sink.appended).toHaveLength(2));

    const first = lines(sink.appended[0].data);
    expect(first.map((line) => line.type)).toEqual(["meta", "user"]);
    expect(first[0]).toMatchObject({ title: "问", model: { model: "m" } });
    expect(lines(sink.appended[1].data)).toEqual([{ type: "user", at: 2, text: "再问" }]);
  });
});

describe("transcript writer: one line per provider round", () => {
  it("does not flush a round before its tool outputs are in", async () => {
    const writer = makeWriter();
    const turn = newTurn(1_000);
    appendThinking(turn, "look", 1_000);
    pushToolStep(turn, "t1", 2_000);
    turn.tools = [{ id: "t1", name: "Read", input: {} }];

    writer.persistTurn("c1", turn, undefined, false);
    await Promise.resolve();
    expect(sink.appended).toHaveLength(0);

    turn.tools = [{ id: "t1", name: "Read", input: {}, output: "ok", ok: true }];
    writer.persistTurn("c1", turn, undefined, false);
    await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
    const [line] = lines(sink.appended[0].data);
    expect(line).toMatchObject({
      type: "assistant",
      thinking: "look",
      thinkSeconds: 1,
      tools: [{ id: "t1", name: "Read", output: "ok", ok: true }],
    });
  });

  it("keeps the thinking seal only when exactly one block closed over the slice", async () => {
    const one = makeWriter();
    const turn = newTurn(1_000);
    appendThinking(turn, "look", 1_000);
    closeThinking(turn, 3_000);
    turn.thinkingSeals.push({ end: 4, signature: "sig" });
    one.persistTurn("c1", turn);

    const two = makeWriter();
    const split = newTurn(1_000);
    appendThinking(split, "ab", 1_000);
    closeThinking(split, 2_000);
    appendThinking(split, "cd", 3_000);
    closeThinking(split, 4_000);
    split.thinkingSeals.push({ end: 2, signature: "sig1" }, { end: 4, signature: "sig2" });
    two.persistTurn("c1", split);

    await vi.waitFor(() => expect(sink.appended).toHaveLength(2));
    expect(lines(sink.appended[0].data)[0]).toMatchObject({ thinkingSignature: "sig" });
    // Two blocks in one flush: neither signature covers the stored text, and a
    // false seal would be sent back to the provider on restore.
    expect(lines(sink.appended[1].data)[0].thinkingSignature).toBeUndefined();
  });
});

describe("transcript writer: one writer per record", () => {
  it("two appends land in queue order even when the first one is slow", async () => {
    let release!: () => void;
    sink.gate = new Promise<void>((resolve) => (release = resolve));
    const writer = makeWriter();
    writer.persistUserLine("c1", { type: "user", at: 1, text: "第一" });
    writer.persistUserLine("c1", { type: "user", at: 2, text: "第二" });
    // The second append may not pass the first one: the queue holds it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.appended).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(sink.appended).toHaveLength(2));
    expect(lines(sink.appended[0].data).slice(-1)[0]).toMatchObject({ text: "第一" });
    expect(lines(sink.appended[1].data)[0]).toMatchObject({ text: "第二" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendText, appendThinking, closeThinking, newTurn, pushToolStep } from "./model";
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
  /** When set, the next append rejects (the writer must swallow it). */
  fail: null as Error | null,
  refresh: 0,
}));

vi.mock("@/study/transcriptIO", () => ({
  transcriptIO: (home: boolean) => ({
    read: async () => null,
    write: async () => {},
    append: async (path: string, data: string) => {
      const fail = sink.fail;
      if (fail) {
        sink.fail = null;
        throw fail;
      }
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
  sink.fail = null;
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

describe("transcript writer: the model line", () => {
  const selection = {
    provider: "anthropic",
    model: "m2",
    baseUrl: "",
    maxTokens: 8192,
    contextWindow: 128_000,
  };

  it("waits for the metadata line: a switch before the first message records nothing", async () => {
    const writer = makeWriter();
    writer.persistModelLine("c1", selection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A record holding only a model line is listed as an empty conversation and
    // cannot be reopened; the pick survives through the metadata line instead.
    expect(sink.appended).toHaveLength(0);

    writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
    expect(lines(sink.appended[0].data)[0]).toMatchObject({ type: "meta", model: { model: "m" } });
  });

  it("appends after the metadata line once the session has a round", async () => {
    const writer = makeWriter();
    writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    writer.persistModelLine("c1", selection);
    await vi.waitFor(() => expect(sink.appended).toHaveLength(2));
    expect(lines(sink.appended[1].data)).toEqual([
      { type: "model", at: expect.any(Number), model: selection },
    ]);
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

  it("a failed write is swallowed with a warning and does not break the chain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const writer = makeWriter();
      sink.fail = new Error("disk full");
      writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      writer.persistUserLine("c1", { type: "user", at: 2, text: "再问" });
      // The next write still goes out: one lost line must not wedge the record.
      await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
      expect(sink.appended[0]?.data).toContain("再问");
    } finally {
      warn.mockRestore();
    }
  });

  it("a refresh runs after every queued mutation", async () => {
    const writer = makeWriter();
    writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    await vi.waitFor(() => expect(sink.refresh).toBe(1));
    writer.persistUserLine("c1", { type: "user", at: 2, text: "再问" });
    await vi.waitFor(() => expect(sink.refresh).toBe(2));
  });
});

describe("transcript writer: where the record lives", () => {
  it("a conv without a record path writes nothing at all", async () => {
    const writer = createTranscriptWriter({
      pathOf: () => undefined,
      homeOf: () => false,
      modelOf: () => null,
      refreshSessions: () => {
        sink.refresh += 1;
      },
    });
    writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    const turn = newTurn(1_000);
    appendText(turn, "答");
    writer.persistTurn("c1", turn);
    writer.persistModelLine("c1", {
      provider: "anthropic",
      model: "m",
      baseUrl: "",
      maxTokens: 8192,
      contextWindow: 128_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.appended).toHaveLength(0);
    expect(sink.refresh).toBe(0);
  });

  it("a coding session's record is appended through the home IO", async () => {
    const writer = createTranscriptWriter({
      pathOf: () => "/h/s1.jsonl",
      homeOf: () => true,
      modelOf: () => null,
      refreshSessions: () => {},
    });
    writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
    expect(sink.appended[0]?.target).toBe("home:/h/s1.jsonl");
  });
});

describe("transcript writer: incremental flushes", () => {
  it("a forced flush writes only the tail that is not on disk yet", async () => {
    const writer = makeWriter();
    writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    const turn = newTurn(1_000);
    appendText(turn, "第一段");
    writer.persistTurn("c1", turn);
    await vi.waitFor(() => expect(sink.appended).toHaveLength(2));
    expect(lines(sink.appended[1].data)[0]).toMatchObject({ text: "第一段" });

    appendText(turn, "第二段");
    writer.persistTurn("c1", turn);
    await vi.waitFor(() => expect(sink.appended).toHaveLength(3));
    // The second line holds the new stretch only: the record appends, never rewrites.
    expect(lines(sink.appended[2].data)[0]).toMatchObject({ text: "第二段" });
    expect(turn.persistedTextLen).toBe(turn.text.length);
  });

  it("a flush with nothing new writes nothing", async () => {
    const writer = makeWriter();
    const turn = newTurn(1_000);
    appendText(turn, "答");
    writer.persistTurn("c1", turn);
    await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
    writer.persistTurn("c1", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.appended).toHaveLength(1);
  });

  it("a non-forced flush skips a round whose tools have not all reported", async () => {
    const writer = makeWriter();
    const turn = newTurn(1_000);
    pushToolStep(turn, "t1", 1_000);
    turn.tools = [{ id: "t1", name: "Read", output: "ok", ok: true }];
    pushToolStep(turn, "t2", 2_000);
    turn.tools.push({ id: "t2", name: "Read", input: {} });
    writer.persistTurn("c1", turn, undefined, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.appended).toHaveLength(0);
    expect(turn.persistedToolCount).toBe(0);
  });

  it("a non-forced flush with no completed tool batch writes nothing (the round is still streaming)", async () => {
    const writer = makeWriter();
    const turn = newTurn(1_000);
    // The stream delta path calls persistTurn(force=false): it may only close a
    // round that already finished, never cut the current one mid-stream.
    appendThinking(turn, "想", 1_000);
    appendText(turn, "说了一半");
    writer.persistTurn("c1", turn, undefined, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.appended).toHaveLength(0);
    expect(turn.persistedTextLen).toBe(0);
  });

  it("an error alone is a reason to flush", async () => {
    const writer = makeWriter();
    const turn = newTurn(1_000);
    turn.error = "gateway 500";
    writer.persistTurn("c1", turn);
    await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
    expect(lines(sink.appended[0].data)[0]).toMatchObject({
      type: "assistant",
      error: "gateway 500",
    });
  });
});

describe("transcript writer: the metadata line is the first line", () => {
  it("markMetaWritten keeps the line off disk until the session really starts", async () => {
    const writer = makeWriter();
    writer.markMetaWritten("c1", true);
    writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
    // A restored record already has its metadata line: the first append here is
    // the message itself, not a second metadata line.
    expect(lines(sink.appended[0].data)).toEqual([{ type: "user", at: 1, text: "问" }]);
  });

  it("the first assistant round marks the metadata line as written (the user write owns it)", async () => {
    const writer = makeWriter();
    const turn = newTurn(1_000);
    appendText(turn, "答");
    writer.persistTurn("c1", turn);
    await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
    // Every session begins with a user message, which writes the metadata line;
    // the turn flush only appends its round and records that the head is there.
    expect(lines(sink.appended[0].data).map((line) => line.type)).toEqual(["assistant"]);
    writer.persistModelLine("c1", {
      provider: "anthropic",
      model: "m2",
      baseUrl: "",
      maxTokens: 8192,
      contextWindow: 128_000,
    });
    await vi.waitFor(() => expect(sink.appended).toHaveLength(2));
    expect(lines(sink.appended[1].data)[0]).toMatchObject({ type: "model" });
  });

  it("a path override writes to that file while the metadata flag follows the conv", async () => {
    const writer = makeWriter();
    const turn = newTurn(1_000);
    appendText(turn, "答");
    writer.persistTurn("c1", turn, "/v/other.jsonl");
    await vi.waitFor(() => expect(sink.appended).toHaveLength(1));
    expect(sink.appended[0]?.target).toBe("vault:/v/other.jsonl");
    expect(lines(sink.appended[0].data).map((line) => line.type)).toEqual(["assistant"]);
    // The metadata line now counts as written for c1: the next append skips it.
    appendText(turn, "再答");
    writer.persistTurn("c1", turn);
    await vi.waitFor(() => expect(sink.appended).toHaveLength(2));
    expect(lines(sink.appended[1].data).map((line) => line.type)).toEqual(["assistant"]);
  });
});

describe("transcript writer: enqueue", () => {
  it("orders arbitrary mutations through the same chain", async () => {
    const writer = makeWriter();
    const order: string[] = [];
    writer.enqueue("c1", async () => order.push("first"), "warn");
    writer.enqueue("c1", async () => order.push("second"), "warn");
    writer.enqueue("c2", async () => order.push("other"), "warn");
    await vi.waitFor(() => expect(order).toHaveLength(3));
    // One chain per record: c1's two mutations keep their order, c2 is free.
    expect(order.filter((label) => label !== "other").slice(0, 2)).toEqual(["first", "second"]);
  });
});

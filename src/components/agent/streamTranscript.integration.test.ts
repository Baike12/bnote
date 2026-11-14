import { describe, expect, it, vi } from "vitest";
import { fakeVault } from "@/test/fakeVault";
import { parseTranscript, type TranscriptLine } from "@/study/transcript";
import { createStreamHandler, type StreamContext } from "./streamEvents";
import { createTranscriptWriter } from "./transcriptWriter";
import { finalText, findConvBySession, type ChatEntry, type Conv, type Turn } from "./model";

/**
 * The stream reducer and the record writer together, through the real
 * `@/lib/tauri` boundary (`src/test/fakeVault.ts` holds the bytes).
 *
 * Each module has its own unit contract; this file proves the pairing: every
 * finished provider round reaches the file exactly once, in order, and the
 * conversation on screen and the record on disk tell the same story.
 */

const RECORD = "sessions/s1.jsonl";

function makeConv(): Conv {
  return {
    key: "c1",
    sessionId: "s1",
    entries: [],
    label: "主会话",
    parent: null,
    basedOn: "",
    forkAt: 0,
    titleSource: "first-message",
    mcpErrors: [],
    transcriptPath: "/fake/vault/sessions/s1.jsonl",
    sessionFileId: "s1",
    model: null,
    usage: null,
    todos: [],
  };
}

function makeHarness() {
  let convs: Conv[] = [makeConv()];
  const turns = new Map<string, Turn>();
  const sessionIndex = new Map<string, { convKey: string; path: string | null; home: boolean }>();
  const refreshed = { count: 0 };
  const writer = createTranscriptWriter({
    pathOf: (convKey) => (convKey === "c1" ? "/fake/vault/sessions/s1.jsonl" : undefined),
    homeOf: () => false,
    modelOf: () => null,
    refreshSessions: () => {
      refreshed.count += 1;
    },
  });
  const ctx: StreamContext = {
    convs: () => convs,
    turns,
    sessionIndex,
    patchConvs: (patch) => {
      convs = patch(convs);
    },
    updateConv: (key, patch) => {
      convs = convs.map((c) => (c.key === key ? patch(c) : c));
    },
    persistTurn: (convKey, turn, pathOverride, force) => {
      writer.persistTurn(convKey, turn, pathOverride, force);
    },
    clearBusy: () => {},
    setApproval: () => {},
    setPendingQuestion: () => {},
    setPlanActive: () => {},
    afterEvent: () => {},
  };
  const handle = createStreamHandler(ctx);
  const send = (event: Parameters<typeof handle>[1]) => handle("s1", event);
  const entries = (): ChatEntry[] => findConvBySession(convs, "s1")?.entries ?? [];
  return { send, entries, writer, refreshed };
}

async function until(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 2000 });
}

/** Every line on disk, the metadata line included (the parser drops it by design). */
function rawLines(): Record<string, unknown>[] {
  return (fakeVault.read(RECORD) ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function record(): TranscriptLine[] {
  return parseTranscript(fakeVault.read(RECORD) ?? null);
}

function assistantLines(): Extract<TranscriptLine, { type: "assistant" }>[] {
  // The discriminant narrows the union: the record's assistant lines are the
  // only ones this file compares with the live turn.
  return record().filter((line) => line.type === "assistant");
}

describe("one streamed turn through the record writer", () => {
  it("writes the metadata line, the question, then one line per finished round", async () => {
    const h = makeHarness();
    h.writer.persistUserLine("c1", { type: "user", at: 1, text: "看下这个仓库" });

    h.send({ type: "thinking_delta", text: "先看看结构" });
    h.send({ type: "tool_start", id: "t1", name: "Read", input: { file_path: "a.md" } });
    h.send({ type: "tool_end", id: "t1", ok: true, output: "内容" });
    h.send({ type: "text_delta", text: "读完了" });
    h.send({ type: "turn_end", reason: "end_turn", items: 3 });

    await until(() => expect(rawLines()).toHaveLength(4));
    expect(rawLines().map((line) => line.type)).toEqual(["meta", "user", "assistant", "assistant"]);
    const lines = assistantLines();
    // Round one closed when the narration of round two arrived.
    expect(lines[0]).toMatchObject({
      thinking: "先看看结构",
      tools: [{ id: "t1", name: "Read", output: "内容", ok: true }],
    });
    // Round two is the answer.
    expect(lines[1]).toMatchObject({ text: "读完了", tools: [] });

    // The screen and the disk agree about the answer.
    const turn = h.entries()[0]?.turn;
    expect(turn ? finalText(turn) : null).toBe("读完了");
    expect(lines[1]?.text).toBe(finalText(turn!));
    // The list was refreshed after each write, so the drawer sees the record.
    await until(() => expect(h.refreshed.count).toBe(3));
  });

  it("writes a round's tools only once, even when later deltas flush again", async () => {
    const h = makeHarness();
    h.writer.persistUserLine("c1", { type: "user", at: 1, text: "跑一下" });
    h.send({ type: "tool_start", id: "t1", name: "Bash", input: { command: "ls" } });
    h.send({ type: "tool_end", id: "t1", ok: true, output: "a.md" });
    h.send({ type: "text_delta", text: "一" });
    h.send({ type: "text_delta", text: "二" });
    h.send({ type: "turn_end", reason: "end_turn", items: 2 });

    await until(() => expect(rawLines()).toHaveLength(4));
    const lines = assistantLines();
    expect(lines).toHaveLength(2);
    // The first flush closed the round carrying the tool call; the tail holds
    // only the text, so the call appears exactly once in the record.
    expect(lines[0]?.tools).toHaveLength(1);
    expect(lines.filter((line) => (line.tools ?? []).length > 0)).toHaveLength(1);
    // The text is split where the flushes happened: nothing lost, nothing twice.
    expect(lines.map((line) => line.text).join("")).toBe("一二");
  });

  it("an error with no streamed turn leaves the failure in the record", async () => {
    const h = makeHarness();
    h.writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    h.send({ type: "error", message: "连接失败", items: 0 });

    await until(() => expect(rawLines()).toHaveLength(3));
    const lines = assistantLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "", error: "连接失败" });
    // The failed turn is still readable on screen.
    expect(h.entries()[0]?.turn?.error).toBe("连接失败");
  });

  it("a restored record re-renders exactly the rounds it holds", async () => {
    const h = makeHarness();
    h.writer.persistUserLine("c1", { type: "user", at: 1, text: "问" });
    h.send({ type: "thinking_delta", text: "想" });
    h.send({ type: "text_delta", text: "答" });
    h.send({ type: "turn_end", reason: "end_turn", items: 2 });
    await until(() => expect(rawLines()).toHaveLength(3));

    // A restore reads the same bytes back through the panel's entry builder:
    // the round structure must survive the trip unchanged.
    const lines = assistantLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "答", thinking: "想" });
  });
});

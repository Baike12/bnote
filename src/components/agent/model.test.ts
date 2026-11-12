import { describe, expect, it } from "vitest";
import { historyFromTranscript, type TranscriptLine } from "@/study/transcript";
import {
  appendText,
  appendThinking,
  answerStepIndex,
  cloneEntry,
  closeThinking,
  entriesToLines,
  entryFromLine,
  finalText,
  fitInputHeight,
  formatSessionTime,
  newTurn,
  pushToolStep,
  studyContentKey,
  thinkingSealFor,
  thinkingSecondsAt,
  thinkingSummaryLine,
  type ChatEntry,
} from "./model";

/**
 * The panel's conversion layer: a session record and the rendered entries
 * must survive a round trip, otherwise a restored or forked session shows
 * something other than what was written.
 */

describe("transcript round trip", () => {
  const lines: TranscriptLine[] = [
    { type: "user", at: 1, text: "问", images: [{ mediaType: "image/png", data: "AAA" }] },
    {
      type: "assistant",
      at: 2,
      text: "答",
      thinking: "想",
      thinkSeconds: 3,
      tools: [{ id: "t1", name: "read_file", input: { path: "a" }, output: "ok", ok: true }],
    },
  ];

  it("a line becomes a rendered entry and back without losing content", () => {
    const entries = lines.map(entryFromLine);
    expect(entries[0]).toMatchObject({ role: "user", text: "问", at: 1, items: null });
    expect(entries[1]?.turn).toMatchObject({ text: "答", thinking: "想" });
    expect(entriesToLines(entries)).toEqual(lines);
  });

  it("the thinking signature survives the round trip as a seal over the stored text", () => {
    const signed: TranscriptLine = {
      type: "assistant",
      at: 2,
      text: "答",
      thinking: "想",
      thinkingSignature: "sig1",
      tools: [],
    };
    const entry = entryFromLine(signed);
    expect(entry.turn?.thinkingSeals).toEqual([{ end: 1, signature: "sig1" }]);
    // Restored turns are already on disk: re-writing them must not duplicate the seal.
    expect(entry.turn?.persistedSealCount).toBe(1);
    expect(entriesToLines([entry])).toEqual([signed]);
  });

  it("a restored turn claims no stop reason (the record cannot tell a stopped turn from a finished one)", () => {
    const entry = entryFromLine({ type: "assistant", at: 2, text: "答", tools: [] });
    expect(newTurn(1).stopReason).toBeNull();
    expect(entry.turn?.stopReason).toBeNull();
  });

  it("notice entries are display only and never reach the file", () => {
    const entries: ChatEntry[] = [
      { role: "notice", text: "连接中断", at: 1, items: null },
      { role: "user", text: "继续", at: 2, items: null },
    ];
    expect(entriesToLines(entries)).toEqual([
      { type: "user", at: 2, text: "继续", images: undefined },
    ]);
  });

  it("a clone shares no tool record with its source (the fork prefixes diverge later)", () => {
    const entry = entryFromLine(lines[1] as TranscriptLine);
    const copy = cloneEntry(entry);
    const source = entry.turn?.tools[0];
    const cloned = copy.turn?.tools[0];
    expect(source).toBeDefined();
    expect(cloned).toBeDefined();
    if (cloned) cloned.ok = false;
    expect(source?.ok).toBe(true);
  });

  it("a clone shares no thinking seal either", () => {
    const entry = entryFromLine({
      type: "assistant",
      at: 2,
      text: "",
      thinking: "想",
      thinkingSignature: "sig1",
      tools: [],
    });
    const copy = cloneEntry(entry);
    const clonedSeal = copy.turn?.thinkingSeals[0];
    if (clonedSeal) clonedSeal.signature = "tampered";
    expect(entry.turn?.thinkingSeals[0]?.signature).toBe("sig1");
  });
});

describe("fork seed lines: one record line per provider round", () => {
  /** A turn of two streamed rounds: thinking → narration → tool, then thinking → the answer. */
  function twoRoundTurn() {
    const turn = newTurn(0);
    turn.turnMs = 9_000;
    appendThinking(turn, "想一", 1_000);
    turn.thinkingSeals.push({ end: 2, signature: "sig1" });
    closeThinking(turn, 3_000);
    appendText(turn, "先看");
    pushToolStep(turn, "t1", 3_000);
    turn.tools.push({ id: "t1", name: "grep", input: { pattern: "x" }, output: "ok", ok: true });
    appendThinking(turn, "想二", 3_000);
    turn.thinkingSeals.push({ end: 4, signature: "sig2" });
    closeThinking(turn, 4_000);
    appendText(turn, "结论");
    const entry: ChatEntry = { role: "assistant", text: turn.text, at: 10, turn, items: null };
    return { turn, entry };
  }

  it("splits a multi-round entry where the stream opened a new round", () => {
    const { entry } = twoRoundTurn();
    expect(entriesToLines([entry])).toEqual([
      {
        type: "assistant",
        at: 10,
        text: "先看",
        thinking: "想一",
        thinkingSignature: "sig1",
        thinkSeconds: 2,
        tools: [{ id: "t1", name: "grep", input: { pattern: "x" }, output: "ok", ok: true }],
      },
      {
        type: "assistant",
        at: 10,
        text: "结论",
        thinking: "想二",
        thinkingSignature: "sig2",
        thinkSeconds: 1,
        // The wall-clock duration belongs to the turn: only its last line claims it.
        turnMs: 9_000,
        tools: [],
      },
    ]);
  });

  it("the rebuilt history keeps the rounds apart, so the narration stays before its tool results", () => {
    const { entry } = twoRoundTurn();
    expect(historyFromTranscript(entriesToLines([entry]))).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", text: "想一", signature: "sig1" },
          { type: "text", text: "先看" },
          { type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", text: "想二", signature: "sig2" },
          { type: "text", text: "结论" },
        ],
      },
    ]);
  });
});

describe("turn steps keep the stream order", () => {
  /**
   * The work section must read like the turn went: the second round's thinking
   * belongs between the first and second batch of tool calls, not merged into
   * one block above all of them (the live panel used to flatten it that way,
   * while a restored record — one line per round — already interleaved).
   */
  it("interleaves thinking blocks and tool rows in arrival order", () => {
    const turn = newTurn(1_000);
    appendThinking(turn, "look around", 1_000);
    closeThinking(turn, 3_000);
    pushToolStep(turn, "t1", 3_000);
    appendThinking(turn, "read it", 4_000);
    pushToolStep(turn, "t2", 5_500);
    appendThinking(turn, "answer", 6_000);
    closeThinking(turn, 7_000);

    expect(turn.steps).toEqual([
      { kind: "thinking", start: 0, end: 11, startedAt: 1_000, seconds: 2 },
      { kind: "tool", id: "t1" },
      { kind: "thinking", start: 11, end: 18, startedAt: 4_000, seconds: 2 },
      { kind: "tool", id: "t2" },
      { kind: "thinking", start: 18, end: 24, startedAt: 6_000, seconds: 1 },
    ]);
    // The text is the concatenation the rows slice, in the same order.
    expect(turn.thinking).toBe("look aroundread itanswer");
  });

  it("extends the open block instead of opening a row per delta", () => {
    const turn = newTurn(0);
    appendThinking(turn, "a", 1_000);
    appendThinking(turn, "b", 1_100);
    expect(turn.steps).toEqual([
      { kind: "thinking", start: 0, end: 2, startedAt: 1_000, seconds: null },
    ]);
  });

  it("closing is idempotent, so a seal and the turn's end can both close", () => {
    const turn = newTurn(0);
    appendThinking(turn, "a", 1_000);
    closeThinking(turn, 2_500);
    closeThinking(turn, 9_000);
    expect(turn.steps[0]).toMatchObject({ seconds: 2 });
  });

  it("a restored record rebuilds thinking, then text, then its tools", () => {
    const entry = entryFromLine({
      type: "assistant",
      at: 2,
      text: "答",
      thinking: "想",
      thinkSeconds: 4,
      tools: [
        { id: "t1", name: "read_file" },
        { id: "t2", name: "grep" },
      ],
    });
    expect(entry.turn?.steps).toEqual([
      { kind: "thinking", start: 0, end: 1, startedAt: null, seconds: 4 },
      { kind: "text", start: 0, end: 1 },
      { kind: "tool", id: "t1" },
      { kind: "tool", id: "t2" },
    ]);
    // This round ended on a tool call: the text was the preamble, not the answer.
    expect(entry.turn ? finalText(entry.turn) : null).toBe("");
    expect(entry.turn && answerStepIndex(entry.turn)).toBe(-1);
  });

  it("a pure text round is the answer and stays outside the work rows", () => {
    const entry = entryFromLine({ type: "assistant", at: 2, text: "答", tools: [] });
    expect(entry.turn?.steps).toEqual([{ kind: "text", start: 0, end: 1 }]);
    expect(entry.turn ? answerStepIndex(entry.turn) : -2).toBe(0);
    expect(entry.turn ? finalText(entry.turn) : null).toBe("答");
  });

  it("a text delta extends its row, and a tool call in between starts the next one", () => {
    const turn = newTurn(0);
    appendText(turn, "先定位");
    appendText(turn, "落点");
    pushToolStep(turn, "t1", 1_000);
    appendText(turn, "结论");
    expect(turn.steps).toEqual([
      { kind: "text", start: 0, end: 5 },
      { kind: "tool", id: "t1" },
      { kind: "text", start: 5, end: 7 },
    ]);
    expect(turn.text).toBe("先定位落点结论");
    // The trailing stretch is what the panel draws as the answer.
    expect(finalText(turn)).toBe("结论");
  });

  it("an empty delta adds no row (a gateway may announce an empty text block)", () => {
    const turn = newTurn(0);
    appendText(turn, "");
    expect(turn.steps).toEqual([]);
    expect(turn.text).toBe("");
  });

  it("the flushed round carries its own thinking duration", () => {
    const turn = newTurn(0);
    appendThinking(turn, "a", 1_000);
    closeThinking(turn, 3_000);
    pushToolStep(turn, "t1", 3_000);
    appendThinking(turn, "b", 4_000);
    closeThinking(turn, 4_800);
    // The first line flushed the block at offset 0, the second the one at 1.
    expect(thinkingSecondsAt(turn, 0)).toBe(2);
    expect(thinkingSecondsAt(turn, 1)).toBe(1);
    expect(thinkingSecondsAt(turn, 2)).toBeNull();
  });
});

describe("thinkingSealFor", () => {
  it("claims the signature only when one seal closes exactly at the end of the stored text", () => {
    expect(thinkingSealFor([{ end: 5, signature: "sig1" }], 5)).toBe("sig1");
  });

  it("drops the signature when the seal covers only part of the text", () => {
    // Still streaming (or the flush sliced a longer text): the seal is for
    // another boundary and replaying it would not match the text.
    expect(thinkingSealFor([{ end: 3, signature: "sig1" }], 5)).toBeUndefined();
    // Two interleaved blocks: one stored block cannot carry two seals.
    expect(
      thinkingSealFor(
        [
          { end: 3, signature: "sig1" },
          { end: 5, signature: "sig2" },
        ],
        5,
      ),
    ).toBeUndefined();
    // A gateway without signatures still announces boundaries; nothing to store.
    expect(thinkingSealFor([{ end: 5, signature: "" }], 5)).toBeUndefined();
    expect(thinkingSealFor([], 5)).toBeUndefined();
  });
});

describe("helpers", () => {
  it("the thinking summary is the last non-empty line", () => {
    expect(thinkingSummaryLine("a\n\n  b  \n\n")).toBe("b");
    expect(thinkingSummaryLine("")).toBe("");
  });

  it("a material key survives a url re-open and distinguishes a pdf", () => {
    expect(studyContentKey(null)).toBe("none");
    expect(studyContentKey({ kind: "url", url: "https://a" } as never)).toBe("url:https://a");
    expect(studyContentKey({ kind: "pdf", path: "/p.pdf" } as never)).toBe("pdf:/p.pdf");
  });

  it("today shows the time, an older day shows month and day", () => {
    const now = Date.now();
    expect(formatSessionTime(now)).toMatch(/^\d{2}:\d{2}$/);
    expect(formatSessionTime(now - 3 * 24 * 3600 * 1000)).toMatch(/^\d{1,2}\/\d{1,2}$/);
    expect(formatSessionTime(0)).toBe("");
  });

  it("the composer height is reset before it is measured, so it can shrink", () => {
    const style = { height: "" };
    const el = {
      style,
      get scrollHeight() {
        // A stale height would make the measurement grow forever.
        expect(style.height).toBe("auto");
        return 40;
      },
    } as unknown as HTMLTextAreaElement;
    fitInputHeight(el);
    expect(style.height).toBe("40px");
  });
});

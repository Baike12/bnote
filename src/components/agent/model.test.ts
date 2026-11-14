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
  errorTurn,
  finalText,
  fitInputHeight,
  formatSessionTime,
  newTurn,
  nextConvKey,
  pushToolStep,
  studyContentKey,
  thinkingSealFor,
  thinkingSecondsAt,
  thinkingSummaryLine,
  toSessionNode,
  type ChatEntry,
  type Turn,
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

  it("closing a block whose start time is unknown uses the moment it closed (never a negative duration)", () => {
    const turn = newTurn(null);
    // A restored row carries no start time; it is already sealed, but a live
    // block whose clock is missing must not produce NaN seconds.
    turn.steps.push({ kind: "thinking", start: 0, end: 1, startedAt: null, seconds: null });
    turn.thinking = "a";
    closeThinking(turn, 5_000);
    expect(turn.steps[0]).toMatchObject({ seconds: 1 });
  });

  it("closing with nothing open does nothing", () => {
    const turn = newTurn(0);
    closeThinking(turn, 1_000);
    expect(turn.steps).toEqual([]);
    appendText(turn, "答");
    closeThinking(turn, 2_000);
    // A text row is not a thinking block: its duration is not tracked.
    expect(turn.steps).toEqual([{ kind: "text", start: 0, end: 1 }]);
  });

  it("a block shorter than a second still reads as one second", () => {
    const turn = newTurn(0);
    appendThinking(turn, "a", 1_000);
    closeThinking(turn, 1_200);
    expect(turn.steps[0]).toMatchObject({ seconds: 1 });
  });

  it("a line without a tools array restores with no tool rows", () => {
    // An older record (or a hand-written one) may omit the field entirely.
    const entry = entryFromLine({ type: "assistant", at: 2, text: "答" });
    expect(entry.turn?.tools).toEqual([]);
    expect(entry.turn?.steps).toEqual([{ kind: "text", start: 0, end: 1 }]);
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
    // CRLF (and a lone CR) is one line break: a Windows-pasted block must not
    // read as one long line.
    expect(thinkingSummaryLine("第一行\r\n第二行")).toBe("第二行");
    expect(thinkingSummaryLine("第一行\r第二行")).toBe("第二行");
    // A block made only of whitespace has no summary line at all.
    expect(thinkingSummaryLine("  \n\t\n ")).toBe("");
    expect(thinkingSummaryLine("\r\n")).toBe("");
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

describe("turn constructors", () => {
  it("an error turn carries only the message and no streamed content", () => {
    const turn = errorTurn("连接失败");
    expect(turn.error).toBe("连接失败");
    expect(turn.text).toBe("");
    expect(turn.thinking).toBe("");
    expect(turn.steps).toEqual([]);
    expect(turn.tools).toEqual([]);
    expect(turn.startedAt).toBeNull();
    expect(turn.turnMs).toBeNull();
    expect(turn.stopReason).toBeNull();
  });

  it("a new turn starts empty with its clock at the given instant", () => {
    expect(newTurn(null)).toEqual({ ...errorTurn("x"), error: undefined, startedAt: null });
    expect(newTurn(1_234).startedAt).toBe(1_234);
  });
});

describe("identity helpers", () => {
  it("a saved-session meta fills the missing family fields", () => {
    expect(
      toSessionNode({
        id: "s1",
        title: "问",
        parent: null,
        basedOn: null,
        forkAt: null,
        createdAt: 1,
        updatedAt: 2,
        bytes: 10,
      }),
    ).toEqual({
      id: "s1",
      title: "问",
      parent: null,
      basedOn: "",
      forkAt: 0,
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it("a forked meta keeps its parent, summary and prefix count", () => {
    expect(
      toSessionNode({
        id: "s2",
        title: "问 · 分支",
        parent: "s1",
        basedOn: "第一个问题",
        forkAt: 4,
        createdAt: 3,
        updatedAt: 4,
        bytes: 20,
      }),
    ).toMatchObject({ parent: "s1", basedOn: "第一个问题", forkAt: 4 });
  });

  it("conv keys are unique and monotonic", () => {
    const a = nextConvKey();
    const b = nextConvKey();
    expect(a).not.toBe(b);
    expect(Number(b.slice(1))).toBe(Number(a.slice(1)) + 1);
  });
});

describe("entries without a full turn", () => {
  it("an entry without a turn still writes one assistant line", () => {
    const entry: ChatEntry = { role: "assistant", text: "答", at: 5, items: null };
    expect(entriesToLines([entry])).toEqual([{ type: "assistant", at: 5, text: "答", tools: [] }]);
  });

  it("a turn that never streamed a block writes one line with what it has", () => {
    const turn: Turn = { ...newTurn(null), text: "partial", error: "boom" };
    turn.turnMs = 2_000;
    const entry: ChatEntry = { role: "assistant", text: "partial", at: 5, turn, items: null };
    const [line] = entriesToLines([entry]);
    expect(line).toMatchObject({
      type: "assistant",
      text: "partial",
      error: "boom",
      turnMs: 2_000,
    });
    expect(line && "thinking" in line ? line.thinking : "sentinel").toBeUndefined();
  });

  it("a user entry without images round-trips without inventing them", () => {
    const entry: ChatEntry = { role: "user", text: "问", at: 1, items: null };
    expect(entriesToLines([entry])).toEqual([
      { type: "user", at: 1, text: "问", images: undefined },
    ]);
  });
});

describe("round splitting", () => {
  it("a tool step whose call is missing is skipped instead of opening an empty round", () => {
    const turn = newTurn(0);
    // The step exists but the tool record was never added (a truncated record).
    turn.steps.push({ kind: "tool", id: "ghost" });
    appendText(turn, "答");
    const entry: ChatEntry = { role: "assistant", text: turn.text, at: 1, turn, items: null };
    const lines = entriesToLines([entry]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "assistant", text: "答", tools: [] });
  });

  it("a turn that opens on a tool round writes that round with no thinking and no text", () => {
    const turn = newTurn(0);
    pushToolStep(turn, "t1", 1_000);
    turn.tools.push({ id: "t1", name: "Read", output: "ok", ok: true });
    const entry: ChatEntry = { role: "assistant", text: "", at: 7, turn, items: null };
    expect(entriesToLines([entry])).toEqual([
      {
        type: "assistant",
        at: 7,
        text: "",
        tools: [{ id: "t1", name: "Read", output: "ok", ok: true }],
      },
    ]);
  });

  it("only the last round carries the turn's duration and error", () => {
    const turn = newTurn(1_000);
    turn.turnMs = 5_000;
    turn.error = "partial";
    appendThinking(turn, "想一", 1_000);
    closeThinking(turn, 2_000);
    pushToolStep(turn, "t1", 2_000);
    turn.tools.push({ id: "t1", name: "Read", output: "ok", ok: true });
    appendText(turn, "结论");
    const entry: ChatEntry = { role: "assistant", text: turn.text, at: 9, turn, items: null };
    const lines = entriesToLines([entry]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toHaveProperty("turnMs");
    expect(lines[0]).not.toHaveProperty("error");
    expect(lines[1]).toMatchObject({ turnMs: 5_000, error: "partial" });
  });

  it("a second thinking block right after a sealed one opens its own round", () => {
    // A gateway that closes a thinking block and then streams another one
    // before any text: one record line cannot carry two blocks (`thinkingSealFor`
    // would drop the seal), so the second block starts the next round.
    const turn = newTurn(0);
    appendThinking(turn, "一", 1_000);
    turn.thinkingSeals.push({ end: 1, signature: "sig1" });
    closeThinking(turn, 2_000);
    appendThinking(turn, "二", 2_000);
    turn.thinkingSeals.push({ end: 2, signature: "sig2" });
    closeThinking(turn, 3_000);
    const entry: ChatEntry = { role: "assistant", text: "", at: 9, turn, items: null };
    expect(entriesToLines([entry])).toEqual([
      {
        type: "assistant",
        at: 9,
        text: "",
        thinking: "一",
        thinkingSignature: "sig1",
        thinkSeconds: 1,
        tools: [],
      },
      {
        type: "assistant",
        at: 9,
        text: "",
        thinking: "二",
        thinkingSignature: "sig2",
        thinkSeconds: 1,
        tools: [],
      },
    ]);
  });

  it("thinking after a text stretch opens the next round too", () => {
    const turn = newTurn(0);
    appendText(turn, "先说一句");
    appendThinking(turn, "再想", 1_000);
    closeThinking(turn, 2_000);
    const entry: ChatEntry = { role: "assistant", text: turn.text, at: 9, turn, items: null };
    expect(entriesToLines([entry])).toEqual([
      { type: "assistant", at: 9, text: "先说一句", tools: [] },
      { type: "assistant", at: 9, text: "", thinking: "再想", thinkSeconds: 1, tools: [] },
    ]);
  });

  it("thinking after a tool-only round opens the next round (its tools stay with the first)", () => {
    const turn = newTurn(0);
    pushToolStep(turn, "t1", 1_000);
    turn.tools.push({ id: "t1", name: "Read", output: "ok", ok: true });
    appendThinking(turn, "看到了", 2_000);
    closeThinking(turn, 3_000);
    const entry: ChatEntry = { role: "assistant", text: "", at: 9, turn, items: null };
    const lines = entriesToLines([entry]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ tools: [{ id: "t1", name: "Read", output: "ok", ok: true }] });
    expect(lines[1]).toMatchObject({ thinking: "看到了", tools: [] });
  });
});

describe("cloning an entry", () => {
  it("copies the images so the fork cannot edit the source message", () => {
    const entry: ChatEntry = {
      role: "user",
      text: "问",
      at: 1,
      items: null,
      images: [{ mediaType: "image/png", data: "AAA" }],
    };
    const copy = cloneEntry(entry);
    expect(copy.images).not.toBe(entry.images);
    const cloned = copy.images?.[0];
    if (cloned) cloned.data = "tampered";
    expect(entry.images?.[0]?.data).toBe("AAA");
  });

  it("an entry without a turn or images clones without inventing fields", () => {
    const entry: ChatEntry = { role: "user", text: "问", at: 1, items: null };
    expect(cloneEntry(entry)).toEqual(entry);
  });

  it("the steps and tool records are copies, not the same objects", () => {
    const turn = newTurn(0);
    appendThinking(turn, "想", 0);
    pushToolStep(turn, "t1", 0);
    turn.tools.push({ id: "t1", name: "Read" });
    const entry: ChatEntry = { role: "assistant", text: "", at: 1, items: null, turn };
    const copy = cloneEntry(entry);
    expect(copy.turn?.steps).not.toBe(turn.steps);
    expect(copy.turn?.tools).not.toBe(turn.tools);
    expect(copy.turn?.steps).toEqual(turn.steps);
    expect(copy.turn?.tools).toEqual(turn.tools);
  });
});

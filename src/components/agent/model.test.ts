import { describe, expect, it } from "vitest";
import type { TranscriptLine } from "@/study/transcript";
import {
  answerRange,
  appendText,
  appendThinking,
  cloneEntry,
  closeThinking,
  entriesToLines,
  entryFromLine,
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
    expect(entriesToLines([entry])).toEqual([{ ...signed, thinkSeconds: null, error: undefined }]);
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

  it("a restored record rebuilds thinking, then its prose, then its tools", () => {
    const entry = entryFromLine({
      type: "assistant",
      at: 2,
      text: "先看接口",
      thinking: "想",
      thinkSeconds: 4,
      tools: [
        { id: "t1", name: "read_file" },
        { id: "t2", name: "grep" },
      ],
    });
    // A round line is flushed with the prose the model wrote before its calls,
    // so the prose belongs between the thinking and the tools, not after them.
    expect(entry.turn?.steps).toEqual([
      { kind: "thinking", start: 0, end: 1, startedAt: null, seconds: 4 },
      { kind: "text", start: 0, end: 4 },
      { kind: "tool", id: "t1" },
      { kind: "tool", id: "t2" },
    ]);
    // Nothing trails the tools: the turn ended on work, so there is no answer row.
    expect(answerRange(entry.turn!)).toBeNull();
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

  /**
   * The model writes prose between tool calls ("先改后端这一侧："), and that
   * prose used to be flattened into one buffer drawn after the whole work
   * section — every mid-turn sentence ended up at the bottom of the reply.
   * Text is a row of the same timeline, at the offset it arrived.
   */
  it("keeps each piece of assistant prose at its stream position", () => {
    const turn = newTurn(1_000);
    appendThinking(turn, "plan", 1_000);
    appendText(turn, "先改后端", 2_000);
    pushToolStep(turn, "t1", 3_000);
    appendText(turn, "再改前端", 4_000);

    expect(turn.steps).toEqual([
      // The text closes the thinking row in front of it.
      { kind: "thinking", start: 0, end: 4, startedAt: 1_000, seconds: 1 },
      { kind: "text", start: 0, end: 4 },
      { kind: "tool", id: "t1" },
      { kind: "text", start: 4, end: 8 },
    ]);
    expect(turn.text).toBe("先改后端再改前端");
    // Only the trailing row is the answer.
    expect(answerRange(turn)).toEqual({ start: 4, end: 8 });
  });

  it("extends the open text row instead of opening a row per delta, and stops on a tool", () => {
    const turn = newTurn(0);
    appendText(turn, "a", 1_000);
    appendText(turn, "b", 1_100);
    expect(turn.steps).toEqual([{ kind: "text", start: 0, end: 2 }]);
    pushToolStep(turn, "t1", 2_000);
    appendText(turn, "c", 3_000);
    expect(turn.steps).toEqual([
      { kind: "text", start: 0, end: 2 },
      { kind: "tool", id: "t1" },
      { kind: "text", start: 2, end: 3 },
    ]);
  });

  it("a turn that ends on work has no answer row (its prose stays in the section)", () => {
    const turn = newTurn(0);
    appendText(turn, "改这一侧:", 1_000);
    pushToolStep(turn, "t1", 2_000);
    expect(answerRange(turn)).toBeNull();
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

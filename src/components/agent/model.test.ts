import { describe, expect, it } from "vitest";
import type { TranscriptLine } from "@/study/transcript";
import {
  cloneEntry,
  entriesToLines,
  entryFromLine,
  fitInputHeight,
  formatSessionTime,
  studyContentKey,
  thinkingSealFor,
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
    expect(entries[1]?.turn).toMatchObject({ text: "答", thinking: "想", thinkSeconds: 3 });
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

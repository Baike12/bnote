import { describe, expect, it } from "vitest";
import type { TranscriptLine } from "@/study/transcript";
import {
  cloneEntry,
  entriesToLines,
  entryFromLine,
  fitInputHeight,
  formatSessionTime,
  studyContentKey,
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

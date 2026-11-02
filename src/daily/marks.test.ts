import { EditorState } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { DailyLink } from "./links";
import { buildDailyMarks, sourceLabel, type DailyMarkView } from "./marks";

/**
 * The rules for the visual marks (the same per-day ownership semantics as the
 * send command):
 *  - Source note: only the links pointing at **today's** daily note are marked
 *    (what was sent yesterday is not "syncing" anymore);
 *  - Daily note file: the links pointing at **this** daily note are marked and
 *    carry the name of the source note;
 *  - Only todo lines get a mark, and only through line decorations (no widget
 *    is inserted).
 */

const TODAY = "/v/Daily/2026-09-27.md";
const SRC = "/v/Job/job todo.md";

function link(over: Partial<DailyLink>): DailyLink {
  return {
    id: over.id ?? "l1",
    kind: over.kind ?? "copied",
    day: over.day ?? "2026-09-27",
    srcPath: over.srcPath ?? SRC,
    dailyPath: over.dailyPath ?? TODAY,
    text: over.text ?? "cs336",
    srcLine: over.srcLine ?? 1,
    dailyLine: over.dailyLine ?? 2,
  };
}

function viewOf(text: string, ranges?: { from: number; to: number }[]): DailyMarkView {
  const state = EditorState.create({ doc: text });
  return { state, visibleRanges: ranges ?? [{ from: 0, to: text.length }] };
}

/** Excerpt of the line decorations: line number (1 based) + class + attributes. */
function marks(set: DecorationSet, doc: Text) {
  const out: { line: number; cls: string; attrs: Record<string, string> }[] = [];
  set.between(0, doc.length, (from, _to, value) => {
    out.push({
      line: doc.lineAt(from).number,
      cls: value.spec.class ?? "",
      attrs: value.spec.attributes ?? {},
    });
  });
  return out;
}

describe("visual marks for todo links", () => {
  it("source note: the root todo line of the link is marked, children and unrelated items are not marked", () => {
    const view = viewOf("- [ ] cs336\n  - [ ] 第一个作业\n- [ ] bm25\n正文一行\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "cs336" })],
      todayDailyPath: TODAY,
    });
    const got = marks(set, view.state.doc);
    expect(got.map((m) => m.line)).toEqual([1]);
    expect(got[0].cls).toBe("md-daily-link");
    // The source side shows no source name (the source is this very note), only the title tooltip
    expect(got[0].attrs["data-daily-src"]).toBeUndefined();
    // The source side carries data-daily-sent: the project card draws a sent todo as a shadow with it.
    expect(got[0].attrs["data-daily-sent"]).toBe("1");
    expect(got[0].attrs.title).toContain("今日日记");
  });

  it("source note: a link sent yesterday is no longer marked today (the same per-day ownership as the send command)", () => {
    const view = viewOf("- [ ] cs336\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "cs336", dailyPath: "/v/Daily/2026-09-26.md", day: "2026-09-26" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toEqual([]);
  });

  it("source note: auto links (aggregated on sight) are not marked — a mark spread over the whole vault is no longer information", () => {
    const view = viewOf("- [ ] cs336\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ kind: "auto" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toEqual([]);
  });

  it("source note: links that other files take part in are not marked", () => {
    const view = viewOf("- [ ] cs336\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "cs336", srcPath: "/v/Anc/anc todo.md" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toEqual([]);
  });

  it("daily note side: the synced entry is marked and carries the source note name, hand-written entries are not marked", () => {
    const view = viewOf("# 2026-09-27\n- [ ] bm25\n- [ ] 自己记的一件事\n");
    const set = buildDailyMarks(view, {
      path: TODAY,
      links: [link({ text: "bm25" })],
      todayDailyPath: TODAY,
    });
    const got = marks(set, view.state.doc);
    expect(got.map((m) => m.line)).toEqual([2]);
    expect(got[0].attrs["data-daily-src"]).toBe("job todo");
    expect(got[0].attrs.title).toContain("job todo");
  });

  it("daily note side: a daily note that is not today's is still marked as pointing at this daily note", () => {
    const past = "/v/Daily/2026-09-23.md";
    const view = viewOf("# 2026-09-23\n- [ ] anc-ke\n");
    const set = buildDailyMarks(view, {
      path: past,
      links: [link({ text: "anc-ke", srcPath: "/v/Anc/anc todo.md", dailyPath: past })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toHaveLength(1);
  });

  it("the tooltip of a recorded link distinguishes the recorded-when-checked case", () => {
    const view = viewOf("- [x] cs336 ✅ 2026-09-27\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "cs336", kind: "recorded" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)[0].attrs.title).toContain("勾选完成");
  });

  it("only the lines inside the viewport are marked; an empty viewport produces nothing", () => {
    const doc = `${Array.from({ length: 40 }, (_, i) => `- [ ] t${i}`).join("\n")}\n`;
    const view = viewOf(doc);
    const links = [link({ text: "t0" }), link({ id: "l2", text: "t30" })];
    const all = buildDailyMarks(view, { path: SRC, links, todayDailyPath: TODAY });
    expect(marks(all, view.state.doc).map((m) => m.line)).toEqual([1, 31]);

    const line31 = view.state.doc.line(31);
    const windowed = buildDailyMarks(viewOf(doc, [{ from: line31.from, to: line31.to }]), {
      path: SRC,
      links,
      todayDailyPath: TODAY,
    });
    expect(marks(windowed, view.state.doc).map((m) => m.line)).toEqual([31]);

    const empty = buildDailyMarks({ ...view, visibleRanges: [] }, {
      path: SRC,
      links,
      todayDailyPath: TODAY,
    });
    expect(empty.size).toBe(0);
  });

  it("the link text comes from the identity text after the checkbox and the ✅ stamp are stripped", () => {
    const view = viewOf("- [x] 接入4a登录 ✅ 2026-09-23\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "接入4a登录" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toHaveLength(1);
  });

  it("source note name: the directory and the extension are removed", () => {
    expect(sourceLabel("/v/Job/job todo.md")).toBe("job todo");
    expect(sourceLabel("/v/a/b/c.md")).toBe("c");
  });
});

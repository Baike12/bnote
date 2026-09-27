import { EditorState } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { DailyLink } from "./links";
import { buildDailyMarks, sourceLabel, type DailyMarkView } from "./marks";

/**
 * 可视标识的判定规则(与发送命令同一套「按日归属」语义):
 *  - 源笔记:只标指向**今天这份日记**的链接(昨天发出去的不算同步中);
 *  - 日记文件:标指向**这份日记**的链接,并带出源笔记名;
 *  - 只有待办行有标记,且只用行装饰(不插入 widget)。
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

/** 行装饰摘录:行号(1 起) + class + attributes。 */
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

describe("待办链接的可视标识", () => {
  it("源笔记:标出链接的根待办行,子项与无关项不打标", () => {
    const view = viewOf("- [ ] cs336\n  - [ ] 第一个作业\n- [ ] bm25\n正文一行\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "cs336" })],
      todayDailyPath: TODAY,
    });
    const got = marks(set, view.state.doc);
    expect(got.map((m) => m.line)).toEqual([1]);
    expect(got[0].cls).toBe("md-daily-link");
    // 源侧不显示来源名(来源就是这篇笔记自己),只有 title 提示
    expect(got[0].attrs["data-daily-src"]).toBeUndefined();
    expect(got[0].attrs.title).toContain("今日日记");
  });

  it("源笔记:昨天发出去的链接今天不再打标(与发送命令的按日归属一致)", () => {
    const view = viewOf("- [ ] cs336\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "cs336", dailyPath: "/v/Daily/2026-09-26.md", day: "2026-09-26" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toEqual([]);
  });

  it("源笔记:别的文件参与的链接不打标", () => {
    const view = viewOf("- [ ] cs336\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "cs336", srcPath: "/v/Anc/anc todo.md" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toEqual([]);
  });

  it("日记侧:标出同步来的条目并带源笔记名,手写条目不打标", () => {
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

  it("日记侧:打开的不是今天那份也按「指向这份日记」打标", () => {
    const past = "/v/Daily/2026-09-23.md";
    const view = viewOf("# 2026-09-23\n- [ ] anc-ke\n");
    const set = buildDailyMarks(view, {
      path: past,
      links: [link({ text: "anc-ke", srcPath: "/v/Anc/anc todo.md", dailyPath: past })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toHaveLength(1);
  });

  it("记录型链接的提示语区分「勾选时记录」", () => {
    const view = viewOf("- [x] cs336 ✅ 2026-09-27\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "cs336", kind: "recorded" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)[0].attrs.title).toContain("勾选完成");
  });

  it("只标记视口内的行;空视口不产出", () => {
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

  it("链接文本取自剥掉 checkbox 与 ✅ 戳后的身份文本", () => {
    const view = viewOf("- [x] 接入4a登录 ✅ 2026-09-23\n");
    const set = buildDailyMarks(view, {
      path: SRC,
      links: [link({ text: "接入4a登录" })],
      todayDailyPath: TODAY,
    });
    expect(marks(set, view.state.doc)).toHaveLength(1);
  });

  it("源笔记名:去掉目录与扩展名", () => {
    expect(sourceLabel("/v/Job/job todo.md")).toBe("job todo");
    expect(sourceLabel("/v/a/b/c.md")).toBe("c");
  });
});

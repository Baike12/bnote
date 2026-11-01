import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  buildSession,
  exitChain,
  exitCursorPosition,
  planTab,
  setSession,
  snippetField,
  type SnippetSession,
} from "./extension";
import { parseReplacement } from "./engine";

/** Drives the snippetField without DOM: EditorState.update creates the
 *  transactions and the field is read for the assertions. */
function withSession(doc: string, session: SnippetSession | null): EditorState {
  const base = EditorState.create({ doc, extensions: [snippetField] });
  return base.update({ effects: setSession.of(session) }).state;
}

const dm = () => buildSession(0, parseReplacement("$$\n$0\n$$", [], null))!;
const paren = () => buildSession(0, parseReplacement("($0)$1", [], null))!;

describe("planTab:Tab 在 tabstop 间的推进与弹出", () => {
  it("单 $0 片段(dm):Tab 结束会话;落点由 exitCursorPosition 夹紧", () => {
    const s = dm();
    expect(s.order).toEqual([0]);
    expect(planTab(s)).toEqual({ kind: "end", session: s });
  });

  it("($0)$1:Tab 依次走 $0 → $1,再 Tab 结束", () => {
    const s = paren();
    const p1 = planTab(s);
    expect(p1).toEqual({ kind: "select", session: s, index: 1 });
    const s2 = { ...s, active: 1 };
    expect(planTab(s2)).toEqual({ kind: "end", session: s2 });
  });

  it("会话期内嵌套:先走完内层,再弹回外层继续;外层也走完即结束", () => {
    // A two-stop snippet expanded inside the dm session (e.g. bf →
    // \mathbf{$0}$1)
    const outer = dm();
    const inner = buildSession(3, parseReplacement("\\mathbf{$0}$1", [], null), outer)!;
    // Inner $0 → inner $1 (after the brace) → pop back to the outer level and
    // advance → the outer level only has $0, so it ends there.
    expect(planTab(inner)).toEqual({ kind: "select", session: inner, index: 1 });
    const afterInner = { ...inner, active: 1 };
    expect(planTab(afterInner)).toEqual({ kind: "end", session: outer });
  });

  it("父层也走完时逐层弹干净", () => {
    const root = paren(); // [0,1]
    const mid = buildSession(1, parseReplacement("[$0]$1", [], null), { ...root, active: 0 })!;
    const leaf = buildSession(2, parseReplacement("<$0>", [], null), mid)!;
    // The leaf has only one stop: Tab → mid's $1 → mid is done → root's $1 →
    // end.
    expect(planTab(leaf)).toEqual({ kind: "select", session: mid, index: 1 });
    expect(planTab({ ...mid, active: 1 })).toEqual({ kind: "select", session: root, index: 1 });
    const done = { ...root, active: 1 };
    expect(planTab(done)).toEqual({ kind: "end", session: done });
  });
});

describe("exitCursorPosition:会话结束落点(公式区域夹紧)", () => {
  it("括号片段在公式块内:Tab 落到右括号之后(finalPos 严格在区域内)", () => {
    // The real shape: bf expanded inside a dm block, the document = the
    // expanded text.
    const doc = "$$\n\\mathbf{}\n$$"; // 3 + 9 + 3
    const s = buildSession(3, parseReplacement("\\mathbf{$0}", [], null))!; // finalPos = 12 (after the })
    const state = withSession(doc, s);
    const st = state.update({ selection: { anchor: 11 } }).state; // The caret is inside the {}
    expect(s.finalPos).toBe(12);
    expect(doc.length).toBe(15); // The closing $$ is after finalPos
    expect(exitCursorPosition(st, st.field(snippetField)!)).toBe(12);
  });

  it("整块创建片段(dm):finalPos 恰越过闭合 $$,原地结束不扔出公式块", () => {
    const s = dm(); // The replacement text "$$\n\n$$", finalPos = 6
    const doc = "$$\n\n$$"; // Same as the replacement text: the region includes the
                          // delimiters, to = 6 = finalPos
    const state = withSession(doc, s);
    const st = state.update({ selection: { anchor: 3 } }).state; // The caret is on the empty line (inside the block)
    expect(s.finalPos).toBe(6);
    expect(exitCursorPosition(st, st.field(snippetField)!)).toBeNull();
  });

  it("行内创建(ma 形状 $$0$):块内打字后 finalPos 映射到闭合 $ 之后,原地", () => {
    const s = buildSession(0, parseReplacement("$$0$", [], null))!; // text "$$", the stop is at 1, finalPos = 2
    const st0 = withSession("$$", s);
    // Typing x at the stop: the doc becomes "$x$" and finalPos is mapped by
    // the transaction to 3 == region.to
    const st = st0.update({ changes: { from: 1, insert: "x" }, selection: { anchor: 1 } }).state;
    const field = st.field(snippetField)!;
    expect(st.doc.toString()).toBe("$x$");
    expect(field.finalPos).toBe(3);
    expect(exitCursorPosition(st, field)).toBeNull();
  });

  it("非公式上下文:始终落到替换文本末尾(旧的 finalPos 语义)", () => {
    const s = buildSession(0, parseReplacement("($0)", [], null))!;
    const state = withSession("()", s);
    const st = state.update({ selection: { anchor: 1 } }).state;
    expect(exitCursorPosition(st, st.field(snippetField)!)).toBe(s.finalPos);
  });
});

describe("exitChain:光标离开即弹出", () => {
  it("在内层区域内:原地保留", () => {
    const outer = paren();
    const inner = buildSession(1, parseReplacement("<$0>", [], null), outer)!;
    expect(exitChain(inner, 2)).toBe(inner);
  });

  it("离开内层但仍在父层内:弹回父层", () => {
    const outer = paren(); // [0,3): inside the brackets is the child session's
                          // region, 0 belongs to the parent level alone
    const inner = buildSession(1, parseReplacement("x$0", [], null), outer)!;
    expect(exitChain(inner, 0)).toBe(outer);
  });

  it("离开整条链:null(全部结束)", () => {
    const outer = paren();
    const inner = buildSession(1, parseReplacement("x$0", [], null), outer)!;
    expect(exitChain(inner, 10)).toBeNull();
  });
});

describe("snippetField:链式映射与全量替换", () => {
  it("文档编辑后,链上所有会话的 stops 映射到新位置", () => {
    const outer = paren();
    const st = withSession("()", outer);
    // Typing "x" inside $0 (position 1): the active stop grows to enclose the
    // input, the other stops shift.
    const edited = st.update({ changes: { from: 1, to: 1, insert: "x" } }).state;
    const mapped = edited.field(snippetField)!;
    expect(mapped).not.toBeNull();
    expect(mapped.stops.get(0)![0]).toEqual({ from: 1, to: 2 });
    expect(mapped.stops.get(1)![0]).toEqual({ from: 3, to: 3 });
    expect(mapped.end).toBe(3);
  });

  it("子会话展开事务里,父层 active stop 同步生长(镜像同步的数据基础)", () => {
    const outer = paren(); // ($0)$1,$0=[1,1]
    const st = withSession("()", outer);
    // The child session expands at the parent's $0 ("Y$0"), with the changes
    // and the effect in the same transaction — the shape of a real expansion.
    const child = buildSession(1, parseReplacement("Y$0", [], null), st.field(snippetField)!)!;
    const edited = st.update({
      changes: { from: 1, to: 1, insert: "Y" },
      effects: setSession.of(child),
    }).state;
    const field = edited.field(snippetField)!;
    // The child session itself is built against the document after the
    // transaction and is not mapped again; the parent chain is mapped into a
    // new object (different identity, current positions).
    expect(field.base).toBe(child.base);
    expect(field.stops.get(0)![0]).toEqual({ from: 2, to: 2 });
    expect(field.parent).not.toBeNull();
    // The parent's $0 is the active stop: after the -1/+1 growth it must
    // enclose the text the child session expanded.
    const parentStop = field.parent!.stops.get(0)![0];
    expect(parentStop).toEqual({ from: 1, to: 2 });
  });

  it("全文档替换(切换文件/整篇装载)清空整条链", () => {
    const outer = paren();
    const inner = buildSession(1, parseReplacement("<$0>", [], null), outer)!;
    const st = withSession("(x<<>>)", inner);
    const replaced = st.update({
      changes: { from: 0, to: st.doc.length, insert: "另一个文件的内容" },
    }).state;
    expect(replaced.field(snippetField)).toBeNull();
  });

  it("普通输入不会误清会话", () => {
    const s = dm();
    const st = withSession("$$\n\n$$", s);
    const edited = st.update({ changes: { from: 3, to: 3, insert: "E" } }).state;
    expect(edited.field(snippetField)).not.toBeNull();
  });
});

describe("buildSession:tabstop 顺序与镜像", () => {
  it("$0 是第一个导航位置,其余按出现顺序", () => {
    const s = buildSession(0, parseReplacement("\\sum_{${0:i}=${1:1}}^{${2:N}} $3", [], null))!;
    expect(s.order).toEqual([0, 1, 2, 3]);
  });

  it("无 $0 时按出现顺序导航", () => {
    const s = buildSession(0, parseReplacement("ab$1cd$2", [], null))!;
    expect(s.order).toEqual([1, 2]);
  });

  it("镜像 stop($0 出现两次)共享同一 ranges 组", () => {
    const s = buildSession(0, parseReplacement("\\begin{$0}\n$1\n\\end{$0}", [], null))!;
    expect(s.order).toEqual([0, 1]);
    expect(s.stops.get(0)!.length).toBe(2);
  });

  it("无 stop 的 replacement 不建会话", () => {
    expect(buildSession(0, parseReplacement("\\alpha", [], null))).toBeNull();
  });
});

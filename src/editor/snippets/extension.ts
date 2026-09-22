import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { findSnippet, parseReplacement, snippetStore } from "./engine";
import type { MatchResult, ParsedReplacement } from "./engine";
import { autoFraction } from "./autofraction";

/**
 * Snippet session: tracks tabstop positions of the snippet expanded at the
 * cursor. Mirrored tabstops (same index appearing several times) are kept in
 * sync after each edit, like latex-suite.
 *
 * 会话是**栈**(parent 链):会话期内再展开的片段(括号里打 sq、bf,括号里
 * 打 / 扩分数)压入子会话,Tab 从最内层逐层走出——latex-suite 的嵌套语义。
 * 字段每次事务映射**整条链**上每个会话的 stops,弹出时父会话的位置已是最新。
 */
interface SnippetSession {
  base: number;
  end: number;
  /** Unique tabstop indices in navigation order ($0 first when present). */
  order: number[];
  /** Current ranges per tabstop index (may contain mirrors). */
  stops: Map<number, { from: number; to: number }[]>;
  /** Index into `order`. */
  active: number;
  parent: SnippetSession | null;
}

/** 会话栈的实现细节,导出供无 DOM 回归测试驱动(snippetSession.test.ts)。 */
export type { SnippetSession };
export { setSession, snippetField, buildSession };

const setSession = StateEffect.define<SnippetSession | null>();

/** 展开时的旧会话压为 parent;映射整条链;全文档替换(切换文件/装载)清空。 */
const snippetField = StateField.define<SnippetSession | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setSession)) continue;
      // 新会话自身的位置按事务**后**的文档构造,不再映射;但挂上来的
      // parent 链还是事务前的对象——不映射父链,父层 stops/base 就停在
      // 旧文档坐标上(展开发生在父层 active stop 内,映射正好让它生长)。
      const v = e.value;
      return v && v.parent ? { ...v, parent: mapSession(v.parent, tr) } : v;
    }
    if (!value) return null;
    if (fullReplace(tr)) return null;
    if (!tr.docChanged) return value;
    return mapSession(value, tr);
  },
});

/** 单个 change 覆盖整个旧文档 = 换文件/整篇装载,会话锚定的文档已不存在。 */
function fullReplace(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  const oldLen = tr.startState.doc.length;
  let full = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (fromA === 0 && toA === oldLen) full = true;
  });
  return full;
}

function mapSession(s: SnippetSession, tr: Transaction): SnippetSession {
  // The active stop grows around insertions at its position (-1/+1 mapping)
  // so its range always contains what the user typed — mirror sync reads it.
  // 链上每个会话的 active stop 都如此生长(子会话的活动区就长在父会话的
  // active stop 里)。
  const activeIdx = s.order[s.active];
  const stops = new Map<number, { from: number; to: number }[]>();
  for (const [idx, ranges] of s.stops) {
    stops.set(
      idx,
      ranges.map((r) =>
        idx === activeIdx
          ? { from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }
          : { from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, 1) },
      ),
    );
  }
  return {
    base: tr.changes.mapPos(s.base, 1),
    end: tr.changes.mapPos(s.end, 1),
    order: s.order,
    stops,
    active: s.active,
    parent: s.parent ? mapSession(s.parent, tr) : null,
  };
}

function buildSession(
  start: number,
  replacement: ParsedReplacement,
  parent: SnippetSession | null = null,
): SnippetSession | null {
  const { stops } = replacement;
  if (stops.length === 0) return null;
  const base = start;
  const end = start + replacement.text.length;

  const order: number[] = [];
  const seen = new Set<number>();
  for (const s of stops) {
    if (!seen.has(s.index)) {
      seen.add(s.index);
      order.push(s.index);
    }
  }
  // $0 is the primary typing position; navigate to it first.
  if (order.includes(0)) {
    const withoutZero = order.filter((i) => i !== 0);
    order.splice(0, order.length, 0, ...withoutZero);
  }

  const ranges = new Map<number, { from: number; to: number }[]>();
  for (const s of stops) {
    const abs = { from: base + s.from, to: base + s.to };
    const list = ranges.get(s.index) ?? [];
    list.push(abs);
    ranges.set(s.index, list);
  }

  return { base, end, order, stops: ranges, active: 0, parent };
}

function startSessionAt(
  view: EditorView,
  start: number,
  end: number,
  replacement: ParsedReplacement,
): boolean {
  const session = buildSession(start, replacement, view.state.field(snippetField, false));
  const firstStop = session ? session.stops.get(session.order[0])![0] : null;
  view.dispatch({
    changes: { from: start, to: end, insert: replacement.text },
    selection: firstStop
      ? { anchor: firstStop.from, head: firstStop.to }
      : { anchor: start + replacement.text.length },
    effects: session ? setSession.of(session) : setSession.of(null),
    scrollIntoView: true,
    userEvent: "input.snippet",
  });
  view.focus();
  return true;
}

function startSession(view: EditorView, m: MatchResult): boolean {
  return startSessionAt(view, m.start, m.end, m.replacement);
}

function selectStop(view: EditorView, session: SnippetSession, active: number) {
  const ranges = session.stops.get(session.order[active])!;
  const first = ranges[0];
  view.dispatch({
    selection: EditorSelection.range(first.from, first.to),
    effects: setSession.of({ ...session, active }),
    scrollIntoView: true,
  });
}

/** Tab 的纯决策:本层走完弹到父层继续推进,根走完即结束(光标原地——单 $0
 *  片段如 dm 的 Tab 必须留在公式块内,跳到闭合 $$ 之后是旧模型的 bug)。 */
export type TabPlan =
  | { kind: "select"; session: SnippetSession; index: number }
  | { kind: "end" };

export function planTab(session: SnippetSession): TabPlan {
  const next = session.active + 1;
  if (next < session.order.length) return { kind: "select", session, index: next };
  if (session.parent) return planTab(session.parent);
  return { kind: "end" };
}

function nextStop(view: EditorView): boolean {
  const session = view.state.field(snippetField, false);
  if (!session) return false;
  const plan = planTab(session);
  if (plan.kind === "end") {
    view.dispatch({ effects: setSession.of(null) });
    return true;
  }
  selectStop(view, plan.session, plan.index);
  return true;
}

function previousStop(view: EditorView): boolean {
  const session = view.state.field(snippetField, false);
  if (!session) return false;
  if (session.active > 0) {
    selectStop(view, session, session.active - 1);
    return true;
  }
  // 已在本层第一个 stop:有外层弹回外层,否则结束会话
  view.dispatch({ effects: setSession.of(session.parent ?? null) });
  return true;
}

function clearSession(view: EditorView): boolean {
  if (!view.state.field(snippetField, false)) return false;
  view.dispatch({ effects: setSession.of(null) });
  return true;
}

/** Manual expansion on Tab when no session is active. */
function expandOnTab(view: EditorView): boolean {
  if (!snippetStore.enabled) return false;
  const { state } = view;
  const range = state.selection.main;
  if (state.selection.ranges.length > 1) return false;
  const visualText = range.empty ? null : state.sliceDoc(range.from, range.to);
  const match = findSnippet(state, range.to, null, { auto: false, visualText });
  if (!match) return false;
  return startSession(view, match);
}

/** Auto-expansion right after typing a character. */
export function tryAutoExpand(view: EditorView, key: string, visualText: string | null): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const cursor = state.selection.main.to;
  // latex-suite auto-fraction:数学态内键入 `/` 把光标前的表达式扩成分数。
  // "/" 已由调用方插入(光标停在其后),展开时连同它一起被替换。
  // 除号在 snippet 会话期间同样生效(latex-suite 里它是击键级特性):会话
  // 中的 `/` 压入子会话,Tab 先走完分数再回到外层(`f(` 的括号会话横跨整行,
  // `(x)=1/` 这种最常见形态必须能扩)。导出供回归测试在假视图上锁汇合点。
  if (key === "/" && snippetStore.enabled) {
    const frac = autoFraction(state, cursor, visualText);
    if (frac) return startSessionAt(view, frac.start, frac.end, frac.replacement);
  }
  if (!canAutoExpand(view)) return false;
  const match = findSnippet(state, cursor, key, { auto: true, visualText });
  if (!match) return false;
  return startSession(view, match);
}

/** Auto-expansion right after typing a character. 会话期间不再压制:嵌套
 *  展开压入子会话(见 SnippetSession.parent),旧的"整体替换旧会话"才是
 *  镜像 tabstop 损坏的根源。 */
function canAutoExpand(view: EditorView): boolean {
  return snippetStore.enabled && !view.composing;
}

const autoExpandHandler = EditorView.inputHandler.of((view, from, to, text) => {
  // composition 输入交还默认路径(展开会和 IME 的 DOM 改写打架)。
  if (view.composing) return false;
  const key = triggerKeyOf(text);
  if (!key || !canAutoExpand(view)) return false;
  const visualText = to > from ? view.state.sliceDoc(from, to) : null;
  // Perform the default insertion ourselves, then look for a trigger.
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.type",
    scrollIntoView: true,
  });
  tryAutoExpand(view, key, visualText);
  return true;
});

/** 单字符自动触发键;多字符提交(IME 整串上屏)只认以 / 结尾的形态。 */
function triggerKeyOf(text: string): string | null {
  if (text === "\n" || text.length === 0) return null;
  if (text.length === 1) return text;
  return text.endsWith("/") ? "/" : null;
}

/** IME composition 提交路径:composition 活跃期间的更新不能当场展开(展开
 *  事务会和 IME 的 DOM 改写打架),记住除号位置,composition 结束后补展开。
 *  补展开时把 / 与当前光标之间(同行)已输入的内容吞进分母——整串上屏的
 *  `f(x)=1/xsk` 里 xsk 就是用户要打的分母。 */
let pendingFraction: { slash: number } | null = null;
let pendingFractionTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDeferredFraction(view: EditorView) {
  if (pendingFractionTimer) return;
  const tick = () => {
    pendingFractionTimer = null;
    if (!pendingFraction) return;
    if (view.composing) {
      pendingFractionTimer = setTimeout(tick, 30);
      return;
    }
    const pf = pendingFraction;
    pendingFraction = null;
    deferredExpand(view, pf.slash);
  };
  pendingFractionTimer = setTimeout(tick, 30);
}

function deferredExpand(view: EditorView, slash: number) {
  const { state } = view;
  if (state.doc.sliceString(slash - 1, slash) !== "/") return; // 除号已不在
  const frac = autoFraction(state, slash, null);
  if (!frac) return;
  const head = state.selection.main.head;
  const sameLine =
    head > slash && state.doc.lineAt(head - 1).number === state.doc.lineAt(slash).number;
  const den = sameLine ? state.doc.sliceString(slash, head) : "";
  const numerator = state.doc.sliceString(frac.start, slash - 1);
  if (sameLine && /^[\w^_{}\\+\-.]*$/.test(den)) {
    // 分母是已上屏的公式字符:整体扩成 \frac{分子}{分母}。
    startSessionAt(
      view,
      frac.start,
      head,
      parseReplacement(`\\frac{${numerator}}{${den}}$1`, [], null),
    );
    return;
  }
  startSessionAt(view, frac.start, frac.end, frac.replacement);
}

/** Vim-mode typing never reaches the input handler: @replit/codemirror-vim
 *  inserts characters via its own transactions (userEvent "input.type.compose").
 *  Without this listener every automatic snippet is dead while vim is on.
 *  IME composition 提交也走 compose 事务(整串、composing 标志仍为 true)。 */
const autoExpandVimListener = EditorView.updateListener.of((u) => {
  if (!u.docChanged || !snippetStore.enabled) return;
  if (u.transactions.length !== 1) return;
  const tr = u.transactions[0];
  if (!tr.isUserEvent("input.type.compose")) return;
  if (u.state.selection.ranges.length > 1) return;

  let inserted: string | null = null;
  let insertTo = -1;
  let replaceFrom = -1;
  let replaceTo = -1;
  tr.changes.iterChanges((fromA, toA, _fromB, toB, text) => {
    const s = text.toString();
    if (inserted !== null || s.length === 0 || s === "\n") {
      inserted = null;
      return;
    }
    inserted = s;
    insertTo = toB;
    replaceFrom = fromA;
    replaceTo = toA;
  });
  if (inserted === null) return;
  const key = triggerKeyOf(inserted);
  if (!key) return;
  const sel = u.state.selection.main;
  if (!sel.empty || sel.to !== insertTo) return;
  const visualText = replaceTo > replaceFrom ? u.startState.sliceDoc(replaceFrom, replaceTo) : null;
  // composition 活跃期间不当场展开,除号记下来等 composition 结束(见上)。
  if (u.view.composing) {
    if (key === "/") {
      pendingFraction = { slash: insertTo };
      scheduleDeferredFraction(u.view);
    }
    return;
  }
  tryAutoExpand(u.view, key, visualText);
});

/** Keeps mirrored tabstops in sync after edits. 链上每个会话的 active stop
 *  都参与同步:子会话长在父会话的 active stop 里,父层的镜像(如 beg 的
 *  \begin/\end 环境名)在子会话打字时也要跟上。 */
const mirrorSyncListener = EditorView.updateListener.of((u) => {
  if (!u.docChanged || !u.selectionSet) return; // sync only after user edits
  const session = u.state.field(snippetField, false);
  if (!session) return;

  const doc = u.state.doc;
  const head = u.state.selection.main.head;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let node: SnippetSession | null = session; node; node = node.parent) {
    const ranges = node.stops.get(node.order[node.active]);
    if (!ranges || ranges.length < 2) continue;
    const valid = ranges.filter((r) => r.from <= r.to && r.from >= 0 && r.to <= doc.length);
    if (valid.length < 2) continue;

    const source =
      valid.find((r) => head >= r.from && head <= r.to) ?? valid[0];
    const content = doc.sliceString(source.from, source.to);
    if (valid.every((r) => doc.sliceString(r.from, r.to) === content)) continue;
    for (const r of valid) {
      if (r !== source) changes.push({ from: r.from, to: r.to, insert: content });
    }
  }
  if (changes.length === 0) return;
  u.view.dispatch({
    changes,
    userEvent: "input.snippet-mirror",
  });
});

/** Ends (pops) sessions the cursor has left. Runs on selection changes
 *  including doc-edit ones. 光标离开哪层就弹到哪层:离开子会话回到父会话,
 *  离开整条链才真正结束。 */
const exitListener = EditorView.updateListener.of((u) => {
  if (!u.selectionSet) return;
  const session = u.state.field(snippetField, false);
  if (!session) return;
  const keep = exitChain(session, u.state.selection.main.head);
  if (keep !== session) {
    u.view.dispatch({ effects: setSession.of(keep) });
  }
});

/** 光标仍被哪层会话包含就保留到哪层(纯函数,导出供回归测试)。 */
export function exitChain(session: SnippetSession, head: number): SnippetSession | null {
  let cur: SnippetSession | null = session;
  while (cur && (head < cur.base || head > cur.end)) cur = cur.parent;
  return cur;
}

const snippetKeymap = keymap.of([
  { key: "Tab", run: nextStopThenExpand },
  { key: "Shift-Tab", run: previousStop },
  { key: "Escape", run: clearSession },
]);

function nextStopThenExpand(view: EditorView): boolean {
  if (view.state.field(snippetField, false)) return nextStop(view);
  return expandOnTab(view);
}

export function snippetsExtension(): Extension {
  return [
    snippetField,
    autoExpandHandler,
    autoExpandVimListener,
    mirrorSyncListener,
    exitListener,
    snippetKeymap,
  ];
}

/** Debug access to the active snippet session (dev diagnostics). */
export function getSession(view: EditorView): SnippetSession | null {
  return view.state.field(snippetField, false) ?? null;
}

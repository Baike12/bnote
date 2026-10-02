import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { findSnippet, parseReplacement, snippetStore } from "./engine";
import type { MatchResult, ParsedReplacement } from "./engine";
import { getContextAt, mathRegions } from "../context";
import { autoFraction } from "./autofraction";
import { autoEnlargeBrackets } from "./enlarge";
import { matrixSeparator } from "./matrix";
import { tabout } from "./tabout";
import { bracketPlugins } from "./brackets";
import { latexConfig } from "./config";
import { useAppStore } from "@/state/appStore";

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
  /** 替换文本末尾(绝对坐标):最后一个制表位上按 Tab 的默认落点。 */
  finalPos: number;
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
    finalPos: tr.changes.mapPos(s.finalPos, 1),
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

  return { base, end, finalPos: end, order, stops: ranges, active: 0, parent };
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
  // latex-suite 的 autoEnlargeBrackets 就挂在这里:展开/自动分数之后看插入文本
  // 里有没有"大个子"(sum/int/frac…),有就把外层括号升成 \left…\right。
  // 它另发一个事务——会话位置由 snippetField 的映射跟着走,不用手工平移。
  autoEnlargeBrackets(view, replacement.text);
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

/** Tab 的纯决策:本层走完弹到父层继续推进,根走完即结束。结束的落点由
 *  exitCursorPosition 决定(默认替换文本末尾,公式块内夹紧)。 */
export type TabPlan =
  | { kind: "select"; session: SnippetSession; index: number }
  | { kind: "end"; session: SnippetSession };

export function planTab(session: SnippetSession): TabPlan {
  const next = session.active + 1;
  if (next < session.order.length) return { kind: "select", session, index: next };
  if (session.parent) return planTab(session.parent);
  return { kind: "end", session };
}

/**
 * 会话结束时光标的落点:替换文本末尾(finalPos)——这是括号类片段
 * (\mathbf{$0}、_{$0})「Tab 跳出右括号」的来源。唯一例外:光标在公式
 * 区域内且 finalPos 已不在区域 strictly 内部(=finalPos 恰越过闭合
 * $$/$,如 dm/mk/ma 这类整块创建片段),此时光标原地结束,不把用户扔出
 * 公式块(dc00d55 的语义,这里以区域夹紧的方式保留)。
 * 纯函数(node 可测);返回 null = 原地结束。
 */
export function exitCursorPosition(state: EditorState, session: SnippetSession): number | null {
  const head = state.selection.main.head;
  const region = mathRegions(state).find((r) => head >= r.from && head <= r.to);
  if (region && session.finalPos >= region.to) return null;
  return session.finalPos;
}

function nextStop(view: EditorView): boolean {
  const session = view.state.field(snippetField, false);
  if (!session) return false;
  const plan = planTab(session);
  if (plan.kind === "end") {
    const target = exitCursorPosition(view.state, plan.session);
    view.dispatch({
      ...(target === null ? {} : { selection: EditorSelection.cursor(target) }),
      effects: setSession.of(null),
      scrollIntoView: target !== null,
    });
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

/** Esc：vim 开启时归引擎（先退插入态），会话由 exitListener 在光标离开
 *  片段区间时弹掉——否则活会话把第一下 Esc 吃掉，退出要按两下。vim 关闭时
 *  维持 latex-suite 语义（Esc 结束会话）。读设置而非 vim 引擎：snippets 不
 *  反向依赖引擎（门控统一放在绑定点，见 setup.ts 的 backspace/Enter 同款）。
 *  导出供门禁（keyDispatch.test.ts）。 */
export function escapeForSnippet(view: EditorView): boolean {
  if (useAppStore.getState().settings.vim) return false;
  return clearSession(view);
}

/** 展开查找的统一入口:把 LaTeX Suite 的展开期设置(wordDelimiters、
 *  removeSnippetWhitespace)一并交给引擎,引擎本身不读设置(保持纯逻辑可测)。 */
function findSnippetHere(
  state: EditorState,
  cursor: number,
  typedKey: string | null,
  opts: { auto: boolean; visualText: string | null },
): MatchResult | null {
  const cfg = latexConfig();
  return findSnippet(state, cursor, typedKey, {
    ...opts,
    removeSnippetWhitespace: cfg.removeSnippetWhitespace,
    wordDelimiters: cfg.wordDelimiters,
  });
}

/** Manual expansion on Tab when no session is active. */
function expandOnTab(view: EditorView): boolean {
  if (!snippetStore.enabled) return false;
  const { state } = view;
  const range = state.selection.main;
  if (state.selection.ranges.length > 1) return false;
  const visualText = range.empty ? null : state.sliceDoc(range.from, range.to);
  const match = findSnippetHere(state, range.to, null, { auto: false, visualText });
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
  // 环境名内不做自动展开(见 insideEnvName);手动 Tab 展开不受限——那是
  // 用户的显式意图。
  if (insideEnvName(state, cursor)) return false;
  const match = findSnippetHere(state, cursor, key, { auto: true, visualText });
  if (!match) return false;
  return startSession(view, match);
}

/** 光标是否在 `\begin{` / `\end{` 的环境名里(花括号未闭合)。
 *  环境名位置打的是环境名本身——`align` 一词里的 "ali" 命中 ali 片段时,
 *  整个环境模板会被插进环境名,镜像同步再把损坏复制进 `\end{}`,光标随之
 *  "乱漂移"(实测:环境名里打第 3 个字符时光标跳 12 字符并跨行)。
 *  行内回扫 O(行长),挂在每键一次的自动展开判定上可忽略。 */
function insideEnvName(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return /\\(?:begin|end)\{[^}]*$/.test(line.text.slice(0, pos - line.from));
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

const CLOSE_BRACKETS = ")]}";

/** latex-suite 的 `shouldTaboutByCloseBracket` 判定:光标**正对着**一个右括号
 *  时敲下同一个右括号,不该再插一个(凭空多出来的 `()` 就是这么来的),而应
 *  当作一次 Tab——会话里即"跳出这一层"。用**事务前**的文档判定(from/to 是
 *  默认插入要替换的区间:空区间=光标处敲键),有选区或非右括号一律不算。 */
export function faceCloseBracket(
  state: EditorState,
  from: number,
  to: number,
  text: string,
): boolean {
  if (from !== to || text.length !== 1 || !CLOSE_BRACKETS.includes(text)) return false;
  return state.doc.sliceString(from, from + 1) === text;
}

/**
 * 闭括号跳越的落地:传参是刚发生的"插入事务"的形状。之所以落在**事后**的文档
 * 事务上,是因为 vim 引擎自己插字符、不走 inputHandler,而 vim 是用户的主路径
 * ——两边的唯一交汇点就是这里。做法是撤掉刚插入的那一个字符(原位那个是片段/
 * 用户原有的,留着),再按 Tab 的次序往前一步。仅当会话里确实还有下一个制表位
 * 时接管;末位按插件原样放行(字符照插——consumeAndGotoNextTabstop 在最后一组
 * 就是返回 false)。
 */
export function closeBracketSkip(
  view: EditorView,
  before: EditorState,
  change: { from: number; to: number; insert: string },
  head: number,
): boolean {
  if (!faceCloseBracket(before, change.from, change.to, change.insert)) return false;
  if (head !== change.from + change.insert.length) return false;
  const session = view.state.field(snippetField, false);
  if (!session) return false;
  const plan = planTab(session);
  if (plan.kind !== "select") return false;
  view.dispatch({
    changes: { from: change.from, to: change.from + change.insert.length, insert: "" },
    userEvent: "delete.close-bracket-skip",
  });
  // 会话在事务里被整条重映射过:制表位要重新取,不能拿事务前的对象接着用。
  const mapped = view.state.field(snippetField, false);
  if (mapped) selectStop(view, mapped, plan.index);
  return true;
}

const closeBracketSkipListener = EditorView.updateListener.of((u) => {
  if (!u.docChanged || u.view.composing) return;
  if (u.transactions.length !== 1) return;
  const tr = u.transactions[0];
  if (!tr.isUserEvent("input.type") && !tr.isUserEvent("input.type.compose")) return;
  const sel = u.state.selection.main;
  if (!sel.empty || u.state.selection.ranges.length > 1) return;

  let from = -1;
  let to = -1;
  let insert = "";
  let count = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
    count++;
    from = fromA;
    to = toA;
    insert = ins.toString();
  });
  if (count !== 1) return;
  closeBracketSkip(u.view, tr.startState, { from, to, insert }, sel.head);
});

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
  { key: "Tab", run: runTab },
  // Shift+Tab:先回上一个制表位(bnote 自己的便利),再矩阵列分隔,最后同 Tab
  // 一样可以跳出——插件那边 shift 也算 "Tab"(matrix_shortcuts 与 tabout 都吃)。
  { key: "Shift-Tab", run: runShiftTab },
  { key: "Escape", run: escapeForSnippet },
]);

/**
 * Tab 的三层决策,顺序照插件的 handleKeydown(片段/tabstop → 矩阵 → tabout):
 * 会话里先走制表位;没会话就试着展开片段;两者都不成立才跳出括号。
 * 导出供门禁直接锁这条**次序**——"Tab 跳不出去"的根因就是最后一层缺位,
 * 单测每个部件都测不出这个回归。
 */
export function runTab(view: EditorView): boolean {
  if (view.state.field(snippetField, false)) return nextStop(view);
  if (expandOnTab(view)) return true;
  return tabout(view);
}

/** Shift+Tab:上一个制表位 → 矩阵 ` & ` → 跳出。插件里矩阵分隔符只挂在
 *  Shift 上(`&` 与 tabout 的分工见 matrix.ts),所以这里不能少这一层。 */
export function runShiftTab(view: EditorView): boolean {
  if (previousStop(view)) return true;
  if (matrixSeparator(view)) return true;
  return tabout(view);
}

/**
 * latex-suite 的 `autoDelete$`:光标正好夹在两个 `$` 之间(`$|$`/`$$|$$`,
 * 空公式的常态)按 Backspace 时一次删掉两个。否则要按两下,中间那一瞬文档里
 * 留着落单的 `$`——实时预览会闪一下,空块还会被当成"打字中的公式"。
 *
 * 只管"删什么",不管"该不该在这里删":vim 非 insert 模式的闸门在绑定点
 * (setup.ts),那里能读到 vim 模式且不把 vim 引擎拖进本模块。
 */
export function deleteDollarPair(view: EditorView): boolean {
  if (!latexConfig().autoDeleteDollar) return false;
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const pos = range.head;
  const doc = view.state.doc;
  if (doc.sliceString(pos, pos + 1) !== "$") return false;
  if (pos <= 0 || doc.sliceString(pos - 1, pos) !== "$") return false;
  const ctx = getContextAt(view.state, pos);
  if (!ctx.inlineMath && !ctx.blockMath) return false;
  view.dispatch({
    changes: { from: pos - 1, to: pos + 1, insert: "" },
    userEvent: "delete.dollar-pair",
    scrollIntoView: true,
  });
  return true;
}

/**
 * 上下标空花括号的整对删除:光标夹在 `_{}` / `^{}` 的花括号之间(sj/sk
 * 展开后的常态)按 Backspace,连同 `_`(或 `^`)一起删干净,而不是先啃掉
 * `{`、留下 `_}` 再按两下。
 *
 * 三字符的字面判断放在 getContextAt 之前:后者内部的 mathRegions 要扫全篇
 * 文档,而 Backspace 是高频键,绝大多数按键都会被这一次三字符切片短路掉。
 * 正文里的 `_{}` 不碰——那里 `_` 是 markdown 的强调标记,语义完全不同。
 *
 * 会话不动,交给现有机制:被删区间正是当前会话的活动区,mapSession 会把这一
 * 层收成 base=end 的一个点;子会话单 stop 无镜像(mirrorSync 跳过),光标一
 * 动 exitListener 就把它弹掉,外层会话(如 \frac 的分母)原地保留。
 * 与 deleteDollarPair 同为"只管删什么、不管该不该在这里删"——vim 非 insert
 * 模式的闸门在绑定点(setup.ts)。
 */
export function deleteScriptBraces(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const pos = range.head;
  if (pos < 2) return false;
  const doc = view.state.doc;
  const lead = doc.sliceString(pos - 2, pos + 1);
  if (lead !== "_{}" && lead !== "^{}") return false;
  const ctx = getContextAt(view.state, pos);
  if (!ctx.inlineMath && !ctx.blockMath) return false;
  view.dispatch({
    changes: { from: pos - 2, to: pos + 1, insert: "" },
    userEvent: "delete.script-braces",
    scrollIntoView: true,
  });
  return true;
}

export function snippetsExtension(): Extension {
  return [
    snippetField,
    autoExpandHandler,
    autoExpandVimListener,
    closeBracketSkipListener,
    mirrorSyncListener,
    exitListener,
    snippetKeymap,
    // 括号彩色配对 + 光标括号高亮(同为 LaTeX Suite 特性,各自带开关)。
    ...bracketPlugins(),
  ];
}

/** Debug access to the active snippet session (dev diagnostics). */
export function getSession(view: EditorView): SnippetSession | null {
  return view.state.field(snippetField, false) ?? null;
}

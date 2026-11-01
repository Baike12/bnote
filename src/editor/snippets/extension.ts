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
 * A session is a **stack** (a parent chain): a snippet expanded during a
 * session (sq or bf inside brackets, a fraction expanded by / inside brackets)
 * is pushed as a child session, and Tab walks out from the innermost level —
 * latex-suite's nesting semantics. On every transaction the field maps the
 * stops of **every session on the whole chain**, so a parent session's
 * positions are already current when it is popped.
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
  /** The end of the replacement text (absolute coordinates): the default
   *  landing point when Tab is pressed on the last tab stop. */
  finalPos: number;
  parent: SnippetSession | null;
}

/** Implementation details of the session stack, exported so the DOM-less
 *  regression tests can drive them (snippetSession.test.ts). */
export type { SnippetSession };
export { setSession, snippetField, buildSession };

const setSession = StateEffect.define<SnippetSession | null>();

/** The old session becomes the parent of the expanding one; the whole chain is
 *  mapped; a full-document replacement (switching files / loading) clears it. */
const snippetField = StateField.define<SnippetSession | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setSession)) continue;
      // The new session's own positions are built against the document
      // **after** the transaction and are not mapped again; but the parent
      // chain it is attached to is still the pre-transaction object — without
      // mapping the parent chain the parent's stops/base would stay on the
      // old document coordinates (the expansion happens inside the parent's
      // active stop, where the mapping makes it grow).
      const v = e.value;
      return v && v.parent ? { ...v, parent: mapSession(v.parent, tr) } : v;
    }
    if (!value) return null;
    if (fullReplace(tr)) return null;
    if (!tr.docChanged) return value;
    return mapSession(value, tr);
  },
});

/** A single change covering the whole old document means switching files /
 *  loading the whole file; the document the session was anchored to is gone. */
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
  // The active stop of every session on the chain grows this way (a child
  // session's active region grows inside its parent's active stop).
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
  // latex-suite's autoEnlargeBrackets hooks in here: after the expansion or
  // the auto-fraction, check whether the inserted text contains a "big
  // operator" (sum/int/frac…), and if so upgrade the outer brackets to
  // \left…\right. It dispatches its own transaction — the session positions
  // follow along through snippetField's mapping, so nothing is shifted by
  // hand.
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

/** The pure decision for Tab: when the current level is done, pop to the
 *  parent and keep advancing; when the root is done, the session ends. The
 *  landing point at the end is decided by exitCursorPosition (by default the
 *  end of the replacement text, clamped inside a formula block). */
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
 * Where the caret lands when the session ends: the end of the replacement text
 * (finalPos) — this is the source of "Tab leaves the closing bracket" for
 * bracket snippets (\mathbf{$0}, _{$0}). The only exception: the caret is
 * inside a formula region and finalPos is no longer strictly inside that
 * region (= finalPos has just passed the closing $$/$, as with the
 * whole-block snippets dm/mk/ma); then the session ends in place and the user
 * is not thrown out of the formula block (dc00d55's semantics, kept here by
 * clamping to the region).
 * A pure function (testable in node); null = end in place.
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
  // Already at the first stop of this level: pop to the outer level if there
  // is one, otherwise end the session.
  view.dispatch({ effects: setSession.of(session.parent ?? null) });
  return true;
}

function clearSession(view: EditorView): boolean {
  if (!view.state.field(snippetField, false)) return false;
  view.dispatch({ effects: setSession.of(null) });
  return true;
}

/** Esc: with vim enabled it belongs to the engine (which first leaves insert
 *  mode), and the session is popped by the exitListener once the caret leaves
 *  the snippet region — otherwise a live session swallows the first Esc and
 *  leaving takes two presses. With vim off, latex-suite's semantics are kept
 *  (Esc ends the session). It reads the settings rather than the vim engine:
 *  snippets must not depend on the engine in reverse (the gating lives in the
 *  binding point, the same as the backspace/Enter cases in setup.ts).
 *  Exported for the gate (keyDispatch.test.ts). */
export function escapeForSnippet(view: EditorView): boolean {
  if (useAppStore.getState().settings.vim) return false;
  return clearSession(view);
}

/** The single entry point for the expansion lookup: it hands the LaTeX Suite
 *  expansion-time settings (wordDelimiters, removeSnippetWhitespace) to the
 *  engine, and the engine itself reads no settings (keeping the logic pure
 *  and testable). */
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
  // latex-suite auto-fraction: typing `/` in math mode expands the expression
  // before the caret into a fraction. The caller has already inserted the
  // "/" (the caret sits after it), and the expansion replaces it as well.
  // The slash works during a snippet session too (in latex-suite it is a
  // keystroke-level feature): a `/` inside a session pushes a child session,
  // and Tab finishes the fraction first and then returns to the outer level
  // (the bracket session of `f(` spans the whole line, so the most common
  // shape, `(x)=1/`, must be expandable). Exported so the regression tests can
  // lock the meeting point on a fake view.
  if (key === "/" && snippetStore.enabled) {
    const frac = autoFraction(state, cursor, visualText);
    if (frac) return startSessionAt(view, frac.start, frac.end, frac.replacement);
  }
  if (!canAutoExpand(view)) return false;
  // No auto expansion inside an environment name (see insideEnvName); the
  // manual Tab expansion is not restricted — that is the user's explicit
  // intent.
  if (insideEnvName(state, cursor)) return false;
  const match = findSnippetHere(state, cursor, key, { auto: true, visualText });
  if (!match) return false;
  return startSession(view, match);
}

/** Whether the caret is inside the environment name of `\begin{` / `\end{`
 *  (the braces are not closed yet).
 *  Typing there types the environment name itself — when the "ali" inside
 *  `align` hits the ali snippet, the whole environment template is inserted
 *  into the environment name, and the mirror sync then copies the damage into
 *  `\end{}`, with the caret drifting along (measured: on the 3rd character in
 *  an environment name the caret jumps 12 characters and crosses a line).
 *  The backwards scan within the line is O(line length), which is negligible
 *  on the once-per-keystroke auto expansion check. */
function insideEnvName(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return /\\(?:begin|end)\{[^}]*$/.test(line.text.slice(0, pos - line.from));
}

/** Auto-expansion right after typing a character. It is no longer suppressed
 *  during a session: a nested expansion pushes a child session (see
 *  SnippetSession.parent); the old "replace the whole old session" behavior
 *  was the root cause of the mirror tab stop corruption. */
function canAutoExpand(view: EditorView): boolean {
  return snippetStore.enabled && !view.composing;
}

const autoExpandHandler = EditorView.inputHandler.of((view, from, to, text) => {
  // A composition input goes back to the default path (the expansion would
  // fight the IME's DOM rewriting).
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

/** The single-character auto trigger key; a multi-character commit (the IME
 *  pushing a whole string) is only recognized when it ends with "/". */
function triggerKeyOf(text: string): string | null {
  if (text === "\n" || text.length === 0) return null;
  if (text.length === 1) return text;
  return text.endsWith("/") ? "/" : null;
}

const CLOSE_BRACKETS = ")]}";

/** latex-suite's `shouldTaboutByCloseBracket` decision: typing the same
 *  closing bracket while the caret **faces** it must not insert another one
 *  (that is where the out-of-thin-air `()` comes from); it counts as a Tab —
 *  inside a session that means "leave this level". The decision is made
 *  against the document **before** the transaction (from/to are the range the
 *  default insertion would replace: an empty range means a keypress at the
 *  caret); a selection or a non-closing bracket never qualifies. */
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
 * The landing of the closing-bracket skip: the arguments are the shape of the
 * "insertion transaction" that just happened. It deliberately acts on the
 * document transaction **after** the fact, because the vim engine inserts the
 * character itself and does not go through the inputHandler, and vim is the
 * user's main path — this is the only meeting point of the two sides. The
 * approach is to undo the character that was just inserted (the one already
 * there belongs to the snippet or to the user, so it stays) and then advance
 * one step in Tab order. It takes over only when the session really has a
 * next tab stop; at the last one it lets the plugin's behavior through
 * unchanged (the character is inserted as typed — consumeAndGotoNextTabstop
 * returns false for the last group).
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
  // The session has been remapped as a whole in the transaction: the tab stops
  // must be fetched again, the pre-transaction object cannot be reused.
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

/** The IME composition commit path: an update while the composition is active
 *  cannot expand on the spot (the expansion transaction would fight the
 *  IME's DOM rewriting), so the slash position is remembered and the
 *  expansion is made up for after the composition ends. The deferred
 *  expansion swallows the text typed between the "/" and the current caret
 *  (same line) into the denominator — in a whole-string commit
 *  `f(x)=1/xsk`, xsk is the denominator the user meant to type. */
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
  if (state.doc.sliceString(slash - 1, slash) !== "/") return; // The slash is gone.
  const frac = autoFraction(state, slash, null);
  if (!frac) return;
  const head = state.selection.main.head;
  const sameLine =
    head > slash && state.doc.lineAt(head - 1).number === state.doc.lineAt(slash).number;
  const den = sameLine ? state.doc.sliceString(slash, head) : "";
  const numerator = state.doc.sliceString(frac.start, slash - 1);
  if (sameLine && /^[\w^_{}\\+\-.]*$/.test(den)) {
    // The denominator is formula text already on screen: expand the whole
    // thing into \frac{numerator}{denominator}.
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
 *  An IME composition commit also goes through a compose transaction (the
 *  whole string, with the composing flag still true). */
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
  // No expansion on the spot while the composition is active; the slash is
  // remembered and waits for the composition to end (see above).
  if (u.view.composing) {
    if (key === "/") {
      pendingFraction = { slash: insertTo };
      scheduleDeferredFraction(u.view);
    }
    return;
  }
  tryAutoExpand(u.view, key, visualText);
});

/** Keeps mirrored tabstops in sync after edits. The active stop of every
 *  session on the chain takes part in the sync: a child session grows inside
 *  its parent's active stop, so the parent's mirrors (e.g. the \begin/\end
 *  environment names of beg) must keep up while the child is being typed. */
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
 *  including doc-edit ones. The caret pops to the level it left: leaving a
 *  child session returns to the parent, and only leaving the whole chain
 *  really ends it. */
const exitListener = EditorView.updateListener.of((u) => {
  if (!u.selectionSet) return;
  const session = u.state.field(snippetField, false);
  if (!session) return;
  const keep = exitChain(session, u.state.selection.main.head);
  if (keep !== session) {
    u.view.dispatch({ effects: setSession.of(keep) });
  }
});

/** Keeps the session up to the level that still contains the caret (a pure
 *  function, exported for the regression tests). */
export function exitChain(session: SnippetSession, head: number): SnippetSession | null {
  let cur: SnippetSession | null = session;
  while (cur && (head < cur.base || head > cur.end)) cur = cur.parent;
  return cur;
}

const snippetKeymap = keymap.of([
  { key: "Tab", run: runTab },
  // Shift+Tab: first go back to the previous tab stop (bnote's own
  // convenience), then the matrix column separator, then — like Tab — the way
  // out; in the plugin a shift also counts as "Tab" (both matrix_shortcuts and
  // tabout react to it).
  { key: "Shift-Tab", run: runShiftTab },
  { key: "Escape", run: escapeForSnippet },
]);

/**
 * Tab's three-layer decision, in the order of the plugin's handleKeydown
 * (snippet/tab stop → matrix → tabout): inside a session the tab stop comes
 * first; without a session a snippet expansion is tried; only when neither
 * holds does it leave the bracket.
 * Exported so the gate can lock this **order** directly — the root cause of
 * "Tab cannot get out" is a missing last layer, and unit tests of the
 * individual parts cannot catch that regression.
 */
export function runTab(view: EditorView): boolean {
  if (view.state.field(snippetField, false)) return nextStop(view);
  if (expandOnTab(view)) return true;
  return tabout(view);
}

/** Shift+Tab: previous tab stop → matrix ` & ` → leave. In the plugin the
 *  matrix separator hangs on Shift alone (see matrix.ts for the division of
 *  labour between `&` and tabout), so this layer cannot be dropped here. */
export function runShiftTab(view: EditorView): boolean {
  if (previousStop(view)) return true;
  if (matrixSeparator(view)) return true;
  return tabout(view);
}

/**
 * latex-suite's `autoDelete$`: when the caret sits exactly between two `$`
 * (`$|$`/`$$|$$`, the normal state of an empty formula), Backspace deletes
 * both at once. Otherwise two presses are needed, and in the meantime the
 * document keeps a lone `$` — the live preview flickers and the empty block
 * is even taken for a "formula being typed".
 *
 * It only decides *what* to delete, not *whether* it may delete here: the gate
 * for vim's non-insert mode lives at the binding point (setup.ts), which can
 * read the vim mode without dragging the vim engine into this module.
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
 * Deletes an empty subscript/superscript brace pair as a whole: when the caret
 * sits between the braces of `_{}` / `^{}` (the normal state after sj/sk
 * expanded), Backspace removes the `_` (or `^`) together with the braces,
 * instead of first eating the `{`, leaving `_}` and needing a second press.
 *
 * The literal three-character check comes before getContextAt: the mathRegions
 * inside the latter scans the whole document, while Backspace is a
 * high-frequency key and almost every keystroke is short-circuited by this
 * three-character slice. A `_{}` in prose is left alone — there `_` is
 * markdown's emphasis marker, with a completely different meaning.
 *
 * The session is left to the existing mechanism: the deleted range is exactly
 * the current session's active region, so mapSession collapses that level to a
 * single point with base=end; a child session with a single stop has no
 * mirror (mirrorSync skips it) and the exitListener pops it as soon as the
 * caret moves, while the outer session (e.g. the denominator of \frac) stays
 * in place.
 * Like deleteDollarPair it only decides *what* to delete, not *whether* it
 * may delete here — the gate for vim's non-insert mode lives at the binding
 * point (setup.ts).
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
    // Colored bracket pairs + caret bracket highlighting (both LaTeX Suite
    // features, each with its own switch).
    ...bracketPlugins(),
  ];
}

/** Debug access to the active snippet session (dev diagnostics). */
export function getSession(view: EditorView): SnippetSession | null {
  return view.state.field(snippetField, false) ?? null;
}

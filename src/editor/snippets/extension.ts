import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { findSnippet, snippetStore } from "./engine";
import type { MatchResult } from "./engine";

/**
 * Snippet session: tracks tabstop positions of the snippet expanded at the
 * cursor. Mirrored tabstops (same index appearing several times) are kept in
 * sync after each edit, like latex-suite.
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
  finalPos: number;
}

const setSession = StateEffect.define<SnippetSession | null>();

const snippetField = StateField.define<SnippetSession | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSession)) return e.value;
    }
    if (!value) return null;
    if (!tr.docChanged) return value;
    // The active stop grows around insertions at its position (-1/+1 mapping)
    // so its range always contains what the user typed — mirror sync reads it.
    const activeIdx = value.order[value.active];
    const stops = new Map<number, { from: number; to: number }[]>();
    for (const [idx, ranges] of value.stops) {
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
      base: tr.changes.mapPos(value.base, 1),
      end: tr.changes.mapPos(value.end, 1),
      order: value.order,
      stops,
      active: value.active,
      finalPos: tr.changes.mapPos(value.finalPos, 1),
    };
  },
});

function buildSession(m: MatchResult): SnippetSession | null {
  const { stops } = m.replacement;
  if (stops.length === 0) return null;
  const base = m.start;
  const end = m.start + m.replacement.text.length;

  const order: number[] = [];
  const seen = new Set<number>();
  const firstAppearance = new Map<number, number>();
  for (const s of stops) {
    if (!seen.has(s.index)) {
      seen.add(s.index);
      order.push(s.index);
      firstAppearance.set(s.index, s.from);
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

  return {
    base,
    end,
    order,
    stops: ranges,
    active: 0,
    finalPos: end,
  };
}

function startSession(view: EditorView, m: MatchResult): boolean {
  const session = buildSession(m);
  const firstStop = session ? session.stops.get(session.order[0])![0] : null;
  view.dispatch({
    changes: { from: m.start, to: m.end, insert: m.replacement.text },
    selection: firstStop
      ? { anchor: firstStop.from, head: firstStop.to }
      : { anchor: m.start + m.replacement.text.length },
    effects: session ? setSession.of(session) : setSession.of(null),
    scrollIntoView: true,
    userEvent: "input.snippet",
  });
  view.focus();
  return true;
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

function nextStop(view: EditorView): boolean {
  const session = view.state.field(snippetField, false);
  if (!session) return false;
  const next = session.active + 1;
  if (next >= session.order.length) {
    view.dispatch({
      selection: { anchor: session.finalPos },
      effects: setSession.of(null),
      scrollIntoView: true,
    });
    return true;
  }
  selectStop(view, session, next);
  return true;
}

function previousStop(view: EditorView): boolean {
  const session = view.state.field(snippetField, false);
  if (!session) return false;
  const prev = Math.max(0, session.active - 1);
  if (prev === session.active) {
    view.dispatch({ effects: setSession.of(null) });
    return true;
  }
  selectStop(view, session, prev);
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
function tryAutoExpand(view: EditorView, key: string, visualText: string | null): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const cursor = state.selection.main.to;
  const match = findSnippet(state, cursor, key, { auto: true, visualText });
  if (!match) return false;
  return startSession(view, match);
}

/** Auto-expansion right after typing a character. Suppressed while a snippet
 *  session is active: nested auto-triggers corrupt the outer session's
 *  mirrored tabstops (e.g. typing "align" inside beg's placeholder). */
function canAutoExpand(view: EditorView): boolean {
  return snippetStore.enabled && !view.composing && !view.state.field(snippetField, false);
}

const autoExpandHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (!canAutoExpand(view)) return false;
  if (text.length !== 1 || text === "\n") return false;
  const visualText = to > from ? view.state.sliceDoc(from, to) : null;
  // Perform the default insertion ourselves, then look for a trigger.
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.type",
    scrollIntoView: true,
  });
  tryAutoExpand(view, text, visualText);
  return true;
});

/** Vim-mode typing never reaches the input handler: @replit/codemirror-vim
 *  inserts characters via its own transactions (userEvent "input.type.compose").
 *  Without this listener every automatic snippet is dead while vim is on. */
const autoExpandVimListener = EditorView.updateListener.of((u) => {
  if (!u.docChanged || !canAutoExpand(u.view)) return;
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
    if (inserted !== null || s.length !== 1 || s === "\n") {
      inserted = null;
      return;
    }
    inserted = s;
    insertTo = toB;
    replaceFrom = fromA;
    replaceTo = toA;
  });
  if (inserted === null) return;
  const sel = u.state.selection.main;
  if (!sel.empty || sel.to !== insertTo) return;
  const visualText = replaceTo > replaceFrom ? u.startState.sliceDoc(replaceFrom, replaceTo) : null;
  tryAutoExpand(u.view, inserted, visualText);
});

/** Keeps mirrored tabstops in sync after edits. */
const mirrorSyncListener = EditorView.updateListener.of((u) => {
  if (!u.docChanged || !u.selectionSet) return; // sync only after user edits
  const session = u.state.field(snippetField, false);
  if (!session) return;
  const index = session.order[session.active];
  const ranges = session.stops.get(index);
  if (!ranges || ranges.length < 2) return;

  const doc = u.state.doc;
  const valid = ranges.filter((r) => r.from <= r.to && r.from >= 0 && r.to <= doc.length);
  if (valid.length < 2) return;

  const head = u.state.selection.main.head;
  const source =
    valid.find((r) => head >= r.from && head <= r.to) ?? valid[0];
  const content = doc.sliceString(source.from, source.to);
  if (valid.every((r) => doc.sliceString(r.from, r.to) === content)) return;

  const changes: { from: number; to: number; insert: string }[] = [];
  for (const r of valid) {
    if (r === source) continue;
    changes.push({ from: r.from, to: r.to, insert: content });
  }
  if (changes.length === 0) return;
  u.view.dispatch({
    changes,
    userEvent: "input.snippet-mirror",
  });
});

/** Ends the session when the cursor leaves the snippet region. Runs on
 *  selection changes including doc-edit ones — a document replacement that
 *  leaves the cursor outside the (mapped) region must clear the session,
 *  or it would suppress auto-expansion until the next cursor move. */
const exitListener = EditorView.updateListener.of((u) => {
  if (!u.selectionSet) return;
  const before = u.startState.field(snippetField, false);
  if (!before) return;
  const session = u.state.field(snippetField, false);
  if (!session) return;
  const head = u.state.selection.main.head;
  if (head < session.base || head > session.end) {
    u.view.dispatch({ effects: setSession.of(null) });
  }
});

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

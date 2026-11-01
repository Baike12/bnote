import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { findMatches, type TextMatch } from "./codeSearch";

/**
 * The code box in the settings (formula snippets): line numbers on the left
 * plus a permanent search field.
 *
 * CodeMirror instead of a textarea, because a textarea cannot do the three
 * things we need (highlight every match, colour the current match
 * separately, and keep the line numbers aligned with the wrapped lines); it
 * would take a transparent mirror layer to fake it, and that misaligns as
 * soon as the font metrics drift. None of the note editor's extensions are
 * installed here: no vim, no live preview, no LaTeX snippets, only line
 * numbers, history, search and line wrapping.
 */

interface SearchSpec {
  query: string;
  /** Start of the current match (null = no current match). */
  activeFrom: number | null;
  decos: DecorationSet;
}

const setSearch = StateEffect.define<{ query: string; activeFrom: number | null }>();

const matchMark = Decoration.mark({ class: "cm-searchMatch" });
const activeMatchMark = Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });

/**
 * The single writer of the match decorations: they are rebuilt only when the
 * "query changed" or the "document changed". The document is tiny (one config
 * file in the settings), so scanning it fully is simpler and more accurate
 * than mapping the old decorations and correcting them.
 */
const searchField = StateField.define<SearchSpec>({
  create: () => ({ query: "", activeFrom: null, decos: Decoration.none }),
  update(value, tr) {
    let spec: { query: string; activeFrom: number | null } | null = null;
    for (const e of tr.effects) if (e.is(setSearch)) spec = e.value;
    if (!spec && !tr.docChanged) return value;
    const query = spec ? spec.query : value.query;
    const activeFrom = spec ? spec.activeFrom : null;
    const text = tr.state.doc.toString();
    const decos = Decoration.set(
      findMatches(text, query).map((m) =>
        (m.from === activeFrom ? activeMatchMark : matchMark).range(m.from, m.to),
      ),
    );
    return { query, activeFrom, decos };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

export function CodeArea({
  value,
  onChange,
  searchPlaceholder = "搜索",
  height = 420,
}: {
  value: string;
  onChange: (value: string) => void;
  searchPlaceholder?: string;
  height?: number | string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValue = useRef(value);

  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  const [active, setActive] = useState(-1);
  // The count only serves the display; the real navigation follows the document in the view (see runSearch/step).
  const matches = useMemo(() => findMatches(value, query), [value, query]);

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current as HTMLElement,
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          searchField,
          keymap.of([
            {
              key: "Mod-f",
              run: () => {
                inputRef.current?.focus();
                inputRef.current?.select();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.contentAttributes.of({
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            onChangeRef.current(u.state.doc.toString());
            // Once the document changes the match offsets are no longer
            // trustworthy (the decoration side clears the current match
            // too): the count falls back to "N matches", and the next Enter
            // lands on a match again from the caret.
            if (queryRef.current) setActive(-1);
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // External replacement (async read, restoring the built-in snippets).
  // The editing itself is done by the view, so the whole document is
  // replaced here only when the two really differ, so that every render
  // does not break the undo stack.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  const reveal = (list: TextMatch[], index: number, q: string) => {
    const view = viewRef.current;
    const hit = list[index];
    if (!view || !hit) return;
    setActive(index);
    view.dispatch({
      selection: { anchor: hit.from, head: hit.to },
      effects: [
        setSearch.of({ query: q, activeFrom: hit.from }),
        EditorView.scrollIntoView(hit.from, { y: "nearest" }),
      ],
    });
  };

  const runSearch = (nextQuery: string) => {
    const view = viewRef.current;
    if (!view) return;
    setQuery(nextQuery);
    const list = findMatches(view.state.doc.toString(), nextQuery);
    if (list.length === 0) {
      setActive(-1);
      view.dispatch({ effects: setSearch.of({ query: nextQuery, activeFrom: null }) });
      return;
    }
    reveal(list, 0, nextQuery);
  };

  const step = (dir: 1 | -1) => {
    const view = viewRef.current;
    if (!view || !query) return;
    const list = findMatches(view.state.doc.toString(), query);
    if (list.length === 0) return;
    let next: number;
    if (active >= 0 && active < list.length) {
      next = (active + dir + list.length) % list.length;
    } else {
      // No current match (the document was just changed): continue from the caret in the editor and wrap around when there is none.
      const pos = view.state.selection.main.from;
      if (dir === 1) {
        next = list.findIndex((m) => m.from >= pos);
        if (next < 0) next = 0;
      } else {
        next = list.length - 1;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].to <= pos) {
            next = i;
            break;
          }
        }
      }
    }
    reveal(list, next, query);
  };

  // Count bar: with a current match it reads "which one of how many"; right
  // after the document changed (the current match is invalid) it only reports
  // the total, and the next Enter lands on a match again from the caret.
  const total = matches.length;
  const count = query
    ? total === 0
      ? "无匹配"
      : active >= 0 && active < total
        ? `${active + 1}/${total}`
        : `共 ${total} 处`
    : "";

  return (
    <div className="code-area">
      <div className="code-area-bar">
        <input
          ref={inputRef}
          className="code-area-input"
          type="text"
          spellCheck={false}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => runSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }}
        />
        <span className="code-area-count">{count}</span>
        <button
          className="code-area-nav"
          title="上一处 (Shift+Enter)"
          aria-label="上一处"
          disabled={matches.length === 0}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => step(-1)}
        >
          ↑
        </button>
        <button
          className="code-area-nav"
          title="下一处 (Enter)"
          aria-label="下一处"
          disabled={matches.length === 0}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => step(1)}
        >
          ↓
        </button>
      </div>
      <div className="code-area-host" ref={hostRef} style={{ height }} />
    </div>
  );
}

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
 * 设置里的代码框(公式片段):左侧行号 + 常驻搜索框。
 *
 * 用 CodeMirror 而不是 textarea,是因为「全部命中高亮、当前命中单独着色、
 * 行号与折行后的行对齐」这三件事 textarea 都做不到(只能用透明镜像层硬凑,
 * 字体度量一漂就错位)。这里不装笔记编辑器的任何扩展——没有 vim、没有
 * live preview、没有 LaTeX 片段,只有行号、历史、搜索与折行。
 */

interface SearchSpec {
  query: string;
  /** 当前命中的起点(null = 没有当前命中)。 */
  activeFrom: number | null;
  decos: DecorationSet;
}

const setSearch = StateEffect.define<{ query: string; activeFrom: number | null }>();

const matchMark = Decoration.mark({ class: "cm-searchMatch" });
const activeMatchMark = Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });

/**
 * 命中装饰的唯一写入者:只在「查询变了」或「文档变了」时重建。文档很小
 * (设置里的一个配置文件),全量扫一遍比映射旧装饰后校正更简单也更准。
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
  // 计数只服务显示;真正导航以 view 里的文档为准(见 runSearch/step)。
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
            // 文档一改,命中偏移就不可信了(装饰侧也会清掉当前命中):
            // 计数退回「共 N 处」,下一次 Enter 从光标处重新落位。
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

  // 外部替换(异步读盘、恢复内置片段)。编辑本身由 view 写,这里只在两者
  // 真的不一致时才整篇替换,避免每次渲染都打断撤销栈。
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
      // 没有当前命中(刚改过文档):从编辑器光标处接着找,找不到就环绕。
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

  // 计数条:有当前命中时是「第几处/共几处」;刚改过文档(当前命中已失效)时
  // 只报总数,下一次 Enter 从光标处重新落位。
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

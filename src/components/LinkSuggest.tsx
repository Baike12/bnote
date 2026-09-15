import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildSwitcherResults } from "@/lib/switcher";
import { inputGuards } from "@/lib/inputGuards";
import { editorApi } from "@/editor/api";
import { imeApply, imeSyncToEditor } from "@/editor/imeSwitch";
import { insertPickedLink, restoreEditorFocus } from "@/app/actions";
import { useAppStore, type LinkAnchor } from "@/state/appStore";

/** 视口边缘留白（面板与光标行到边界的距离）。 */
const MARGIN = 8;
/** 面板与光标行之间的间隙。 */
const GAP = 4;

/**
 * 插入链接的补全面板：贴在光标行下方（下方放不下就翻到上方），列出最近打开的
 * 笔记，输入即按快速跳转同一套排序过滤，回车插入 `[[链接]]`。
 *
 * 只在 store 里有锚点时挂载——关闭即卸载，所以查询与选中状态天然随每次打开重置。
 */
export function LinkSuggest() {
  const anchor = useAppStore((s) => s.linkSuggest);
  return anchor ? <LinkSuggestPanel anchor={anchor} /> : null;
}

function LinkSuggestPanel({ anchor }: { anchor: LinkAnchor }) {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const recentFiles = useAppStore((s) => s.recentFiles);
  const currentFile = useAppStore((s) => s.currentFile);
  const modal = useAppStore((s) => s.modal);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + GAP });

  const results = useMemo(
    () => buildSwitcherResults(flatFiles, recentFiles, vaultPath, query, currentFile),
    [flatFiles, recentFiles, vaultPath, query, currentFile],
  );

  // 面板高度只随结果条数变：量一次，下方放不下就整体翻到上方，左右夹进视口。
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const below = anchor.bottom + GAP;
    const top =
      below + h + MARGIN > window.innerHeight
        ? Math.max(MARGIN, anchor.top - h - GAP)
        : below;
    setPos({
      left: Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - w - MARGIN)),
      top,
    });
  }, [anchor, results.length]);

  // 结果比面板高时，键盘选择要跟着滚动——否则选中的行看不见。
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.children[index] as HTMLElement | undefined;
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop - (list.clientHeight - row.clientHeight) / 2;
    list.scrollTop = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight));
  }, [index]);

  // 面板拿走键盘焦点后编辑器收不到按键，IME 跟着切英文（与快速跳转同一套作用域，
  // 卸载时交还编辑器当前该有的输入法）。
  useEffect(() => {
    const { settings } = useAppStore.getState();
    inputRef.current?.focus();
    if (!settings.ime.enabled) return;
    imeApply(settings.ime.normalSource);
    return () => imeSyncToEditor();
  }, []);

  const close = () => useAppStore.getState().closeLinkSuggest();

  // 锚点是打开那一刻量的：编辑器一滚、窗口一变尺寸就失效，先收起来，别挂在错位的地方。
  useEffect(() => {
    const scroller = editorApi.view?.scrollDOM;
    window.addEventListener("resize", close);
    scroller?.addEventListener("scroll", close, { passive: true });
    return () => {
      window.removeEventListener("resize", close);
      scroller?.removeEventListener("scroll", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点到面板外面 = 放弃插入（编辑器那一下点击照常生效）。捕获阶段：让面板先关，
  // 免得编辑器先处理完点击再被面板的关闭逻辑打断。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 别的覆盖层（命令面板 / 设置 / 快速跳转）打开就给它让位。
  useEffect(() => {
    if (modal) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  // 关闭（选中 / Esc / 点外面）后把焦点还给编辑器；用户在别处操作时 restoreEditorFocus
  // 自己会放手。
  useEffect(() => () => restoreEditorFocus(), []);

  const choose = (i: number) => {
    const rel = results[i]?.item;
    if (rel) insertPickedLink(rel);
    else close();
  };

  return (
    <div
      ref={boxRef}
      className="link-suggest"
      style={{ left: pos.left, top: pos.top }}
    >
      <input
        ref={inputRef}
        className="link-suggest-input"
        placeholder="搜索笔记…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(results.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(index);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        {...inputGuards}
      />
      <div className="link-suggest-results" ref={listRef}>
        {results.map(({ item: rel }, i) => (
          <div
            key={rel}
            className={`link-suggest-row${i === index ? " active" : ""}`}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(i);
            }}
          >
            <span className="link-suggest-name">
              {rel.split("/").pop()?.replace(/\.(md|markdown|txt)$/i, "")}
            </span>
            <span className="link-suggest-path">
              {rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""}
            </span>
          </div>
        ))}
        {results.length === 0 && <div className="link-suggest-empty">无匹配笔记</div>}
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildSwitcherResults } from "@/lib/switcher";
import { inputGuards } from "@/lib/inputGuards";
import { editorApi } from "@/editor/api";
import { imeApply, imeSyncToEditor } from "@/editor/imeSwitch";
import { insertPickedLink, restoreEditorFocus } from "@/app/actions";
import { useAppStore, type LinkAnchor } from "@/state/appStore";

/** Margin kept from the viewport edge (distance from the panel and the caret line to the border). */
const MARGIN = 8;
/** Gap between the panel and the caret line. */
const GAP = 4;

/**
 * Completion panel for inserting a link: it sticks under the caret line (and
 * flips above when there is no room below), lists the recently opened notes
 * and filters them with the same ordering as the quick switcher; Enter
 * inserts `[[link]]`.
 *
 * It is mounted only while the store holds an anchor, so closing unmounts it
 * and the query and selection state reset with every open.
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

  // The panel height only depends on the number of results: measure once, flip the whole panel above when it does not fit below, and clamp it into the viewport horizontally.
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

  // When the results are taller than the panel, the keyboard selection has to scroll along, otherwise the selected row is out of sight.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.children[index] as HTMLElement | undefined;
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop - (list.clientHeight - row.clientHeight) / 2;
    list.scrollTop = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight));
  }, [index]);

  // Once the panel takes the keyboard focus the editor receives no keystrokes
  // and the IME switches to English (the same scope as the quick switcher);
  // on unmount the editor gets the input source it should have.
  useEffect(() => {
    const { settings } = useAppStore.getState();
    inputRef.current?.focus();
    if (!settings.ime.enabled) return;
    imeApply(settings.ime.normalSource);
    return () => imeSyncToEditor();
  }, []);

  const close = () => useAppStore.getState().closeLinkSuggest();

  // The anchor is measured when the panel opens: it goes stale as soon as the editor scrolls or the window resizes, so close the panel instead of hanging it in the wrong place.
  useEffect(() => {
    const scroller = editorApi.view?.scrollDOM;
    window.addEventListener("resize", close);
    scroller?.addEventListener("scroll", close, { passive: true });
    return () => {
      window.removeEventListener("resize", close);
      scroller?.removeEventListener("scroll", close);
    };
     
  }, []);

  // A click outside the panel means the insertion is abandoned (the click
  // itself still reaches the editor). Capture phase: let the panel close
  // first, so the editor does not finish handling the click before the
  // panel's close logic interrupts it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
     
  }, []);

  // Another overlay (palette / settings / quick switcher) opening yields to it.
  useEffect(() => {
    if (modal) close();
     
  }, [modal]);

  // After closing (picked / Esc / click outside) the focus goes back to the
  // editor; restoreEditorFocus lets go on its own when the user acted
  // somewhere else.
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

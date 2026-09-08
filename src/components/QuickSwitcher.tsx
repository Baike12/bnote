import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { buildSwitcherResults } from "@/lib/switcher";
import { inputGuards } from "@/lib/inputGuards";
import { useAppStore } from "@/state/appStore";
import { openNote } from "@/app/actions";
import { joinPath } from "@/lib/path";
import { recentCommandChord } from "@/commands/lastChord";
import { imeApply, imeSyncToEditor } from "@/editor/imeSwitch";

/** Active while the switcher is open — the chord-repeat path calls into it. */
let cycleHandler: ((dir: 1 | -1) => boolean) | null = null;

/** Chord repeat (⌘S ⌘S … while the switcher is open) moves the selection. */
export function cycleQuickSwitcher(dir: 1 | -1): boolean {
  return cycleHandler ? cycleHandler(dir) : false;
}

export function QuickSwitcher() {
  const open = useAppStore((s) => s.modal === "switcher");
  const setModal = useAppStore((s) => s.setModal);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const recentFiles = useAppStore((s) => s.recentFiles);
  const currentFile = useAppStore((s) => s.currentFile);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirrors for the keyup/keydown listeners registered once per open.
  const resultsRef = useRef<{ item: string; positions: number[] }[]>([]);
  const indexRef = useRef(index);
  const cycledRef = useRef(false);
  const chordKeyRef = useRef<string | null>(null);

  // IME follow: file search is ASCII typing — switch to the English source
  // while the switcher is open, hand it back on close. Routed through the
  // shared IME scope so leaving bnote mid-search restores the user's source.
  useEffect(() => {
    if (!open) return;
    const { settings } = useAppStore.getState();
    if (!settings.ime.enabled) return;
    imeApply(settings.ime.normalSource);
    return () => imeSyncToEditor();
  }, [open]);

  const results = useMemo(
    () => buildSwitcherResults(flatFiles, recentFiles, vaultPath, query, currentFile),
    [flatFiles, recentFiles, vaultPath, query, currentFile],
  );
  resultsRef.current = results;
  indexRef.current = index;

  const close = () => {
    setModal(null);
    setQuery("");
    setIndex(0);
  };

  const choose = (i: number) => {
    const rel = resultsRef.current[i]?.item;
    if (!rel || !vaultPath) return;
    close();
    void openNote(joinPath(vaultPath, rel));
  };

  // Hold-the-modifier cycling: the opening chord (e.g. ⌘S) repeats move the
  // selection — repeats of a bound chord re-run the command, which calls
  // cycleQuickSwitcher(+1). Shift+chord is not bound to anything, so it lands
  // here and moves the selection back up. Releasing the modifier jumps to the
  // selection, but only after at least one repeat — otherwise the plain open
  // flow (type a query first) would be impossible, since typing needs the
  // modifier gone.
  useEffect(() => {
    if (!open) return;
    chordKeyRef.current = recentCommandChord()?.key ?? null;

    cycleHandler = (dir) => {
      const n = resultsRef.current.length;
      if (n === 0) return false;
      cycledRef.current = true;
      setIndex((i) => (i + dir + n) % n);
      return true;
    };

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const modKey = isMac ? "Meta" : "Control";
    const onKeyDown = (e: KeyboardEvent) => {
      const chord = chordKeyRef.current;
      if (!chord || !e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== chord) return;
      e.preventDefault();
      e.stopPropagation();
      cycleHandler?.(-1);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== modKey && e.key !== "OS") return;
      if (!cycledRef.current) return;
      cycledRef.current = false;
      choose(indexRef.current);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      cycleHandler = null;
      cycledRef.current = false;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal open={open} onClose={close} width={620}>
      <div className="switcher">
        <input
          ref={inputRef}
          autoFocus
          className="switcher-input"
          placeholder="搜索文件或文件夹…"
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
            }
          }}
          {...inputGuards}
        />
        <div className="switcher-results">
          {results.map(({ item: rel }, i) => (
            <div
              key={rel}
              className={`switcher-row${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span className="switcher-name">
                {rel.split("/").pop()?.replace(/\.(md|markdown|txt)$/i, "")}
              </span>
              <span className="switcher-path">
                {rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""}
              </span>
            </div>
          ))}
          {results.length === 0 && <div className="switcher-empty">无匹配文件</div>}
        </div>
      </div>
    </Modal>
  );
}

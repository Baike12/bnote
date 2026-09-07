import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { fuzzySort } from "@/lib/fuzzy";
import { useAppStore } from "@/state/appStore";
import { openNote } from "@/app/actions";
import { joinPath } from "@/lib/path";
import { api } from "@/lib/tauri";

export function QuickSwitcher() {
  const open = useAppStore((s) => s.modal === "switcher");
  const setModal = useAppStore((s) => s.setModal);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const recentFiles = useAppStore((s) => s.recentFiles);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // IME follow: file search is ASCII typing — switch to the English source
  // while the switcher is open, restore whatever was active before it.
  useEffect(() => {
    if (!open) return;
    const { settings } = useAppStore.getState();
    if (!settings.ime.enabled) return;
    let prevSource: string | null = null;
    let closed = false;
    void api
      .getCurrentInputSource()
      .then((id) => {
        if (closed) return api.setInputSource(id).catch(() => {});
        prevSource = id;
        return api.setInputSource(settings.ime.normalSource);
      })
      .catch(() => {});
    return () => {
      closed = true;
      if (prevSource) void api.setInputSource(prevSource).catch(() => {});
    };
  }, [open]);

  const results = useMemo(() => {
    // Recency rank: absolute stored paths → per-vault relative rank. Files
    // never opened rank after everything that was.
    const rank = new Map(recentFiles.map((p, i) => [p, i] as const));
    const rankOf = (rel: string) =>
      (vaultPath ? rank.get(joinPath(vaultPath, rel)) : undefined) ?? Number.POSITIVE_INFINITY;
    const q = query.trim();
    if (!q) {
      // Empty query = jump list: most recently opened first (Obsidian-style).
      return [...flatFiles]
        .sort((a, b) => rankOf(a) - rankOf(b))
        .map((item) => ({ item, positions: [] as number[] }));
    }
    // Haystack is the extension-stripped vault path, so folder names are
    // searchable too (Obsidian-style); space-separated terms AND together.
    return fuzzySort(
      flatFiles,
      (f) => f.replace(/\.(md|markdown|txt)$/i, ""),
      q,
      50,
      (a, b) => rankOf(a) - rankOf(b),
    );
  }, [flatFiles, recentFiles, vaultPath, query]);

  const close = () => {
    setModal(null);
    setQuery("");
    setIndex(0);
  };

  const choose = (i: number) => {
    const rel = results[i]?.item;
    if (!rel || !vaultPath) return;
    close();
    void openNote(joinPath(vaultPath, rel));
  };

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

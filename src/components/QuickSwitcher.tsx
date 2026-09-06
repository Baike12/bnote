import { useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { fuzzySort } from "@/lib/fuzzy";
import { useAppStore } from "@/state/appStore";
import { openNote } from "@/app/actions";
import { joinPath } from "@/lib/path";

export function QuickSwitcher() {
  const open = useAppStore((s) => s.modal === "switcher");
  const setModal = useAppStore((s) => s.setModal);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => fuzzySort(flatFiles, (f) => f, query.trim()),
    [flatFiles, query],
  );

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
          placeholder="输入文件名跳转…"
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

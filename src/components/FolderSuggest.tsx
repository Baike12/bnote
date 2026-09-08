import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/state/appStore";
import { inputGuards } from "@/lib/inputGuards";

interface FolderSuggestProps {
  value: string;
  onChange: (folder: string) => void;
  className?: string;
  placeholder?: string;
}

/**
 * Vault-folder picker for quick-add targets: a text input with a dropdown of
 * every folder that exists in the vault (root included). Typing filters the
 * list; unknown paths stay allowed — quick-add creates missing folders.
 */
export function FolderSuggest({ value, onChange, className, placeholder }: FolderSuggestProps) {
  const flatFiles = useAppStore((s) => s.flatFiles);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const folders = useMemo(() => {
    // Every ancestor directory of an existing note; "" = vault root.
    const set = new Set<string>([""]);
    for (const f of flatFiles) {
      const segs = f.split("/");
      for (let i = 1; i < segs.length; i++) set.add(segs.slice(0, i).join("/"));
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [flatFiles]);

  const q = value.trim().toLowerCase();
  const matches = open
    ? folders.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 30)
    : [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const choose = (folder: string) => {
    onChange(folder);
    setOpen(false);
  };

  return (
    <div className="folder-suggest" ref={wrapRef}>
      <input
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setIndex(0);
        }}
        onFocus={() => {
          setOpen(true);
          setIndex(0);
        }}
        // 点击已持有焦点的输入框时 focus 事件不会再来，单独处理以重新打开下拉。
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(matches.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(matches[Math.min(index, matches.length - 1)]);
          }
        }}
        {...inputGuards}
      />
      {open && matches.length > 0 && (
        <div className="folder-suggest-pop">
          {matches.map((f, i) => (
            <div
              key={f || "/"}
              className={`folder-suggest-item${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(f);
              }}
            >
              <span className="folder-suggest-name">{f === "" ? "仓库根目录" : f.split("/").pop()}</span>
              <span className="folder-suggest-path">{f === "" ? "" : f}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

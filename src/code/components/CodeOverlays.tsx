import { useEffect, useRef, useState } from "react";
import { codeApi } from "../api";
import { useCodeStore } from "../store";
import { onCodeUiRequest, type CodeUiRequest } from "../ui";
import { confirmRename } from "../commands";
import { searchFilesByName } from "../tree";
import type { CodeEntry, CodeSearchHit } from "../types";

/**
 * The overlays of the code panel: quick open, find in files, rename.
 *
 * The overlays are summoned by the command layer (`requestCodeUi`) and are
 * not permanent — they come and go, and the panel only ever keeps the one
 * that is currently needed.
 */
export function CodeOverlays() {
  const [request, setRequest] = useState<CodeUiRequest | null>(null);

  useEffect(() => onCodeUiRequest((r) => setRequest(r)), []);

  if (!request) return null;
  if (request.kind === "quick-open") {
    return <QuickOpen onClose={() => setRequest(null)} />;
  }
  if (request.kind === "find-in-files") {
    return <FindInFiles onClose={() => setRequest(null)} />;
  }
  return <RenamePrompt onClose={() => setRequest(null)} />;
}

/** Quick open: fuzzy-search by file name, Enter opens. */
function QuickOpen({ onClose }: { onClose: () => void }) {
  const root = useCodeStore((s) => s.project?.root ?? "");
  const entries = useCodeStore((s) => s.project?.tree.entries);
  const truncated = useCodeStore((s) => s.project?.tree.truncated ?? false);
  const openFile = useCodeStore((s) => s.openFile);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodeEntry[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setIndex(0);
      return;
    }
    // Opening the project already scanned the whole file tree: filter the
    // local index, so no keystroke has to go through IPC (making Rust walk
    // the repository again per input is too expensive and yields the same
    // result).
    if (!truncated) {
      setResults(searchFilesByName(entries ?? [], query));
      setIndex(0);
      return;
    }
    // The index is truncated (a huge repository): the backend has to scan
    // again, and the result of the last input wins.
    let cancelled = false;
    codeApi
      .searchFiles(root, query)
      .then((hits) => {
        if (cancelled) return;
        setResults(hits);
        setIndex(0);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [entries, query, root, truncated]);

  const pick = (path: string) => {
    // Picking from the overlay is an explicit open: the caret belongs in the
    // file, not in the (about to disappear) input.
    void openFile(path, { focus: true });
    onClose();
  };

  return (
    <div className="code-overlay" onMouseDown={onClose}>
      <div className="code-overlay-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="code-overlay-input"
          placeholder="按文件名打开…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, results.length - 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const hit = results[index];
              if (hit) pick(hit.path);
            }
          }}
        />
        <div className="code-overlay-list">
          {results.map((hit, i) => (
            <button
              type="button"
              key={hit.path}
              className={`code-overlay-row${i === index ? " is-active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(hit.path)}
            >
              {hit.path}
            </button>
          ))}
          {query.trim() && results.length === 0 && (
            <div className="code-overlay-empty">没有匹配的文件</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Find in files: search the file contents, click a result to jump to that line. */
function FindInFiles({ onClose }: { onClose: () => void }) {
  const root = useCodeStore((s) => s.project?.root ?? "");
  const navigateTo = useCodeStore((s) => s.navigateTo);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CodeSearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      codeApi
        .search(root, query, 200)
        .then((found) => {
          if (!cancelled) setHits(found);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [root, query]);

  return (
    <div className="code-overlay" onMouseDown={onClose}>
      <div className="code-overlay-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="code-overlay-input"
          placeholder="在项目中查找…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="code-overlay-list">
          {hits.map((hit, i) => (
            <button
              type="button"
              key={`${hit.path}:${hit.line}:${i}`}
              className="code-overlay-row is-hit"
              onClick={() => {
                void navigateTo(hit.path, { line: hit.line, character: 0 });
                onClose();
              }}
            >
              <span className="code-overlay-hit-path">
                {hit.path}:{hit.line + 1}
              </span>
              <span className="code-overlay-hit-text">{hit.text.trim()}</span>
            </button>
          ))}
          {query.trim() && hits.length === 0 && (
            <div className="code-overlay-empty">没有匹配的内容</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rename: ask for a new name and hand it to the language server, which knows what has to change. */
function RenamePrompt({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const ok = await confirmRename(trimmed);
    setBusy(false);
    if (ok) {
      onClose();
      return;
    }
    // A failed rename used to say nothing: the box stayed open and the user
    // would only think the button did not register.
    setError("这个位置不能重命名(或语言服务器没在运行)");
  };

  return (
    <div className="code-overlay" onMouseDown={onClose}>
      <div className="code-overlay-box is-narrow" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="code-overlay-input"
          placeholder="新的名字…"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="code-overlay-actions">
          <span className="code-overlay-hint">
            {busy ? "重命名中…" : (error ?? "回车确认,Esc 取消")}
          </span>
          <button type="button" className="code-overlay-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="code-overlay-btn is-primary"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            重命名
          </button>
        </div>
      </div>
    </div>
  );
}

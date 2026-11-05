import { useEffect, useMemo, useState } from "react";
import { codeApi } from "../api";
import { alignHunk, diffStats, parseUnifiedDiff } from "../diff";
import { useCodeStore } from "../store";

/**
 * Git diff view.
 *
 * The backend hands over the raw unified diff text (`git diff --no-color`) and
 * the parsing happens on the frontend (`src/code/diff.ts`): line numbers,
 * colouring and side-by-side alignment are all frontend concerns.
 *
 * Two views: unified and side by side. The side-by-side view pairs the
 * changed lines with a longest common subsequence, so two lines that changed
 * the same word end up next to each other instead of drifting apart.
 */
export function DiffView({ path }: { path: string }) {
  const root = useCodeStore((s) => s.project?.root ?? "");
  const staged = useCodeStore((s) => s.diffStaged);
  const toggleStaged = useCodeStore((s) => s.toggleDiffStaged);
  const setDiff = useCodeStore((s) => s.setDiff);

  const [text, setText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    codeApi
      .gitDiff(root, path, staged)
      .then((d) => {
        if (!cancelled) setText(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [root, path, staged]);

  const parsed = useMemo(() => parseUnifiedDiff(text), [text]);
  const stats = useMemo(() => diffStats(parsed), [parsed]);

  return (
    <div className="code-diff">
      <div className="code-diff-head">
        <span className="code-diff-path" title={path}>
          {path}
        </span>
        <span className="code-diff-stats">
          <span className="is-add">+{stats.added}</span>
          <span className="is-del">-{stats.removed}</span>
        </span>
        <button
          type="button"
          className="code-diff-btn"
          onClick={toggleStaged}
          title="切换工作区 / 暂存区视角"
        >
          {staged ? "暂存区" : "工作区"}
        </button>
        <button
          type="button"
          className="code-diff-btn"
          onClick={() => setSideBySide((v) => !v)}
          title="切换并排 / 统一视图"
        >
          {sideBySide ? "并排" : "统一"}
        </button>
        <button
          type="button"
          className="code-diff-btn"
          onClick={() => setDiff(null)}
          title="关闭差异视图"
        >
          关闭
        </button>
      </div>
      <div className="code-diff-body">
        {error && <div className="code-diff-error">{error}</div>}
        {!error && stats.added === 0 && stats.removed === 0 && (
          <div className="code-diff-empty">这个文件没有差异</div>
        )}
        {parsed.files.map((file, fi) =>
          file.hunks.map((hunk, hi) =>
            sideBySide ? (
              <SideBySideHunk key={`${fi}-${hi}`} hunk={hunk} />
            ) : (
              <UnifiedHunk key={`${fi}-${hi}`} hunk={hunk} />
            ),
          ),
        )}
      </div>
    </div>
  );
}

function UnifiedHunk({
  hunk,
}: {
  hunk: ReturnType<typeof parseUnifiedDiff>["files"][number]["hunks"][number];
}) {
  return (
    <div className="code-hunk">
      <div className="code-hunk-head">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.section}
      </div>
      {hunk.lines.map((line, i) => (
        <div key={i} className={`code-diff-line is-${line.type}`}>
          <span className="code-diff-num">{line.oldLine ?? ""}</span>
          <span className="code-diff-num">{line.newLine ?? ""}</span>
          <span className="code-diff-sign">
            {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
          </span>
          <span className="code-diff-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function SideBySideHunk({
  hunk,
}: {
  hunk: ReturnType<typeof parseUnifiedDiff>["files"][number]["hunks"][number];
}) {
  const rows = useMemo(() => alignHunk(hunk), [hunk]);
  return (
    <div className="code-hunk is-side">
      <div className="code-hunk-head">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.section}
      </div>
      {rows.map((row, i) => (
        <div key={i} className="code-diff-row">
          <div className={`code-diff-cell${row.left ? ` is-${row.left.type}` : " is-empty"}`}>
            <span className="code-diff-num">{row.left?.oldLine ?? ""}</span>
            <span className="code-diff-text">{row.left?.text ?? ""}</span>
          </div>
          <div className={`code-diff-cell${row.right ? ` is-${row.right.type}` : " is-empty"}`}>
            <span className="code-diff-num">{row.right?.newLine ?? ""}</span>
            <span className="code-diff-text">{row.right?.text ?? ""}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { codeApi } from "../api";
import { alignHunk, diffStats, parseUnifiedDiff } from "../diff";
import { useCodeStore } from "../store";

/**
 * git 差异视图。
 *
 * 后端给的是原始的 unified diff 文本(`git diff --no-color`),解析在
 * 前端(`src/code/diff.ts`):渲染要按行号、配色、并排对齐,这些都在前端做。
 *
 * 两种看法:统一(unified)与并排(side by side)。并排靠最长公共子序列把
 * 改动过的行配对——改了同一个词的两行会并排显示,而不是各自飘着。
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

function UnifiedHunk({ hunk }: { hunk: ReturnType<typeof parseUnifiedDiff>["files"][number]["hunks"][number] }) {
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

function SideBySideHunk({ hunk }: { hunk: ReturnType<typeof parseUnifiedDiff>["files"][number]["hunks"][number] }) {
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

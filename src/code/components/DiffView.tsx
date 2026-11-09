import { useEffect, useMemo, useState } from "react";
import { codeApi } from "../api";
import {
  changeDir,
  changeName,
  changeTotals,
  changesForSource,
  patchKey,
  type FileChange,
} from "../changes";
import { alignHunk, diffStats, parseUnifiedDiff, type DiffHunk, type ParsedDiff } from "../diff";
import { useCodeStore } from "../store";

/**
 * The diff pane: the changed files of the project, each expandable into its
 * own patch (the shape the ZCode git pane uses).
 *
 * The backend hands over raw unified diff text per file (`git diff
 * --no-color`); parsing, colours and the side-by-side alignment are frontend
 * concerns (`src/code/diff.ts`). The list comes from the git status every save
 * refreshes, so the counts on the rows are the counts of the tree on screen.
 *
 * Loading is lazy: only the open row is read (a large repository must not read
 * every patch just to open the pane), and `gitRev` is one of the request's
 * inputs, so a save, a stage or a refresh re-reads it — the patch on screen is
 * never the one from before the edit.
 */
export function DiffView() {
  const root = useCodeStore((s) => s.project?.root ?? "");
  const git = useCodeStore((s) => s.git);
  const gitRev = useCodeStore((s) => s.gitRev);
  const staged = useCodeStore((s) => s.diffStaged);
  const toggleStaged = useCodeStore((s) => s.toggleDiffStaged);
  const setDiff = useCodeStore((s) => s.setDiff);
  const refreshGit = useCodeStore((s) => s.refreshGit);

  const changes = useMemo(
    () => changesForSource(git, staged ? "staged" : "worktree"),
    [git, staged],
  );
  const totals = useMemo(() => changeTotals(changes), [changes]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(false);
  const [patch, setPatch] = useState<PatchState | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // One row is open at a time; the key says which side of which file it shows.
  // A patch loaded for another key (or for the other side) is not displayed.
  const key = expanded ? patchKey(expanded, staged) : "";

  // The file may be gone from the list (reverted, committed): close the row.
  useEffect(() => {
    if (expanded && !changes.some((c) => c.path === expanded)) setExpanded(null);
  }, [changes, expanded]);

  // Read the patch of the open row. Every input here is read-only (which file,
  // which side, which revision); the state this effect writes is deliberately
  // not a dependency. Keying the request on its own write meant each progress
  // update cancelled the request it had just started, and the row stayed on
  // “读取改动…” forever (observed).
  useEffect(() => {
    if (!expanded || !root) return;
    const requestKey = patchKey(expanded, staged);
    let cancelled = false;
    // Keep the text already on screen while the new revision loads.
    setPatch((prev) =>
      prev?.key === requestKey
        ? { ...prev, loading: true, error: null }
        : { key: requestKey, loading: true, text: null, error: null },
    );
    codeApi.gitDiff(root, expanded, staged).then(
      (text) => {
        if (!cancelled) setPatch({ key: requestKey, loading: false, text, error: null });
      },
      (e: unknown) => {
        if (!cancelled) setPatch({ key: requestKey, loading: false, text: null, error: String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [expanded, root, staged, gitRev]);

  const shown = patch?.key === key ? patch : null;

  return (
    <div className="code-diff">
      <div className="code-diff-head">
        <span className="code-diff-title">改动</span>
        <span className="code-diff-stats">
          <span className="is-add">+{totals.added}</span>
          <span className="is-del">-{totals.removed}</span>
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
        <span className="spacer" />
        <button
          type="button"
          className="code-diff-icon"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void refreshGit().finally(() => setRefreshing(false));
          }}
          title="重新读取 git 状态与改动"
          aria-label="刷新"
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="code-diff-icon"
          onClick={() => setDiff(false)}
          title="关闭改动列表,回到文件"
          aria-label="关闭"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="code-diff-body">
        {!git?.isRepo && <div className="code-diff-empty">这个项目不是 git 仓库</div>}
        {git?.isRepo && changes.length === 0 && (
          <div className="code-diff-empty">{staged ? "暂存区没有改动" : "工作区没有改动"}</div>
        )}
        {changes.map((change) => (
          <ChangeRow
            key={change.path}
            change={change}
            open={expanded === change.path}
            patch={shown}
            sideBySide={sideBySide}
            onToggle={() =>
              setExpanded((current) => (current === change.path ? null : change.path))
            }
          />
        ))}
      </div>
    </div>
  );
}

interface PatchState {
  /** `patchKey` of the row this text belongs to. */
  key: string;
  loading: boolean;
  text: string | null;
  error: string | null;
}

/** One changed file: a header row (name, path, counts) and its patch when open. */
function ChangeRow({
  change,
  open,
  patch,
  sideBySide,
  onToggle,
}: {
  change: FileChange;
  open: boolean;
  patch: PatchState | null;
  sideBySide: boolean;
  onToggle: () => void;
}) {
  const parsed = useMemo<ParsedDiff | null>(
    () => (patch?.text != null ? parseUnifiedDiff(patch.text) : null),
    [patch?.text],
  );
  const stats = useMemo(() => (parsed ? diffStats(parsed) : null), [parsed]);
  const hunks = useMemo(() => parsed?.files.flatMap((file) => file.hunks) ?? [], [parsed]);
  const dir = changeDir(change.path);

  return (
    <div className={`code-change${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="code-change-head"
        aria-expanded={open}
        title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
        onClick={onToggle}
      >
        <span className={`code-change-kind is-${change.kind}`} aria-hidden="true" />
        <span className="code-change-name">{changeName(change.path)}</span>
        {change.origPath && (
          <span className="code-change-was">← {changeName(change.origPath)}</span>
        )}
        {dir && <span className="code-change-dir">{dir}</span>}
        <span className="spacer" />
        <span className="code-diff-stats">
          <span className="is-add">+{change.added}</span>
          <span className="is-del">-{change.removed}</span>
        </span>
        <span className={`code-change-chevron${open ? " is-open" : ""}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="code-change-body">
          {patch?.loading && <div className="code-diff-empty">读取改动…</div>}
          {patch?.error && <div className="code-diff-error">{patch.error}</div>}
          {parsed && hunks.length === 0 && stats && (
            <div className="code-diff-empty">
              {stats.added === 0 && stats.removed === 0
                ? "这个文件没有文本差异"
                : "差异只能在这里看(二进制或过大)"}
            </div>
          )}
          {hunks.map((hunk, index) =>
            sideBySide ? (
              <SideBySideHunk key={index} hunk={hunk} />
            ) : (
              <UnifiedHunk key={index} hunk={hunk} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function UnifiedHunk({ hunk }: { hunk: DiffHunk }) {
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

function SideBySideHunk({ hunk }: { hunk: DiffHunk }) {
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

/** Refresh: a circular arrow, the action ZCode's git pane puts at the right. */
function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 8a5 5 0 1 1-1.7-3.8" />
      <path d="M13 2.6V6h-3.4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

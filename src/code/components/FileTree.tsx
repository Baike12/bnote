import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { buildTree, pruneToChanges, visibleRows, type TreeNode } from "../tree";
import { changesForSource } from "../changes";
import { treeKeyAction } from "../treeKeys";
import { useCodeStore } from "../store";
import { activeCodeEditor } from "../editor/registry";
import { FileTypeIcon, FolderTypeIcon } from "./FileIcon";

/** git status → the letter to display. */
const STATUS_LABEL: Record<string, string> = {
  M: "M",
  A: "A",
  D: "D",
  R: "R",
  C: "C",
  U: "U",
  "?": "?",
};

/**
 * The row height in px. The virtual scroll window is computed from it — it
 * **must match the CSS of `.code-tree-row`**, a difference of 1px makes the
 * scroll drift more and more.
 */
const ROW_HEIGHT = 22;
/** How many extra rows to render above and below the viewport, so a fast scroll never shows blanks. */
const OVERSCAN = 12;
/** The padding above and below the list in px, matching the top of `.code-tree-window`. */
const PAD = 4;

/**
 * The file tree.
 *
 * **Virtual scrolling**: the file tree is the only list that grows with the
 * size of the repository (tens of thousands of rows in a big one), rendering
 * all of it as DOM costs hundreds of milliseconds to seconds and keeps tens
 * of thousands of buttons alive. Here the tree is flattened into
 * `visibleRows` and only the few dozen rows near the viewport are rendered —
 * scrolling swaps rows, not the node structure.
 *
 * **Keyboard reachable**: ⌘⇧E (the command `code.focus-tree`) hands the
 * focus to the whole tree; with an open file it expands to it and stops on
 * that row; afterwards ↑↓ (or `j` / `k`) walk the rows, →← expand / collapse,
 * Enter opens the row and hands the keyboard to that file's editor, Esc gives
 * the focus back to the editor as well. The key table lives in
 * `../treeKeys.ts`.
 *
 * The focus sits on the **container** and not on a row button: the virtual
 * scroll unmounts row elements while scrolling, so a focus on a row would be
 * lost as soon as the user scrolls that row out of the window; the container
 * takes no part in the window computation and is always there. A row only
 * draws an `is-focus` ring to show where the keyboard is (a different thing
 * from `.is-active`, "which file is open in the editor").
 *
 * Wrapped in `memo`: the code editor re-renders the panel on every keystroke
 * (the content lives in the store), and the file tree must not repaint with
 * it — it only depends on the file list and the git status, and those two
 * references do not change while typing.
 */
export const FileTree = memo(function FileTree({
  activePath,
  onOpen,
}: {
  activePath: string | null;
  /**
   * Opens a file. `focus` separates the two gestures: moving through the tree
   * previews the file (the keys stay in the tree, so `j` / `k` keep working),
   * while Enter / double-click is an explicit "open" and hands the keyboard to
   * the editor.
   */
  onOpen: (path: string, focus?: boolean) => void;
}) {
  const entries = useCodeStore((s) => s.project?.tree.entries ?? []);
  const git = useCodeStore((s) => s.git);
  const truncated = useCodeStore((s) => s.project?.tree.truncated ?? false);
  // The expanded state lives in the store: an empty set by default (top level
  // only, no folder is expanded by default); it survives closing and
  // reopening the drawer and a rescan, and openProject clears it when the
  // project changes.
  const expandedDirs = useCodeStore((s) => s.expandedDirs);
  const toggleDir = useCodeStore((s) => s.toggleDir);
  // While the diff pane is open the tree lists only the changed files (the
  // same column shows the change list in VS Code), following the side the pane
  // shows.
  const diffOpen = useCodeStore((s) => s.diffOpen);
  const diffStaged = useCodeStore((s) => s.diffStaged);
  const diffFile = useCodeStore((s) => s.diffFile);
  const setDiffFile = useCodeStore((s) => s.setDiffFile);
  const focusRequest = useCodeStore((s) => s.treeFocus);
  const clearTreeFocus = useCodeStore((s) => s.clearTreeFocus);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  /** The row the keyboard is on (a different thing from "which file is open in the editor"). */
  const [focusPath, setFocusPath] = useState<string | null>(null);
  /** Increments on every "reveal" request: pressing the shortcut on the same row has to scroll it into view again. */
  const [revealTick, setRevealTick] = useState(0);

  // The viewport height changes with the middle column drag / the window
  // resize: without measuring it only a dozen rows could be rendered (an
  // almost empty list).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setViewportHeight(host.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const gitMap = useMemo(() => {
    const map = new Map<string, NonNullable<typeof git>["files"][number]>();
    for (const file of git?.files ?? []) map.set(file.path, file);
    return map;
  }, [git]);

  const fullRoots = useMemo(() => buildTree(entries, gitMap), [entries, gitMap]);

  const changed = useMemo(
    () =>
      new Set(
        changesForSource(git, diffStaged ? "staged" : "worktree").map((change) => change.path),
      ),
    [git, diffStaged],
  );
  /** The change view: the full tree pruned to the changed files and their directories. */
  const roots = useMemo(
    () => (diffOpen ? pruneToChanges(fullRoots, changed) : fullRoots),
    [diffOpen, fullRoots, changed],
  );

  // The change view opens every directory that holds a change: the list is
  // short by construction, and folding it by default would hide most of it
  // behind clicks. Folding a directory there works too, so the view keeps its
  // own collapsed set — the full tree's expanded state is untouched by it.
  const [foldedChanges, setFoldedChanges] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!diffOpen) setFoldedChanges(new Set());
  }, [diffOpen]);
  const expanded = useMemo(() => {
    if (!diffOpen) return expandedDirs;
    const set = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (!node.isDir) continue;
        if (!foldedChanges.has(node.path)) set.add(node.path);
        walk(node.children);
      }
    };
    walk(roots);
    return set;
  }, [diffOpen, expandedDirs, foldedChanges, roots]);
  const toggleExpanded = useCallback(
    (path: string) => {
      if (!diffOpen) {
        toggleDir(path);
        return;
      }
      setFoldedChanges((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [diffOpen, toggleDir],
  );
  const rows = useMemo(() => visibleRows(roots, expanded), [roots, expanded]);
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.node.path, index));
    return map;
  }, [rows]);

  // The viewport window. The browser clamps the scroll position back into
  // the content height, but that clamping is asynchronous (next frame), so
  // right after a collapse the scrollTop may already be out of range — clamp
  // it once more here.
  const first =
    rows.length === 0
      ? 0
      : Math.min(
          rows.length - 1,
          Math.max(0, Math.floor((scrollTop - PAD) / ROW_HEIGHT) - OVERSCAN),
        );
  const last =
    rows.length === 0
      ? 0
      : Math.min(
          rows.length,
          Math.max(0, Math.ceil((scrollTop - PAD + viewportHeight) / ROW_HEIGHT) + OVERSCAN),
        );

  /** Move the keyboard focus to a row and make sure it is scrolled into the viewport. */
  const revealTo = useCallback((path: string) => {
    setFocusPath(path);
    setRevealTick((tick) => tick + 1);
  }, []);

  // Consume one "focus the file tree" request. The target row has to be part
  // of the visible rows: the caller (code.focus-tree) has already expanded the
  // ancestor directories, and here the actual row array is the fallback (a
  // path that is not on the tree lands on the first row instead of leaving
  // the focus in the void).
  useEffect(() => {
    if (!focusRequest) return;
    clearTreeFocus();
    const wanted = focusRequest.path;
    const target = wanted && rowIndex.has(wanted) ? wanted : (rows[0]?.node.path ?? null);
    if (!target) return;
    // The focus belongs to the container (rows are unmounted while scrolling,
    // the container is not); the coordinates are computed by the reveal effect
    // itself, and preventScroll keeps the browser from scrolling a second
    // time and skewing the result.
    hostRef.current?.focus({ preventScroll: true });
    revealTo(target);
  }, [focusRequest, clearTreeFocus, rowIndex, rows, revealTo]);

  // Scroll focusPath into the viewport. Only the DOM is scrolled, the focus
  // is not moved (it stays on the container), so there is no need to wait for
  // the window to render the element — and therefore no "scroll once, focus
  // once" two-pass timing.
  useEffect(() => {
    if (!focusPath) return;
    const host = hostRef.current;
    if (!host) return;
    const index = rowIndex.get(focusPath);
    if (index === undefined) return;
    const top = PAD + index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < host.scrollTop || bottom > host.scrollTop + host.clientHeight) {
      host.scrollTop = Math.max(0, Math.round(top - (host.clientHeight - ROW_HEIGHT) / 2));
      setScrollTop(host.scrollTop);
    }
  }, [focusPath, revealTick, rowIndex]);

  if (roots.length === 0) {
    return (
      <div className="code-tree-empty">
        {!diffOpen
          ? "这个项目里没有文件"
          : !git
            ? "读取改动…"
            : git.isRepo
              ? "没有改动"
              : "这个项目不是 git 仓库"}
      </div>
    );
  }

  // The row drawn as selected: the open patch in the change view, otherwise
  // the file open in the editor. Collapsing removes the row focusPath points
  // at, so the fallbacks keep the keyboard off a path that is no longer
  // visible.
  const selected = diffOpen ? diffFile : activePath;
  const currentPath =
    (focusPath && rowIndex.has(focusPath) ? focusPath : null) ??
    (selected && rowIndex.has(selected) ? selected : null) ??
    rows[0]?.node.path ??
    null;

  /**
   * A file row: in the change view it opens exactly that file's patch in the
   * diff pane (the file itself does not have to be the one in the editor), out
   * of it the row opens the file.
   */
  const activateFile = (path: string, focus?: boolean) => {
    if (diffOpen) setDiffFile(path);
    else onOpen(path, focus);
  };

  /** Move the focus between neighbouring rows (out of range stays where it is). */
  const moveFocus = (delta: number) => {
    if (rows.length === 0 || !currentPath) return;
    const index = rowIndex.get(currentPath) ?? -1;
    const next = Math.min(rows.length - 1, Math.max(0, index + delta));
    const row = rows[next];
    if (row) revealTo(row.node.path);
  };

  /**
   * The keybindings of the tree. The focus is on the container, so the keys
   * bubble from the container up to here (before the window level command
   * dispatch sees them); a handled key calls preventDefault and no longer
   * triggers the native behavior of the button.
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0 || !currentPath) return;
    const index = rowIndex.get(currentPath);
    if (index === undefined) return;
    const row = rows[index];
    const action = treeKeyAction(event);
    if (!action) return;

    switch (action) {
      case "down":
        moveFocus(1);
        break;
      case "up":
        moveFocus(-1);
        break;
      case "first":
        revealTo(rows[0].node.path);
        break;
      case "last":
        revealTo(rows[rows.length - 1].node.path);
        break;
      case "right":
        // Expand when collapsed; when already expanded, move into the first
        // child (the same as a file manager).
        if (row.node.isDir && !expanded.has(row.node.path)) toggleExpanded(row.node.path);
        else moveFocus(1);
        break;
      case "left":
        if (row.node.isDir && expanded.has(row.node.path)) toggleExpanded(row.node.path);
        else {
          const slash = row.node.path.lastIndexOf("/");
          if (slash > 0) revealTo(row.node.path.slice(0, slash));
        }
        break;
      case "activate":
        if (row.node.isDir) toggleExpanded(row.node.path);
        else activateFile(row.node.path, true);
        break;
      case "release":
        // Give the keyboard back to the code: after browsing through files
        // the user should not have to click the editor again. Without an
        // editor (image / binary / diff view) it just releases the focus.
        {
          const handle = activeCodeEditor();
          if (handle) handle.view.focus();
          else hostRef.current?.blur();
        }
        break;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className="code-tree"
      ref={hostRef}
      tabIndex={-1}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={handleKeyDown}
    >
      <div className="code-tree-spacer" style={{ height: PAD * 2 + rows.length * ROW_HEIGHT }}>
        <div
          className="code-tree-window"
          style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}
        >
          {rows.slice(first, last).map((row) => (
            <TreeRow
              key={row.node.path}
              node={row.node}
              depth={row.depth}
              expanded={expanded}
              activePath={selected}
              focusPath={focusPath}
              onToggle={toggleExpanded}
              onOpen={activateFile}
              onFocusRow={setFocusPath}
            />
          ))}
        </div>
      </div>
      {truncated && !diffOpen && <div className="code-tree-note">文件太多,列表已截断</div>}
    </div>
  );
});

function TreeRow({
  node,
  depth,
  expanded,
  activePath,
  focusPath,
  onToggle,
  onOpen,
  onFocusRow,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  focusPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string, focus?: boolean) => void;
  onFocusRow: (path: string) => void;
}) {
  const pad = { paddingLeft: `${6 + depth * 12}px` };
  const focused = focusPath === node.path;

  if (node.isDir) {
    return (
      <button
        type="button"
        className={`code-tree-row code-tree-dir${focused ? " is-focus" : ""}`}
        style={pad}
        data-path={node.path}
        onClick={() => onToggle(node.path)}
        onFocus={() => onFocusRow(node.path)}
        title={node.path}
      >
        <FolderTypeIcon open={expanded.has(node.path)} />
        <span className="code-tree-name">{node.name}</span>
      </button>
    );
  }

  const status = node.git ? STATUS_LABEL[node.git.worktree || node.git.index] : undefined;
  const staged = node.git ? node.git.index && node.git.index !== " " : false;

  return (
    <button
      type="button"
      className={`code-tree-row code-tree-file${
        activePath === node.path ? " is-active" : ""
      }${focused ? " is-focus" : ""}`}
      style={pad}
      data-path={node.path}
      onClick={() => onOpen(node.path)}
      onDoubleClick={() => onOpen(node.path, true)}
      onFocus={() => onFocusRow(node.path)}
      title={node.path}
    >
      <FileTypeIcon name={node.name} />
      <span className="code-tree-name">{node.name}</span>
      {status && (
        <span
          className={`code-tree-status${staged ? " is-staged" : ""}`}
          title={staged ? "已暂存" : "工作区有改动"}
        >
          {status}
        </span>
      )}
    </button>
  );
}

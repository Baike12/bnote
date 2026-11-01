import { memo, useEffect, useMemo, useRef, useState } from "react";
import { buildTree, visibleRows, type TreeNode } from "../tree";
import { useCodeStore } from "../store";
import { FileTypeIcon, FolderTypeIcon } from "./FileIcon";

/** git 状态 → 展示用的字母。 */
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
 * 行高(px)。虚拟滚动的窗口按它算——**必须与 CSS 的 `.code-tree-row` 一致**,
 * 差 1px 就会越滚越偏。
 */
const ROW_HEIGHT = 22;
/** 视口上下各多渲染几行:快速滚动时不会看到空白。 */
const OVERSCAN = 12;
/** 列表上下留白(px),与 `.code-tree-window` 的 top 对应。 */
const PAD = 4;

/**
 * 文件树。
 *
 * **虚拟滚动**:文件树是唯一随仓库规模膨胀的列表(大仓库上万行),全量渲染
 * 成 DOM 是几百毫秒到几秒的开销,还会一直养着上万个按钮。这里把树拍平成
 * `visibleRows`,只渲染视口附近那几十行——滚动时换行不换节点结构。
 *
 * 用 `memo` 包起来:代码编辑器每敲一个字,面板都会重渲染一次(内容在 store
 * 里),文件树不该跟着重画——它只依赖文件列表与 git 状态,那两份引用在打字
 * 时是不变的。
 */
export const FileTree = memo(function FileTree({
  activePath,
  onOpen,
}: {
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const entries = useCodeStore((s) => s.project?.tree.entries ?? []);
  const git = useCodeStore((s) => s.git);
  const truncated = useCodeStore((s) => s.project?.tree.truncated ?? false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // 视口高度随中栏拖动/窗口缩放变化:量不到高度就只能渲染十几行(空列表)。
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

  const roots = useMemo(() => buildTree(entries, gitMap), [entries, gitMap]);
  const rows = useMemo(() => visibleRows(roots, collapsed), [roots, collapsed]);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (roots.length === 0) {
    return <div className="code-tree-empty">这个项目里没有文件</div>;
  }

  // 视口窗口。滚动位置会被浏览器夹回内容高度内,但夹回是异步的(下一帧),
  // 折叠后同一帧里 scrollTop 可能已经越界——这里自己再夹一次。
  const first = Math.min(
    Math.max(0, rows.length - 1),
    Math.max(0, Math.floor((scrollTop - PAD) / ROW_HEIGHT) - OVERSCAN),
  );
  const last = Math.min(
    rows.length,
    Math.max(0, Math.ceil((scrollTop - PAD + viewportHeight) / ROW_HEIGHT) + OVERSCAN),
  );

  return (
    <div
      className="code-tree"
      ref={hostRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
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
              collapsed={collapsed}
              activePath={activePath}
              onToggle={toggle}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
      {truncated && <div className="code-tree-note">文件太多,列表已截断</div>}
    </div>
  );
});

function TreeRow({
  node,
  depth,
  collapsed,
  activePath,
  onToggle,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const pad = { paddingLeft: `${6 + depth * 12}px` };

  if (node.isDir) {
    return (
      <button
        type="button"
        className="code-tree-row code-tree-dir"
        style={pad}
        onClick={() => onToggle(node.path)}
        title={node.path}
      >
        <span className="code-tree-caret">{collapsed.has(node.path) ? "▸" : "▾"}</span>
        <FolderTypeIcon open={!collapsed.has(node.path)} />
        <span className="code-tree-name">{node.name}</span>
      </button>
    );
  }

  const status = node.git ? STATUS_LABEL[node.git.worktree || node.git.index] : undefined;
  const staged = node.git ? node.git.index && node.git.index !== " " : false;

  return (
    <button
      type="button"
      className={`code-tree-row code-tree-file${activePath === node.path ? " is-active" : ""}`}
      style={pad}
      onClick={() => onOpen(node.path)}
      title={node.path}
    >
      {/* 文件没有折叠箭头,但占住同样的宽度:同一层的目录与文件图标对齐。 */}
      <span className="code-tree-caret" />
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

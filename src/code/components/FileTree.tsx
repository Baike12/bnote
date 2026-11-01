import { memo, useMemo, useState } from "react";
import { buildTree, type TreeNode } from "../tree";
import { useCodeStore } from "../store";

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
 * 文件树。
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

  const gitMap = useMemo(() => {
    const map = new Map<string, NonNullable<typeof git>["files"][number]>();
    for (const file of git?.files ?? []) map.set(file.path, file);
    return map;
  }, [git]);

  const roots = useMemo(() => buildTree(entries, gitMap), [entries, gitMap]);

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

  return (
    <div className="code-tree">
      {roots.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          collapsed={collapsed}
          activePath={activePath}
          onToggle={toggle}
          onOpen={onOpen}
        />
      ))}
      {truncated && (
        <div className="code-tree-note">文件太多,列表已截断</div>
      )}
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
  const isCollapsed = collapsed.has(node.path);
  const pad = { paddingLeft: `${6 + depth * 12}px` };

  if (node.isDir) {
    return (
      <>
        <button
          type="button"
          className="code-tree-row code-tree-dir"
          style={pad}
          onClick={() => onToggle(node.path)}
          title={node.path}
        >
          <span className="code-tree-caret">{isCollapsed ? "▸" : "▾"}</span>
          <span className="code-tree-name">{node.name}</span>
        </button>
        {!isCollapsed &&
          node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              activePath={activePath}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
      </>
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

import { useEffect, useRef, useState } from "react";
import {
  loadDirChildren,
  newFolder,
  newNote,
  openNote,
  refreshTree,
  renameEntry,
  trashEntry,
} from "@/app/actions";
import { editorApi } from "@/editor/api";
import { ancestorDirs } from "@/lib/path";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import type { FileNode } from "@/lib/tauri";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { IconNewFolder, IconNewNote } from "./icons";

/** Visible rows in display order (expanded folders traversed depth-first). */
function flattenVisible(tree: FileNode[], expanded: Set<string>): FileNode[] {
  const out: FileNode[] = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.kind === "dir" && expanded.has(n.relPath) && n.children) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

function findNode(tree: FileNode[], relPath: string): FileNode | null {
  for (const n of tree) {
    if (n.relPath === relPath) return n;
    if (n.kind === "dir" && n.children) {
      const hit = findNode(n.children, relPath);
      if (hit) return hit;
    }
  }
  return null;
}

export function Sidebar() {
  const tree = useAppStore((s) => s.tree);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const currentFile = useAppStore((s) => s.currentFile);
  const focusTick = useAppStore((s) => s.sidebarFocusTick);
  const renameRequest = useAppStore((s) => s.renameRequest);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Row highlighted for keyboard navigation (distinct from mouse selection). */
  const [cursor, setCursor] = useState<string | null>(null);
  /** 待露出的行：祖先目录展开、懒加载完成（ready）后再落光标；rename 请求还要挂输入框。 */
  const [reveal, setReveal] = useState<{ relPath: string; ready: boolean; rename: boolean } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  /** Expands a folder; lazily reads its children on first open. */
  const expandNode = (node: FileNode) => {
    if (node.kind !== "dir") return;
    setExpanded((prev) => {
      if (prev.has(node.relPath)) return prev;
      const next = new Set(prev);
      next.add(node.relPath);
      return next;
    });
    if (node.children === null) void loadDirChildren(node.relPath);
  };

  const collapseNode = (node: FileNode) => {
    if (node.kind !== "dir") return;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(node.relPath);
      return next;
    });
  };

  const toggleFolder = (node: FileNode) => {
    if (node.kind === "dir" && expanded.has(node.relPath)) collapseNode(node);
    else expandNode(node);
  };

  const scrollRowIntoView = (relPath: string | null) => {
    if (!relPath || !treeRef.current) return;
    const el = treeRef.current.querySelector(`[data-path="${CSS.escape(relPath)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  };

  /**
   * 把仓库里的一行"露出来"：展开它的祖先目录，按层懒加载（父层先并入树，
   * mergeChildren 才找得到子层的挂载点），行渲染出来后再落光标。
   * 加载期间来了新的请求就以新的为准——本次的异步结果自证后丢弃。
   */
  const revealPath = (relPath: string, opts: { rename: boolean }) => {
    setReveal({ relPath, ready: false, rename: opts.rename });
    const chain = ancestorDirs(relPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of chain) next.add(dir);
      return next;
    });
    void (async () => {
      for (const dir of chain) {
        const node = findNode(useAppStore.getState().tree, dir);
        if (node?.kind === "dir" && node.children === null) await loadDirChildren(dir);
      }
      setReveal((cur) => (cur?.relPath === relPath ? { ...cur, ready: true } : cur));
    })();
  };

  // ⌘I (nav.focus-sidebar): 落到当前打开的笔记那一行——文件在折叠的目录里就先
  // 把祖先展开、懒加载补上，行渲染出来 reveal 收敛再把光标从祖先挪到文件本身。
  useEffect(() => {
    if (focusTick === 0) return;
    const rows = flattenVisible(tree, expanded);
    let target = rows[0]?.relPath ?? null;
    let rel: string | null = null;
    if (currentFile && vaultPath && currentFile.startsWith(`${vaultPath}/`)) {
      rel = currentFile.slice(vaultPath.length + 1);
      for (const n of rows) {
        if (rel === n.relPath || rel.startsWith(`${n.relPath}/`)) target = n.relPath;
      }
    }
    setCursor(target);
    treeRef.current?.focus();
    requestAnimationFrame(() => scrollRowIntoView(target));
    if (rel && target !== rel) revealPath(rel, { rename: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  // 新建文件夹后直接改名：同样先露出来，行就位后再挂内联输入框。
  // 请求取走即清空，所以不会在侧栏重新挂载时复活。
  useEffect(() => {
    if (!renameRequest) return;
    const relPath = renameRequest;
    useAppStore.getState().clearRenameRequest();
    revealPath(relPath, { rename: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest]);

  // reveal 收敛：行渲染出来就落光标（改名请求再挂输入框），然后清掉请求。
  useEffect(() => {
    if (!reveal) return;
    if (flattenVisible(tree, expanded).some((n) => n.relPath === reveal.relPath)) {
      setCursor(reveal.relPath);
      if (reveal.rename) setRenaming(reveal.relPath);
      scrollRowIntoView(reveal.relPath);
      setReveal(null);
    } else if (reveal.ready) {
      // 祖先层都加载完了还没有这一行：条目已被外部改名/删除，不再等待。
      setReveal(null);
    }
  }, [reveal, tree, expanded]);

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    const rows = flattenVisible(tree, expanded);
    if (rows.length === 0) return;
    const idx = cursor ? rows.findIndex((n) => n.relPath === cursor) : -1;
    const current = idx >= 0 ? rows[idx] : null;
    // vim 键位（j/k/h/l）只在 Vim 模式下生效，与方向键等价
    const { vim } = useAppStore.getState().settings;
    const key = vim ? { j: "ArrowDown", k: "ArrowUp", h: "ArrowLeft", l: "ArrowRight" }[e.key] ?? e.key : e.key;
    let nextPath: string | null = null;

    switch (key) {
      case "ArrowDown":
        e.preventDefault();
        nextPath = rows[Math.min(Math.max(idx, 0) + 1, rows.length - 1)].relPath;
        break;
      case "ArrowUp":
        e.preventDefault();
        nextPath = rows[Math.max(idx - 1, 0)].relPath;
        break;
      case "ArrowRight":
        e.preventDefault();
        if (current) expandNode(current);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (current) collapseNode(current);
        return;
      case "Enter": {
        e.preventDefault();
        if (!current) return;
        if (current.kind === "dir") toggleFolder(current);
        else if (vaultPath) void openNote(`${vaultPath}/${current.relPath}`);
        return;
      }
      case "Escape":
        e.preventDefault();
        editorApi.view?.focus();
        return;
      default:
        return;
    }
    setCursor(nextPath);
    scrollRowIntoView(nextPath);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button className="icon-btn" title="新建笔记" onClick={() => void newNote()}>
          <IconNewNote />
        </button>
        <button className="icon-btn" title="新建文件夹" onClick={() => void newFolder()}>
          <IconNewFolder />
        </button>
        <div className="sidebar-title" data-tauri-drag-region>
          {vaultName || "bnote"}
        </div>
        <button
          className="icon-btn"
          title="设置"
          onClick={() => useAppStore.getState().setModal("settings")}
        >
          ⚙
        </button>
      </div>
      <div
        ref={treeRef}
        className="sidebar-tree"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        onBlur={() => setCursor(null)}
      >
        {tree.map((node) => (
          <TreeItem
            key={node.relPath}
            node={node}
            depth={0}
            expanded={expanded}
            toggleFolder={toggleFolder}
            currentFile={currentFile}
            kbdCursor={cursor}
            menu={setMenu}
            renaming={renaming}
            setRenaming={setRenaming}
          />
        ))}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </aside>
  );
}

interface TreeItemProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  toggleFolder: (node: FileNode) => void;
  currentFile: string | null;
  kbdCursor: string | null;
  menu: (m: { x: number; y: number; items: MenuItem[] } | null) => void;
  renaming: string | null;
  setRenaming: (relPath: string | null) => void;
}

function TreeItem(props: TreeItemProps) {
  const { node, depth, expanded, toggleFolder, currentFile, kbdCursor, menu, renaming, setRenaming } =
    props;
  const vaultPath = useAppStore((s) => s.vaultPath)!;
  const isOpen = node.kind === "dir" && expanded.has(node.relPath);
  const absPath = `${vaultPath}/${node.relPath}`;
  const isCurrent = node.kind === "file" && currentFile === absPath;
  const isKbdCursor = kbdCursor === node.relPath;

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] =
      node.kind === "dir"
        ? [
            {
              label: "新建笔记",
              action: () => void createNoteIn(node.relPath),
            },
            { label: "新建文件夹", action: () => void newFolder(node.relPath) },
            { label: "重命名", action: () => setRenaming(node.relPath) },
            { label: "删除", danger: true, action: () => void trashEntry(absPath) },
          ]
        : [
            { label: "打开", action: () => void openNote(absPath) },
            { label: "重命名", action: () => setRenaming(node.relPath) },
            { label: "删除", danger: true, action: () => void trashEntry(absPath) },
          ];
    menu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div>
      <div
        className={`tree-row${isCurrent ? " current" : ""}${isKbdCursor ? " kbd-cursor" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        data-path={node.relPath}
        onClick={() => (node.kind === "dir" ? toggleFolder(node) : void openNote(absPath))}
        onContextMenu={openMenu}
        onDoubleClick={() => setRenaming(node.relPath)}
      >
        {node.kind === "dir" ? (
          <span className={`chevron${isOpen ? " open" : ""}`}>›</span>
        ) : (
          <span className="doc-icon">≡</span>
        )}
        {renaming === node.relPath ? (
          <RenameInput
            initial={node.name}
            onCommit={(name) => {
              setRenaming(null);
              if (name && name !== node.name) void renameEntry(absPath, name, node.kind === "file");
            }}
          />
        ) : (
          <span className="tree-name" title={node.relPath}>
            {node.name}
          </span>
        )}
      </div>
      {node.kind === "dir" &&
        isOpen &&
        (node.children === null ? (
          <div className="tree-row" style={{ paddingLeft: 24 + depth * 14 }}>
            <span className="tree-name">加载中…</span>
          </div>
        ) : (
          node.children.map((child) => (
            <TreeItem
              key={child.relPath}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggleFolder={toggleFolder}
              currentFile={currentFile}
              kbdCursor={kbdCursor}
              menu={menu}
              renaming={renaming}
              setRenaming={setRenaming}
            />
          ))
        ))}
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit(value.trim());
        if (e.key === "Escape") onCommit("");
      }}
      onBlur={() => onCommit(value.trim())}
    />
  );
}

async function createNoteIn(dir: string) {
  try {
    const created = await api.createFile(dir, "Untitled.md");
    await refreshTree();
    await openNote(created.path);
  } catch (e) {
    useAppStore.getState().showToast(`新建笔记失败: ${String(e)}`);
  }
}

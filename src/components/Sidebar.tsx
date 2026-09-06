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
import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import type { FileNode } from "@/lib/tauri";
import { ContextMenu, type MenuItem } from "./ContextMenu";

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

export function Sidebar() {
  const tree = useAppStore((s) => s.tree);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const currentFile = useAppStore((s) => s.currentFile);
  const focusTick = useAppStore((s) => s.sidebarFocusTick);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Row highlighted for keyboard navigation (distinct from mouse selection). */
  const [cursor, setCursor] = useState<string | null>(null);
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

  // ⌘I (nav.focus-sidebar): reveal, place the keyboard cursor on the current
  // note (or its closest visible ancestor) and focus the tree.
  useEffect(() => {
    if (focusTick === 0) return;
    const rows = flattenVisible(tree, expanded);
    let target = rows[0]?.relPath ?? null;
    if (currentFile && vaultPath && currentFile.startsWith(`${vaultPath}/`)) {
      const rel = currentFile.slice(vaultPath.length + 1);
      for (const n of rows) {
        if (rel === n.relPath || rel.startsWith(`${n.relPath}/`)) target = n.relPath;
      }
    }
    setCursor(target);
    treeRef.current?.focus();
    requestAnimationFrame(() => scrollRowIntoView(target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

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
          ✚
        </button>
        <button className="icon-btn" title="新建文件夹" onClick={() => void newFolder()}>
          ▤
        </button>
        <div className="sidebar-title" data-tauri-drag-region>
          {vaultName || "bnote"}
        </div>
        <button
          className="icon-btn"
          title="收起侧边栏 (⌘\)"
          onClick={() => useAppStore.getState().toggleSidebar()}
        >
          ◧
        </button>
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
              if (name && name !== node.name) void renameEntry(absPath, name);
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

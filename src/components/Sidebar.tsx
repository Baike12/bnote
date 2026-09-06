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
import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import type { FileNode } from "@/lib/tauri";
import { ContextMenu, type MenuItem } from "./ContextMenu";

export function Sidebar() {
  const tree = useAppStore((s) => s.tree);
  const vaultName = useAppStore((s) => s.vaultName);
  const currentFile = useAppStore((s) => s.currentFile);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  /** Expands a folder; lazily reads its children on first open. */
  const toggleFolder = (node: FileNode) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.relPath)) next.delete(node.relPath);
      else next.add(node.relPath);
      return next;
    });
    if (node.children === null && !expanded.has(node.relPath)) {
      void loadDirChildren(node.relPath);
    }
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
          title="设置"
          onClick={() => useAppStore.getState().setModal("settings")}
        >
          ⚙
        </button>
      </div>
      <div className="sidebar-tree">
        {tree.map((node) => (
          <TreeItem
            key={node.relPath}
            node={node}
            depth={0}
            expanded={expanded}
            toggleFolder={toggleFolder}
            currentFile={currentFile}
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
  menu: (m: { x: number; y: number; items: MenuItem[] } | null) => void;
  renaming: string | null;
  setRenaming: (relPath: string | null) => void;
}

function TreeItem(props: TreeItemProps) {
  const { node, depth, expanded, toggleFolder, currentFile, menu, renaming, setRenaming } = props;
  const vaultPath = useAppStore((s) => s.vaultPath)!;
  const isOpen = node.kind === "dir" && expanded.has(node.relPath);
  const absPath = `${vaultPath}/${node.relPath}`;
  const isCurrent = node.kind === "file" && currentFile === absPath;

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
        className={`tree-row${isCurrent ? " current" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
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

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
import { chainLoadPlan, flattenVisible } from "@/lib/tree";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import type { FileNode } from "@/lib/tauri";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { IconNewFolder, IconNewNote } from "./icons";
// The vault tree and the code-project tree share one icon family: the same
// 16-viewBox strokes in the same 14px box, so a row's icon and its name are
// centred on the same line by construction. A rotated "›" glyph cannot be:
// the ink of a text glyph is not the centre of its box, so the closed and the
// open state (and the name beside them) sat on different baselines.
import { FileTypeIcon, FolderTypeIcon } from "../code/components/FileIcon";

export function Sidebar() {
  const tree = useAppStore((s) => s.tree);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const currentFile = useAppStore((s) => s.currentFile);
  const focusRequest = useAppStore((s) => s.sidebarFocusRequest);
  const renameRequest = useAppStore((s) => s.renameRequest);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Row highlighted for keyboard navigation (distinct from mouse selection). */
  const [cursor, setCursor] = useState<string | null>(null);
  /** The row to reveal: the ancestor directories are filled in first and the caret lands once the row is rendered; a rename request also attaches the inline input. */
  const [reveal, setReveal] = useState<{ relPath: string; rename: boolean } | null>(null);
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
   * A request to reveal a row of the vault: the ancestor directories are
   * expanded on the way first, the rest is left to the convergence effect
   * below. Which layer is not read yet and whether the tree is complete is
   * recomputed by chainLoadPlan on every tree change, so the request is an
   * idempotent declaration and not a one-shot construction; a one-shot
   * construction would cancel itself while the tree is not ready (first
   * frame, just switched vault) and the row would never be revealed again.
   */
  const requestReveal = (relPath: string, opts: { rename: boolean }) => {
    setReveal({ relPath, rename: opts.rename });
    const chain = ancestorDirs(relPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of chain) next.add(dir);
      return next;
    });
  };

  // ⌘I (nav.focus-sidebar): land on the row of the currently open note.
  // The caret first goes to its closest visible ancestor (immediate feedback,
  // j/k work right away), then the whole row is revealed and once the
  // reveal converged the caret moves to the file itself. The request is
  // cleared as soon as it is taken, so a remount (collapse the sidebar with
  // ⌘\ and expand it again) does not treat a stale request as a new one and
  // steal the focus.
  useEffect(() => {
    if (focusRequest === null) return;
    useAppStore.getState().clearSidebarFocus();
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
    if (rel && target !== rel) requestReveal(rel, { rename: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Rename right after creating a folder: reveal it first as well and attach the inline input once the row is in place. The request is cleared as soon as it is taken, so it does not come back to life when the sidebar remounts.
  useEffect(() => {
    if (!renameRequest) return;
    const relPath = renameRequest;
    useAppStore.getState().clearRenameRequest();
    requestReveal(relPath, { rename: true });
     
  }, [renameRequest]);

  // The reveal converges: once the row is rendered the caret lands on it (a rename request attaches the inline input), then the request is cleared. While it is not rendered yet the ancestor chain keeps being filled in; a level of the chain that is not in the tree (first frame, just switched vault) is no conclusion, it is recomputed when the tree changes. Only when the chain is complete and the row is still not in the tree is the entry considered renamed or deleted from the outside.
  useEffect(() => {
    if (!reveal) return;
    if (flattenVisible(tree, expanded).some((n) => n.relPath === reveal.relPath)) {
      setCursor(reveal.relPath);
      if (reveal.rename) setRenaming(reveal.relPath);
      scrollRowIntoView(reveal.relPath);
      setReveal(null);
      return;
    }
    const { load, pending } = chainLoadPlan(tree, reveal.relPath);
    for (const dir of load) void loadDirChildren(dir);
    if (pending || load.length > 0) return;
    setReveal(null);
  }, [reveal, tree, expanded]);

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    const rows = flattenVisible(tree, expanded);
    if (rows.length === 0) return;
    const idx = cursor ? rows.findIndex((n) => n.relPath === cursor) : -1;
    const current = idx >= 0 ? rows[idx] : null;
    // The vim keys (j/k/h/l) only take effect in Vim mode and are equivalent to the arrow keys
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
    <aside className="app-sidebar">
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
      >
        {node.kind === "dir" ? (
          <FolderTypeIcon open={isOpen} />
        ) : (
          <FileTypeIcon name={node.name} />
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

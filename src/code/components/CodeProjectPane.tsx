import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAppStore } from "@/state/appStore";
import { startSplitDrag } from "@/components/splitDrag";
import { useCodeStore } from "../store";
import { clampTreeWidth, TREE_DEFAULT_WIDTH } from "../treeWidth";
import { clampTermHeight, TERM_DEFAULT_HEIGHT } from "../term/tabs";
import { TerminalDrawer } from "../term/TerminalDrawer";
import { FileTree } from "./FileTree";
import { DiffView } from "./DiffView";
import { ProblemsPanel, ReferencesPanel } from "./Panels";
import { CodeEditor } from "../editor/CodeEditor";
import { CodeOverlays } from "./CodeOverlays";
import { openProjectAt, openProjectDialog } from "../commands";
import { isRasterImage } from "../image";
import { ImageView } from "./ImageView";

/**
 * The "code project" view of the study mode middle column.
 *
 * Layout (the middle column is narrow, so everything is kept compact):
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │ [file tree] [diff] │ tabs… │ problems rescan │  ← toolbar
 * ├──────────┬───────────────────┴──────────┤
 * │ file tree ┃ editor / diff view            │
 * ├──────────┴──────────────────────────────┤
 * │ terminal drawer (multi-tab, ⌃`)           │
 * ├──────────────────────────────────────────┤
 * │ problems / references (collapsible)       │
 * ├──────────────────────────────────────────┤
 * │ branch · language · LSP · caret · vim     │  ← status bar
 * └──────────────────────────────────────────┘
 * ```
 *
 * The file tree is a **column side by side** with the editor: when expanded
 * it pushes the editor to the right instead of covering it. Covering it would
 * cut the code in the middle (half a line of text under the tree), which looks
 * like a broken render. The right edge is a draggable splitter (see
 * startTreeDrag), the width is stored in the settings.
 */
export function CodeProjectPane() {
  const project = useCodeStore((s) => s.project);
  const tabs = useCodeStore((s) => s.tabs);
  const activePath = useCodeStore((s) => s.activePath);
  const files = useCodeStore((s) => s.files);
  const treeOpen = useCodeStore((s) => s.treeOpen);
  const problemsOpen = useCodeStore((s) => s.problemsOpen);
  const diffOpen = useCodeStore((s) => s.diffOpen);
  const references = useCodeStore((s) => s.references);
  const git = useCodeStore((s) => s.git);
  const lspStates = useCodeStore((s) => s.lspStates);
  const diagnostics = useCodeStore((s) => s.diagnostics);

  const setActiveTab = useCodeStore((s) => s.setActiveTab);
  const closeTab = useCodeStore((s) => s.closeTab);
  const openFile = useCodeStore((s) => s.openFile);
  const setTreeOpen = useCodeStore((s) => s.setTreeOpen);
  const setProblemsOpen = useCodeStore((s) => s.setProblemsOpen);
  const setDiff = useCodeStore((s) => s.setDiff);
  const rescan = useCodeStore((s) => s.rescan);
  const termOpen = useCodeStore((s) => s.termOpen);
  const setTermOpen = useCodeStore((s) => s.setTermOpen);
  const codeTreeWidth = useAppStore((s) => s.settings.codeTreeWidth);
  const codeTermHeight = useAppStore((s) => s.settings.codeTermHeight);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [vimMode, setVimMode] = useState("");

  const activeFile = activePath ? files[activePath] : null;
  // A stable callback: FileTree is memoized, and a callback created anew on
  // every render would make the memo useless.
  const handleOpen = useCallback(
    (p: string, focus?: boolean) => void openFile(p, { focus }),
    [openFile],
  );
  const problemCount = useMemo(
    () => Object.values(diagnostics).reduce((n, list) => n + list.length, 0),
    [diagnostics],
  );

  /**
   * Drag the right edge of the file tree: during the drag only a CSS
   * variable is written (no setState — the panel holds CodeMirror and a
   * 60Hz re-render is expensive), the preference is committed once when the
   * pointer is released. The starting point measures the **actual width on
   * screen** (CSS clamped it when the middle column is narrow) and the delta
   * is counted from the press point, so a sloppy grip does not make it jump.
   */
  const startTreeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pane = paneRef.current;
    if (!pane) return;
    const paneWidth = pane.getBoundingClientRect().width;
    const drawer = pane.querySelector(".code-tree-drawer");
    const startWidth = drawer?.getBoundingClientRect().width ?? codeTreeWidth;
    startSplitDrag({
      event,
      host: pane,
      variables: ["--code-tree-w"],
      stored: { "--code-tree-w": codeTreeWidth },
      compute: (dx) => ({ "--code-tree-w": clampTreeWidth(startWidth + dx, paneWidth) }),
      commit: (values) => patchSettings({ codeTreeWidth: values["--code-tree-w"] }),
    });
  };

  const resetTreeWidth = () => patchSettings({ codeTreeWidth: TREE_DEFAULT_WIDTH });

  /**
   * Drag the terminal drawer's top edge. Same discipline as the tree width:
   * only the CSS variable moves during the drag, the preference is committed on
   * release. Dragging upwards (negative delta) grows the drawer.
   */
  const startTermDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pane = paneRef.current;
    if (!pane) return;
    const paneHeight = pane.getBoundingClientRect().height;
    const drawer = pane.querySelector(".code-term");
    const startHeight = drawer?.getBoundingClientRect().height ?? codeTermHeight;
    startSplitDrag({
      event,
      host: pane,
      axis: "y",
      variables: ["--code-term-h"],
      stored: { "--code-term-h": codeTermHeight },
      compute: (dy) => ({ "--code-term-h": clampTermHeight(startHeight - dy, paneHeight) }),
      commit: (values) => patchSettings({ codeTermHeight: values["--code-term-h"] }),
    });
  };

  const resetTermHeight = () => patchSettings({ codeTermHeight: TERM_DEFAULT_HEIGHT });

  if (!project) {
    return (
      <div className="code-pane" data-key-region="code">
        <CodeEmptyState />
      </div>
    );
  }

  return (
    <div
      className="code-pane"
      data-key-region="code"
      ref={paneRef}
      style={
        {
          "--code-tree-w": `${codeTreeWidth}px`,
          "--code-term-h": `${codeTermHeight}px`,
        } as React.CSSProperties
      }
    >
      <div className="code-toolbar" data-tauri-drag-region="deep">
        <button
          type="button"
          className={`code-tool-btn${treeOpen && !diffOpen ? " is-on" : ""}`}
          title="文件树:回到当前文件(⌘B 显示/隐藏)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            // Choosing a file is what the tree is for, so this button leaves
            // the change list and shows the focused file; the drawer is opened
            // when it is closed and never closed from here (⌘B does that).
            setDiff(false);
            if (!treeOpen) setTreeOpen(true);
          }}
        >
          文件树
        </button>
        <button
          type="button"
          className={`code-tool-btn${diffOpen ? " is-on" : ""}`}
          title="改动列表:每个改过的文件展开看差异(⌘⇧D)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setDiff(!diffOpen)}
        >
          差异
        </button>
        <button
          type="button"
          className={`code-tool-btn${termOpen ? " is-on" : ""}`}
          title="终端(⌃`)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setTermOpen(!termOpen)}
        >
          终端
        </button>
        <div className="code-tabs">
          {tabs.map((path) => {
            const open = files[path];
            const dirty = !!open && open.content !== open.saved;
            return (
              <button
                type="button"
                key={path}
                className={`code-tab${path === activePath ? " is-active" : ""}`}
                onClick={() => setActiveTab(path)}
                title={path}
              >
                <span className="code-tab-name">{baseName(path)}</span>
                {open?.external && (
                  <span className="code-tab-readonly" title="项目外的文件,只读">
                    只读
                  </span>
                )}
                {dirty && <span className="code-tab-dirty" title="有未保存的改动" />}
                <span
                  className="code-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(path);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={`code-tool-btn${problemsOpen ? " is-on" : ""}`}
          title="问题面板"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setProblemsOpen(!problemsOpen)}
        >
          问题{problemCount > 0 ? ` ${problemCount}` : ""}
        </button>
        {/* The file tree and the search both read the backend cache (no
            rescan of the repository per query), so files created or deleted
            outside do not show up on their own — this entry point must stay,
            it just sits in a secondary position. */}
        <button
          type="button"
          className="code-tool-btn"
          title="重新扫描文件树(在外部新建/删除了文件时用)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void rescan()}
        >
          重扫
        </button>
      </div>

      <div className="code-body">
        {treeOpen && (
          <>
            <aside className="code-tree-drawer">
              <FileTree activePath={activePath} onOpen={handleOpen} />
            </aside>
            <div
              className="code-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整文件树宽度"
              title="拖动调整文件树宽度,双击恢复默认"
              onPointerDown={startTreeDrag}
              onDoubleClick={resetTreeWidth}
            />
          </>
        )}
        <div className="code-main">
          {diffOpen ? (
            <DiffView />
          ) : activeFile?.binary && activeFile.external ? (
            // The asset protocol is scoped to the project root (and stays that
            // way), so a bitmap outside it has no URL to load: say so instead of
            // rendering a broken image.
            <div className="code-empty">项目外的二进制文件,不在这里预览</div>
          ) : activeFile?.binary && isRasterImage(activeFile.path) ? (
            // A bitmap is viewed right in the panel (the asset protocol reads
            // the original file, the editor is not involved).
            <ImageView root={project.root} file={activeFile} />
          ) : activeFile?.binary ? (
            // For every other binary file or anything over 2 MiB the backend
            // only returns an empty string: an empty editor must never be
            // shown — one keystroke followed by a save would blank the whole
            // original file.
            <div className="code-empty">二进制文件(或超过 2 MiB),不在这里编辑</div>
          ) : activeFile ? (
            // No key: switching tabs reuses the same CodeEditor instance, so
            // the EditorState cache in the handle survives (the undo stack and
            // the caret are not lost on a switch).
            <CodeEditor
              file={activeFile}
              onCursor={(line, column) => setCursor({ line, column })}
              onMode={setVimMode}
            />
          ) : (
            <div className="code-empty">从左边选一个文件打开</div>
          )}
        </div>
      </div>

      {/* The terminal spans the whole pane (tree included), like VSCode's
          bottom panel: it is a workspace-wide tool, not a property of the
          file on the right. */}
      {termOpen && (
        <>
          <div
            className="code-resizer code-resizer-row"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整终端高度"
            title="拖动调整终端高度,双击恢复默认"
            onPointerDown={startTermDrag}
            onDoubleClick={resetTermHeight}
          />
          <TerminalDrawer />
        </>
      )}

      {(problemsOpen || references) && (
        <div className="code-panel-host">
          {references ? <ReferencesPanel /> : <ProblemsPanel />}
        </div>
      )}

      <div className="code-status">
        <span className="code-status-item">{git?.branch ? `⎇ ${git.branch}` : project.name}</span>
        {activeFile && <span className="code-status-item">{activeFile.languageId}</span>}
        {activeFile && lspStates[activeFile.languageId] === "running" && (
          <span className="code-status-item is-ok">LSP</span>
        )}
        {vimMode && <span className="code-status-item is-vim">{vimMode}</span>}
        <span className="code-status-item is-spacer" />
        <span className="code-status-item">
          {cursor.line}:{cursor.column}
        </span>
      </div>

      <CodeOverlays />
    </div>
  );
}

/** The empty state when no project is open: pick a directory, or choose one of the recent projects. */
function CodeEmptyState() {
  const recent = useAppStore((s) => s.recentCodeProjects);
  return (
    <div className="code-empty-page" data-tauri-drag-region="deep">
      <div className="code-empty-title">打开一个代码项目</div>
      <button
        type="button"
        className="code-empty-btn"
        // The same path as the toolbar / the command (including the recent
        // projects and the study history bookkeeping).
        onClick={() => void openProjectDialog()}
      >
        选择文件夹…
      </button>
      {recent.length > 0 && (
        <div className="code-recent">
          <div className="code-recent-title">最近打开</div>
          {recent.map((path) => (
            <button
              type="button"
              key={path}
              className="code-recent-item"
              onClick={() => {
                void openProjectAt(path);
              }}
            >
              {path}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The file name of a path. */
function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

import { useCallback, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "../store";
import { FileTree } from "./FileTree";
import { DiffView } from "./DiffView";
import { ProblemsPanel, ReferencesPanel } from "./Panels";
import { CodeEditor } from "../editor/CodeEditor";
import { CodeOverlays } from "./CodeOverlays";
import { openProjectAt } from "../commands";

/**
 * 学习模式中栏的「代码项目」视图。
 *
 * 布局(中栏就那么宽,一切都往紧凑里做):
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │ [文件树] │ 标签页…            │ 差异 问题 │  ← 工具条
 * ├──────────┴───────────────────┴──────────┤
 * │ 文件树(抽屉)│ 编辑器 / 差异视图            │
 * ├──────────────────────────────────────────┤
 * │ 问题 / 引用(可折叠)                       │
 * ├──────────────────────────────────────────┤
 * │ 分支 · 语言 · LSP · 光标位置 · vim 模式     │  ← 状态条
 * └──────────────────────────────────────────┘
 * ```
 *
 * 文件树是**抽屉**:展开时盖在编辑器左边而不是把它挤窄——中栏宽度是用户拖
 * 出来的,不该被一个临时面板改掉。
 */
export function CodeProjectPane() {
  const project = useCodeStore((s) => s.project);
  const tabs = useCodeStore((s) => s.tabs);
  const activePath = useCodeStore((s) => s.activePath);
  const files = useCodeStore((s) => s.files);
  const treeOpen = useCodeStore((s) => s.treeOpen);
  const problemsOpen = useCodeStore((s) => s.problemsOpen);
  const diffPath = useCodeStore((s) => s.diffPath);
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

  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [vimMode, setVimMode] = useState("");

  const activeFile = activePath ? files[activePath] : null;
  // 稳定的回调:FileTree 是 memo 的,回调每次新建会让 memo 白包。
  const handleOpen = useCallback((p: string) => void openFile(p), [openFile]);
  const problemCount = useMemo(
    () => Object.values(diagnostics).reduce((n, list) => n + list.length, 0),
    [diagnostics],
  );

  if (!project) {
    return (
      <div className="content-pane code-pane" data-key-region="code">
        <CodeEmptyState />
      </div>
    );
  }

  return (
    <div className="content-pane code-pane" data-key-region="code">
      <div className="code-toolbar">
        <button
          type="button"
          className={`code-tool-btn${treeOpen ? " is-on" : ""}`}
          title="文件树"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setTreeOpen(!treeOpen)}
        >
          文件树
        </button>
        <div className="code-tabs">
          {tabs.map((path) => (
            <button
              type="button"
              key={path}
              className={`code-tab${path === activePath ? " is-active" : ""}`}
              onClick={() => setActiveTab(path)}
              title={path}
            >
              <span className="code-tab-name">{baseName(path)}</span>
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
          ))}
        </div>
        <button
          type="button"
          className="code-tool-btn"
          title="重新扫描文件树(在外部新建/删除了文件时用)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void rescan()}
        >
          重扫
        </button>
        <button
          type="button"
          className="code-tool-btn"
          title="查看当前文件的 git 差异"
          disabled={!activePath}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => activePath && setDiff(activePath)}
        >
          差异
        </button>
        <button
          type="button"
          className={`code-tool-btn${problemsOpen ? " is-on" : ""}`}
          title="问题面板"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setProblemsOpen(!problemsOpen)}
        >
          问题{problemCount > 0 ? ` ${problemCount}` : ""}
        </button>
      </div>

      <div className="code-body">
        {treeOpen && (
          <aside className="code-tree-drawer">
            <FileTree activePath={activePath} onOpen={handleOpen} />
          </aside>
        )}
        <div className="code-main">
          {diffPath ? (
            <DiffView path={diffPath} />
          ) : activeFile ? (
            <CodeEditor
              key={activeFile.path}
              file={activeFile}
              onCursor={(line, column) => setCursor({ line, column })}
              onMode={setVimMode}
            />
          ) : (
            <div className="code-empty">从左边选一个文件打开</div>
          )}
        </div>
      </div>

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

/** 没开项目时的空态:挑一个目录,或从最近项目里选。 */
function CodeEmptyState() {
  const recent = useAppStore((s) => s.recentCodeProjects);
  return (
    <div className="code-empty-page">
      <div className="code-empty-title">打开一个代码项目</div>
      <button
        type="button"
        className="code-empty-btn"
        onClick={async () => {
          const selection = await openFileDialog({
            directory: true,
            title: "选择代码项目文件夹",
          });
          if (typeof selection === "string") await openProjectAt(selection);
        }}
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

/** 取路径的文件名。 */
function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

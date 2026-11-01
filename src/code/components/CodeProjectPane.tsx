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
import { FileTree } from "./FileTree";
import { DiffView } from "./DiffView";
import { ProblemsPanel, ReferencesPanel } from "./Panels";
import { CodeEditor } from "../editor/CodeEditor";
import { CodeOverlays } from "./CodeOverlays";
import { openProjectAt, openProjectDialog } from "../commands";

/**
 * 学习模式中栏的「代码项目」视图。
 *
 * 布局(中栏就那么宽,一切都往紧凑里做):
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │ [文件树] [差异] │ 标签页…      │ 问题 重扫 │  ← 工具条
 * ├──────────┬───────────────────┴──────────┤
 * │ 文件树   ┃ 编辑器 / 差异视图            │
 * ├──────────┴──────────────────────────────┤
 * │ 问题 / 引用(可折叠)                       │
 * ├──────────────────────────────────────────┤
 * │ 分支 · 语言 · LSP · 光标位置 · vim 模式     │  ← 状态条
 * └──────────────────────────────────────────┘
 * ```
 *
 * 文件树是**并排的一栏**:展开时把编辑器挤到右边,而不是盖在编辑器上面。
 * 盖着会把代码从中间切断(半行字压在树底下),看着像渲染坏了。右缘是可拖
 * 的分栏线(见 startTreeDrag),宽度存设置。
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
  const codeTreeWidth = useAppStore((s) => s.settings.codeTreeWidth);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [vimMode, setVimMode] = useState("");

  const activeFile = activePath ? files[activePath] : null;
  // 稳定的回调:FileTree 是 memo 的,回调每次新建会让 memo 白包。
  const handleOpen = useCallback((p: string) => void openFile(p), [openFile]);
  const problemCount = useMemo(
    () => Object.values(diagnostics).reduce((n, list) => n + list.length, 0),
    [diagnostics],
  );

  /**
   * 拖文件树右缘:拖动期间只写 CSS 变量(不 setState——面板里是 CodeMirror,
   * 60Hz 重渲染代价大),指针抬起提交一次偏好。起点量**屏幕上实际的宽度**
   * (中栏窄时 CSS 夹过),位移从按下点算,握歪了也不会跳。
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
      style={{ "--code-tree-w": `${codeTreeWidth}px` } as React.CSSProperties}
    >
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
        {/* 文件树与搜索都读后端缓存(不为每次查询重扫仓库),外部新建/删除
            文件不会自己出现——这条入口不能去掉,只放在次要位置。 */}
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
          {diffPath ? (
            <DiffView path={diffPath} />
          ) : activeFile?.binary ? (
            // 二进制 / 超过 2 MiB 的文件后端只回空串:绝不能把空编辑器摆出来
            // ——一敲键再保存就把原文件整篇清空了。
            <div className="code-empty">
              二进制文件(或超过 2 MiB),不在这里编辑
            </div>
          ) : activeFile ? (
            // 不挂 key:切标签时复用同一个 CodeEditor 实例,句柄里的
            // EditorState 缓存才留得住(撤销栈与光标不会随切换丢掉)。
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
        // 与工具栏 / 命令走同一条路(含「最近项目」与学习历史记账)。
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

/** 取路径的文件名。 */
function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DragEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { useAppStore } from "@/state/appStore";
import {
  cachedProjectDoc,
  createProject,
  focusedProjectPath,
  loadProjects,
  projectEntries,
  projectsRevision,
  readProjectDoc,
  setCachedProjectDoc,
  setFocusedProject,
  subscribeProjects,
  writeProjectDoc,
  type ProjectEntry,
} from "@/projects/store";
import { projectTodos } from "@/projects/model";
import { TODO_DRAG_MIME, encodeTodoDrag, projectTodoDragExtension } from "@/projects/drag";
import { setActiveKeyRegion } from "@/commands/globalKeys";
import { PaneEditor } from "./PaneEditor";
import { DailyNotePane } from "./DailyNotePane";

/**
 * 项目管理视图(与学习模式同级、互斥)。
 *
 *   项目列表 | 项目卡片带(当前项目居中可编辑,左右是相邻项目的只读预览) | 日记
 *
 * 中栏用「三槽轮播」而不是横向滚动所有卡片:编辑器实例固定落在中槽,切换
 * 项目只换它装的文档(path → PaneEditor 的 load),不必移动 CodeMirror 的
 * DOM,也不会为每个项目各建一个实例。左右卡片是纯 DOM 预览,可直接拖出待办。
 */

const PROJECT_EXTENSIONS = [projectTodoDragExtension()];

export function ProjectsLayout() {
  const vaultRoot = useAppStore((s) => s.vaultPath);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  useSyncExternalStore(subscribeProjects, projectsRevision, projectsRevision);

  const entries = projectEntries();
  const focusedPath = focusedProjectPath();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const projectViewRef = useRef<EditorView | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  }, [entries, query]);

  const focused: ProjectEntry | null =
    list.find((e) => e.path === focusedPath) ?? list[0] ?? null;
  const idx = focused ? list.findIndex((e) => e.path === focused.path) : -1;
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  // 列表/搜索变化后把「当前聚焦」校正到仍然存在的项目上。
  useEffect(() => {
    const target = focused?.path ?? null;
    if (target !== focusedPath) setFocusedProject(target);
  }, [focused?.path, focusedPath]);

  useEffect(() => {
    if (vaultRoot) void loadProjects(vaultRoot);
  }, [vaultRoot]);

  // 命令层只发信号(它拿不到卡片里的编辑器实例与新建输入框)。
  useEffect(() => {
    const focusCard = () => {
      setActiveKeyRegion("project");
      projectViewRef.current?.focus();
    };
    const startNew = () => {
      setCreating(true);
      setDraft("");
    };
    window.addEventListener("bnote:focus-project", focusCard);
    window.addEventListener("bnote:new-project", startNew);
    return () => {
      window.removeEventListener("bnote:focus-project", focusCard);
      window.removeEventListener("bnote:new-project", startNew);
    };
  }, []);

  // 切换项目 = 把焦点交给中槽编辑器(点击卡片、按快捷键走同一条落点)。
  useEffect(() => {
    const view = projectViewRef.current;
    if (!view || !focused) return;
    const id = requestAnimationFrame(() => {
      if (view.dom.isConnected) view.focus();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused?.path]);

  const commitNewProject = async () => {
    const name = draft.trim();
    setCreating(false);
    setDraft("");
    if (!name || !vaultRoot) return;
    const created = await createProject(vaultRoot, name).catch(() => null);
    if (created) setFocusedProject(created.path);
    else useAppStore.getState().showToast("新建项目失败");
  };

  return (
    <div
      className="projects-layout"
      style={
        // 侧栏收起时 macOS 红绿灯压在主区左上角,左栏头部内容让开(与 titlebar 同约定)。
        { "--projects-lead": sidebarOpen ? "12px" : "78px" } as React.CSSProperties
      }
    >
      <aside className="projects-side" data-key-region="project">
        <div className="projects-side-head" data-tauri-drag-region="deep">
          <span className="projects-side-title">项目列表</span>
          <button
            className="icon-btn projects-new"
            title="新建项目"
            onClick={() => {
              setCreating(true);
              setDraft("");
            }}
          >
            +
          </button>
        </div>
        {creating && (
          <input
            className="projects-new-input"
            autoFocus
            value={draft}
            placeholder="项目名，回车创建"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitNewProject()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitNewProject();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setCreating(false);
                setDraft("");
              }
            }}
          />
        )}
        <div className="projects-side-list">
          {list.map((e) => (
            <button
              key={e.path}
              className={`projects-side-item${focused?.path === e.path ? " active" : ""}`}
              onClick={() => setFocusedProject(e.path)}
            >
              {e.name}
            </button>
          ))}
          {list.length === 0 && (
            <div className="projects-side-empty">
              {entries.length === 0 ? "还没有项目，点 + 新建" : "没有匹配的项目"}
            </div>
          )}
        </div>
      </aside>

      <div className="projects-split" />

      <section className="projects-deck" data-key-region="project">
        <div className="projects-deck-head" data-tauri-drag-region="deep">
          <input
            className="projects-search"
            value={query}
            placeholder="搜索项目"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="projects-deck-track">
          <ProjectPreview project={prev} side="prev" onFocus={setFocusedProject} />
          <div className={`project-card current${focused ? "" : " empty"}`}>
            {focused ? (
              <>
                <div className="project-card-title">{focused.name}</div>
                <PaneEditor
                  path={focused.path}
                  className="project-card-editor"
                  load={(path) => readProjectDoc(path)}
                  save={(path, text) => writeProjectDoc(path, text)}
                  onSnapshot={(path, text) => setCachedProjectDoc(path, text)}
                  extraExtensions={PROJECT_EXTENSIONS}
                  allowAutoSend={false}
                  onViewChange={(view) => {
                    projectViewRef.current = view;
                  }}
                />
              </>
            ) : (
              <div className="project-card-empty">
                <p>还没有项目</p>
                <p>在左侧点 + 新建一个</p>
              </div>
            )}
          </div>
          <ProjectPreview project={next} side="next" onFocus={setFocusedProject} />
        </div>
      </section>

      <div className="projects-split" />

      <DailyNotePane />
    </div>
  );
}

function ProjectPreview({
  project,
  side,
  onFocus,
}: {
  project: ProjectEntry | null;
  side: "prev" | "next";
  onFocus: (path: string) => void;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!project) {
      setText("");
      return;
    }
    const hit = cachedProjectDoc(project.path);
    if (hit !== undefined) {
      setText(hit);
      return;
    }
    let cancelled = false;
    void readProjectDoc(project.path).then((t) => {
      if (!cancelled) setText(t);
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const todos = project ? projectTodos(text) : [];

  const onDragStart = (e: DragEvent, line: number, raw: string) => {
    if (!project) return;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(TODO_DRAG_MIME, encodeTodoDrag({ srcPath: project.path, line }));
    e.dataTransfer.setData("text/plain", raw);
  };

  return (
    <div
      className={`project-card preview ${side}${project ? "" : " blank"}`}
      role="button"
      tabIndex={project ? 0 : -1}
      onClick={() => project && onFocus(project.path)}
      onKeyDown={(e) => {
        if (project && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onFocus(project.path);
        }
      }}
    >
      {project ? (
        <>
          <div className="project-card-title">{project.name}</div>
          <ul className="project-preview-list">
            {todos.map((t) => (
              <li
                key={t.line}
                className={`project-preview-todo${t.done ? " done" : ""}`}
                style={{ paddingLeft: `${t.indent * 12}px` }}
                draggable
                onDragStart={(e) => onDragStart(e, t.line, t.raw)}
                title="拖到右侧日记"
              >
                <span className="project-preview-box">{t.done ? "☑" : "☐"}</span>
                <span className="project-preview-text">{t.text}</span>
              </li>
            ))}
            {todos.length === 0 && <li className="project-preview-empty">暂无待办</li>}
          </ul>
        </>
      ) : (
        <div className="project-card-title muted">—</div>
      )}
    </div>
  );
}

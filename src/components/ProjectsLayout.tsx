import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
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
import { projectCounts, projectTodos } from "@/projects/model";
import { TODO_DRAG_MIME, encodeTodoDrag, projectTodoDragExtension } from "@/projects/drag";
import {
  DEFAULT_DAILY_WIDTH,
  DEFAULT_SIDE_WIDTH,
  RESIZER_WIDTH,
  dragDailyEdge,
  dragSideEdge,
} from "@/projects/layoutModel";
import { focusEditor } from "@/editor/api";
import { setActiveKeyRegion } from "@/commands/globalKeys";
import { startSplitDrag } from "./splitDrag";
import { PaneEditor } from "./PaneEditor";
import { DailyNotePane } from "./DailyNotePane";

/**
 * 项目管理视图(与学习模式同级、互斥)。
 *
 *   项目导航 | 项目看板(横向多列,当前列居中且可编辑) | 日记
 *
 * 看板是**真的多列**:每个项目一列,列头是项目名 + 未完成数,列里是待办。
 * 当前列用 CodeMirror(可 vim 编辑、可拖出待办),其余列是纯 DOM 预览(点击
 * 即聚焦过去)。只有当前列装编辑器——为每个项目各建一个实例在项目多时不可
 * 接受;当前列在 track 里靠 CSS `order` 排到对应位置,切换项目只换它装的
 * 文档(PaneEditor 的 path 变化),不重建实例、不移动 DOM 子树。
 *
 * 两侧栏宽度可拖:导航与日记按像素存进 settings,看板吃剩余;拖分隔线只动
 * 相邻的两栏(见 projects/layoutModel)。
 */

const PROJECT_EXTENSIONS = [projectTodoDragExtension()];

export function ProjectsLayout() {
  const vaultRoot = useAppStore((s) => s.vaultPath);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const sideWidth = useAppStore((s) => s.settings.projectsSideWidth);
  const dailyWidth = useAppStore((s) => s.settings.projectsDailyWidth);
  const patchSettings = useAppStore((s) => s.patchSettings);
  useSyncExternalStore(subscribeProjects, projectsRevision, projectsRevision);

  const entries = projectEntries();
  const focusedPath = focusedProjectPath();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const projectViewRef = useRef<EditorView | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  }, [entries, query]);

  const focused: ProjectEntry | null =
    list.find((e) => e.path === focusedPath) ?? list[0] ?? null;
  const focusPath = focused?.path ?? null;
  const idx = focused ? list.findIndex((e) => e.path === focused.path) : -1;

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
      focusEditor(projectViewRef.current);
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

  // 切换项目 = 把焦点交给当前列编辑器(点击列、按快捷键走同一条落点)。
  useEffect(() => {
    const view = projectViewRef.current;
    if (!view || !focusPath) return;
    const id = requestAnimationFrame(() => {
      if (view.dom.isConnected) focusEditor(view);
    });
    return () => cancelAnimationFrame(id);
  }, [focusPath]);

  // 当前列始终居中:轨道两端留出 (看板宽 − 列宽) / 2 的空白,首个/末个项目
  // 才滚得到正中间;列换位置或看板宽度变化(拖分栏线、改窗口)时重算。
  useEffect(() => {
    const board = boardRef.current;
    const track = board?.querySelector<HTMLElement>(".projects-board-track");
    if (!board || !track) return;

    const place = (smooth: boolean) => {
      const col = board.querySelector<HTMLElement>("[data-current-col]");
      const colWidth = col?.offsetWidth ?? 320;
      const pad = Math.max(18, Math.round((board.clientWidth - colWidth) / 2));
      track.style.setProperty("--board-edge-pad", `${pad}px`);
      // 边缘渐隐不超过留白:窄窗口里留白只有 18px 时,不能把当前列也淡掉。
      board.style.setProperty("--board-fade", `${Math.min(64, pad)}px`);
      if (!col) return;
      const target = Math.max(0, col.offsetLeft - (board.clientWidth - col.offsetWidth) / 2);
      board.scrollTo({ left: target, behavior: smooth ? "smooth" : "auto" });
    };

    const id = requestAnimationFrame(() => place(true));
    // 拖分栏线/改窗口时看板宽度每帧都在变:跟着调边距,保持当前列不漂。
    const observer = new ResizeObserver(() => place(false));
    observer.observe(board);
    return () => {
      cancelAnimationFrame(id);
      observer.disconnect();
    };
  }, [focusPath, list.length]);

  /** 拖 导航|看板:改导航宽度,日记栏不动(量屏幕上的实测宽度,CSS 可能夹过)。 */
  function startSideDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const sideEl = host.querySelector<HTMLElement>(".projects-side");
    const dailyEl = host.querySelector<HTMLElement>(".projects-daily");
    if (!sideEl || !dailyEl || hostRect.width <= 0) return;
    const side0 = sideEl.getBoundingClientRect().width;
    const daily0 = dailyEl.getBoundingClientRect().width;
    startSplitDrag({
      event,
      host,
      variables: ["--side-src"],
      stored: { "--side-src": sideWidth },
      compute: (dx) => {
        const side = dragSideEdge(side0 + RESIZER_WIDTH + dx, hostRect.width, daily0);
        return { "--side-src": side };
      },
      commit: (values) => patchSettings({ projectsSideWidth: values["--side-src"] }),
    });
  }

  /** 拖 看板|日记:改日记宽度,导航栏不动。 */
  function startDailyDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const sideEl = host.querySelector<HTMLElement>(".projects-side");
    const dailyEl = host.querySelector<HTMLElement>(".projects-daily");
    if (!sideEl || !dailyEl || hostRect.width <= 0) return;
    const side0 = sideEl.getBoundingClientRect().width;
    const dailyRect = dailyEl.getBoundingClientRect();
    const dailyLeft = dailyRect.left - hostRect.left;
    startSplitDrag({
      event,
      host,
      variables: ["--daily-src"],
      stored: { "--daily-src": dailyWidth },
      compute: (dx) => ({
        "--daily-src": dragDailyEdge(dailyLeft + dx, hostRect.width, side0),
      }),
      commit: (values) => patchSettings({ projectsDailyWidth: values["--daily-src"] }),
    });
  }

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
      ref={hostRef}
      style={
        {
          // 侧栏收起时 macOS 红绿灯压在主区左上角,左栏头部内容让开(与 titlebar 同约定)。
          "--projects-lead": sidebarOpen ? "12px" : "78px",
          "--side-src": `${sideWidth}px`,
          "--daily-src": `${dailyWidth}px`,
        } as React.CSSProperties
      }
    >
      <aside className="projects-side" data-key-region="project">
        <div className="projects-side-head" data-tauri-drag-region="deep">
          <span className="projects-side-title">项目</span>
          <span className="projects-side-total">{entries.length}</span>
          <button
            className="icon-btn projects-side-new"
            title="新建项目（⌘⇧N）"
            onClick={() => {
              setCreating(true);
              setDraft("");
            }}
          >
            +
          </button>
        </div>
        <div className="projects-side-filter">
          <input
            className="projects-search"
            value={query}
            placeholder="搜索项目"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
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
              className={`projects-side-item${focusPath === e.path ? " active" : ""}`}
              onClick={() => setFocusedProject(e.path)}
              title={e.name}
            >
              <span className="projects-side-dot" aria-hidden>
                {initialOf(e.name)}
              </span>
              <span className="projects-side-name">{e.name}</span>
            </button>
          ))}
          {list.length === 0 && (
            <div className="projects-side-empty">
              {entries.length === 0 ? "还没有项目，点 + 新建" : "没有匹配的项目"}
            </div>
          )}
        </div>
      </aside>

      <div
        className="projects-resizer"
        data-key-region="project"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整项目导航宽度"
        title="拖动调整项目导航宽度，双击恢复默认"
        onPointerDown={startSideDrag}
        onDoubleClick={() => patchSettings({ projectsSideWidth: DEFAULT_SIDE_WIDTH })}
      />

      <section className="projects-deck" data-key-region="project">
        <div className="projects-deck-head" data-tauri-drag-region="deep">
          <span className="projects-deck-pos">
            {focused ? `第 ${idx + 1} / ${list.length} 个项目` : entries.length ? "没有匹配的项目" : "还没有项目"}
          </span>
          <span className="projects-deck-hint">⌘⇧J 发送到日记 · ⌘⇧↑↓ 切换</span>
        </div>
        <div className="projects-board" ref={boardRef}>
          <div className="projects-board-track">
            {focused ? (
              <>
                {list.map((e, i) =>
                  e.path === focused.path ? null : (
                    <ProjectColumn
                      key={e.path}
                      project={e}
                      order={i}
                      position={i < idx ? "prev" : "next"}
                      onFocus={setFocusedProject}
                    />
                  ),
                )}
                <CurrentColumn
                  key="current"
                  project={focused}
                  order={idx}
                  onView={(view) => {
                    projectViewRef.current = view;
                  }}
                />
              </>
            ) : (
              <div className="projects-board-empty">
                <p className="projects-board-empty-title">还没有项目</p>
                <p>在左侧点 + 新建一个，这里会出现它的待办列。</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <div
        className="projects-resizer"
        data-key-region="project"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整日记栏宽度"
        title="拖动调整日记栏宽度，双击恢复默认"
        onPointerDown={startDailyDrag}
        onDoubleClick={() => patchSettings({ projectsDailyWidth: DEFAULT_DAILY_WIDTH })}
      />

      <DailyNotePane />
    </div>
  );
}

function initialOf(name: string): string {
  const ch = Array.from(name.trim())[0] ?? "·";
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

/** 当前项目列:列头 + 完成度 + 编辑器(整个视图里唯一的 CodeMirror)。 */
function CurrentColumn({
  project,
  order,
  onView,
}: {
  project: ProjectEntry;
  order: number;
  onView: (view: EditorView | null) => void;
}) {
  const [counts, setCounts] = useState(() => {
    const hit = cachedProjectDoc(project.path);
    return hit === undefined ? { total: 0, done: 0 } : projectCounts(projectTodos(hit));
  });

  // 换项目时列头计数跟着换(缓存命中就同步显示,不必等编辑器读盘)。
  useEffect(() => {
    const hit = cachedProjectDoc(project.path);
    if (hit !== undefined) {
      setCounts(projectCounts(projectTodos(hit)));
      return;
    }
    let cancelled = false;
    void readProjectDoc(project.path).then((text) => {
      if (!cancelled) setCounts(projectCounts(projectTodos(text)));
    });
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  const pending = counts.total - counts.done;
  const pct = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;

  return (
    <div className="project-col current" style={{ order }} data-current-col="">
      <div className="project-col-head">
        <span className="project-col-name" title={project.name}>
          {project.name}
        </span>
        <span className="project-col-badge" title={`${counts.done} / ${counts.total} 已完成`}>
          {pending}
        </span>
      </div>
      <div className="project-col-progress" title={`${counts.done} / ${counts.total} 已完成`}>
        <span className="project-col-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <PaneEditor
        path={project.path}
        className="project-col-editor"
        load={(path) => readProjectDoc(path)}
        save={(path, text) => writeProjectDoc(path, text)}
        onSnapshot={(path, text) => {
          setCachedProjectDoc(path, text);
          // 每击输入重算一遍计数(项目文档小:1000 行解析 ~0.15ms,见
          // perf.gate)。同值时 setState 不触发重渲染。
          const next = projectCounts(projectTodos(text));
          setCounts((prev) =>
            prev.total === next.total && prev.done === next.done ? prev : next,
          );
        }}
        extraExtensions={PROJECT_EXTENSIONS}
        allowAutoSend={false}
        onViewChange={onView}
      />
    </div>
  );
}

/** 非当前项目列:纯 DOM 预览(点击聚焦、待办可拖到日记)。 */
function ProjectColumn({
  project,
  order,
  position,
  onFocus,
}: {
  project: ProjectEntry;
  order: number;
  position: "prev" | "next";
  onFocus: (path: string) => void;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    const hit = cachedProjectDoc(project.path);
    if (hit !== undefined) {
      setText(hit);
      return;
    }
    let cancelled = false;
    setText("");
    void readProjectDoc(project.path).then((t) => {
      if (!cancelled) setText(t);
    });
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  const todos = projectTodos(text);
  const counts = projectCounts(todos);
  const pending = counts.total - counts.done;

  const onDragStart = (e: DragEvent, line: number, raw: string) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(TODO_DRAG_MIME, encodeTodoDrag({ srcPath: project.path, line }));
    e.dataTransfer.setData("text/plain", raw);
  };

  return (
    <div
      className={`project-col preview ${position}`}
      style={{ order }}
      role="button"
      tabIndex={0}
      onClick={() => onFocus(project.path)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus(project.path);
        }
      }}
      title={`点击聚焦「${project.name}」`}
    >
      <div className="project-col-head">
        <span className="project-col-name" title={project.name}>
          {project.name}
        </span>
        <span className="project-col-badge" title={`${counts.done} / ${counts.total} 已完成`}>
          {pending}
        </span>
      </div>
      <ul className="project-col-list">
        {todos.map((t) => (
          <li
            key={t.line}
            className={`project-col-todo${t.done ? " done" : ""}`}
            style={{ paddingLeft: `${t.indent * 12}px` }}
            draggable
            onDragStart={(e) => onDragStart(e, t.line, t.raw)}
            title="拖到右侧日记"
          >
            <span className="project-col-box">{t.done ? "☑" : "☐"}</span>
            <span className="project-col-text">{t.text}</span>
          </li>
        ))}
        {todos.length === 0 && <li className="project-col-empty">暂无待办</li>}
      </ul>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { useAppStore } from "@/state/appStore";
import {
  cachedProjectDoc,
  createProject,
  deleteProject,
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
import { startSplitDrag } from "../splitDrag";
import { PaneEditor } from "../PaneEditor";
import { DailyNotePane } from "../daily/DailyNotePane";
import { ContextMenu, type MenuItem } from "../ContextMenu";

/**
 * Project management view (on the same level as study mode, mutually
 * exclusive with it).
 *
 *   project navigation | project board (several horizontal columns, the
 *   current one centered and editable) | daily note
 *
 * The board is **really multi-column**: one column per project, the column
 * header holds the project name and the number of open todos, the column
 * holds the todos. The current column uses CodeMirror (vim editable, todos
 * can be dragged out), the other columns are a pure DOM preview (clicking
 * one focuses it). Only the current column holds an editor, building one
 * instance per project is unacceptable once there are many projects; the
 * current column is placed in the track by CSS `order`, switching projects
 * only swaps the document it holds (a path change in PaneEditor), it does
 * not rebuild the instance and does not move the DOM subtree.
 *
 * The two sidebars have a draggable width: navigation and daily note are
 * stored in pixels in the settings, the board takes the rest; dragging a
 * divider only moves the two adjacent columns (see projects/layoutModel).
 */

const PROJECT_EXTENSIONS = [projectTodoDragExtension()];

/**
 * Deletes a project (shared by the menu and ⌘⌫).
 *
 * Everything is read from the store (vault and focus): the command layer
 * registers its event listener only once, so the rendered values captured
 * in the closure would be stale. The deletion itself is guarded by
 * projects/store, which makes sure a late write does not resurrect the file.
 */
async function trashProject(project: ProjectEntry): Promise<void> {
  const root = useAppStore.getState().vaultPath;
  if (!root) return;
  try {
    await deleteProject(root, project.path);
    useAppStore.getState().showToast(`已删除项目「${project.name}」,可在废纸篓恢复`);
  } catch (e) {
    useAppStore.getState().showToast(`删除项目失败: ${String(e)}`);
  }
}

/** ⌘⌫: deletes the currently focused project. */
function trashFocusedProject(): Promise<void> | void {
  const path = focusedProjectPath();
  const entry = path ? projectEntries().find((e) => e.path === path) : null;
  return entry ? trashProject(entry) : undefined;
}

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
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
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

  // After the list or the search changed, correct the "current focus" onto a project that still exists.
  useEffect(() => {
    const target = focused?.path ?? null;
    if (target !== focusedPath) setFocusedProject(target);
  }, [focused?.path, focusedPath]);

  useEffect(() => {
    if (vaultRoot) void loadProjects(vaultRoot);
  }, [vaultRoot]);

  // The command layer only emits a signal (it cannot reach the editor instance inside the card or the new-project input).
  useEffect(() => {
    const focusCard = () => {
      setActiveKeyRegion("project");
      focusEditor(projectViewRef.current);
    };
    const startNew = () => {
      setCreating(true);
      setDraft("");
    };
    const removeFocused = () => void trashFocusedProject();
    window.addEventListener("bnote:focus-project", focusCard);
    window.addEventListener("bnote:new-project", startNew);
    window.addEventListener("bnote:delete-project", removeFocused);
    return () => {
      window.removeEventListener("bnote:focus-project", focusCard);
      window.removeEventListener("bnote:new-project", startNew);
      window.removeEventListener("bnote:delete-project", removeFocused);
    };
  }, []);

  // Switching projects means handing the focus to the editor of the current column (clicking a column and the shortcut take the same path).
  useEffect(() => {
    const view = projectViewRef.current;
    if (!view || !focusPath) return;
    const id = requestAnimationFrame(() => {
      if (view.dom.isConnected) focusEditor(view);
    });
    return () => cancelAnimationFrame(id);
  }, [focusPath]);

  // The current column is always centered: the track leaves (board width -
  // column width) / 2 of padding at both ends, so the first and the last
  // project can scroll into the exact middle. It is recomputed when a
  // column changes position or the board width changes (divider drag,
  // window resize).
  useEffect(() => {
    const board = boardRef.current;
    const track = board?.querySelector<HTMLElement>(".projects-board-track");
    if (!board || !track) return;

    const place = (smooth: boolean) => {
      const col = board.querySelector<HTMLElement>("[data-current-col]");
      const colWidth = col?.offsetWidth ?? 320;
      const pad = Math.max(18, Math.round((board.clientWidth - colWidth) / 2));
      track.style.setProperty("--board-edge-pad", `${pad}px`);
      // The edge fade never exceeds the padding: with only 18 px of padding in a narrow window, the current column must not be faded out too.
      board.style.setProperty("--board-fade", `${Math.min(64, pad)}px`);
      if (!col) return;
      const target = Math.max(0, col.offsetLeft - (board.clientWidth - col.offsetWidth) / 2);
      board.scrollTo({ left: target, behavior: smooth ? "smooth" : "auto" });
    };

    const id = requestAnimationFrame(() => place(true));
    // While a divider is dragged or the window is resized the board width changes on every frame: adjust the padding along with it so the current column does not drift.
    const observer = new ResizeObserver(() => place(false));
    observer.observe(board);
    return () => {
      cancelAnimationFrame(id);
      observer.disconnect();
    };
  }, [focusPath, list.length]);

  /** Drag navigation|board: changes the navigation width, the daily note column stays (measures the real width on screen, CSS may have clamped it). */
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

  /** Drag board|daily note: changes the daily note width, the navigation column stays. */
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

  const removeProject = (project: ProjectEntry) => void trashProject(project);

  /** The project action menu: the right click of a list item or a column header and the "..." at the top share the same entries. */
  const openProjectMenu = (project: ProjectEntry, x: number, y: number) => {
    setMenu({
      x,
      y,
      items: [{ label: "删除项目", danger: true, action: () => removeProject(project) }],
    });
  };

  return (
    <div
      className="projects-layout"
      ref={hostRef}
      style={
        {
          // With the sidebar collapsed the macOS traffic lights sit on the top left of the main area, so the header of the left column steps aside (same rule as the titlebar).
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
              onContextMenu={(ev) => {
                ev.preventDefault();
                setFocusedProject(e.path);
                openProjectMenu(e, ev.clientX, ev.clientY);
              }}
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
          <span className="projects-deck-actions">
            <span className="projects-deck-hint">⌘⇧J 发送到日记 · ⌘⇧↑↓ 切换 · ⌘⌫ 删除</span>
            <button
              className="icon-btn projects-deck-more"
              title="项目操作"
              aria-label="项目操作"
              disabled={!focused}
              onClick={(ev) => {
                if (!focused) return;
                const rect = ev.currentTarget.getBoundingClientRect();
                openProjectMenu(focused, rect.left, rect.bottom + 4);
              }}
            >
              ⋯
            </button>
          </span>
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
                      onMenu={openProjectMenu}
                    />
                  ),
                )}
                <CurrentColumn
                  key="current"
                  project={focused}
                  order={idx}
                  onMenu={openProjectMenu}
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
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function initialOf(name: string): string {
  const ch = Array.from(name.trim())[0] ?? "·";
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

/** The current project column: header + progress + editor (the only CodeMirror in the whole view). */
function CurrentColumn({
  project,
  order,
  onView,
  onMenu,
}: {
  project: ProjectEntry;
  order: number;
  onView: (view: EditorView | null) => void;
  onMenu: (project: ProjectEntry, x: number, y: number) => void;
}) {
  const [counts, setCounts] = useState(() => {
    const hit = cachedProjectDoc(project.path);
    return hit === undefined ? { total: 0, done: 0 } : projectCounts(projectTodos(hit));
  });

  // The header counts follow when the project changes (a cache hit shows them right away, no need to wait for the editor to read the file).
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
      <div
        className="project-col-head"
        onContextMenu={(ev) => {
          ev.preventDefault();
          onMenu(project, ev.clientX, ev.clientY);
        }}
      >
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
          // The counts are recomputed on every keystroke (the project
          // document is small: parsing 1000 lines takes ~0.15 ms, see
          // perf.gate). With an unchanged value setState does not re-render.
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

/** A project column that is not the current one: a pure DOM preview (click to focus, todos can be dragged to the daily note). */
function ProjectColumn({
  project,
  order,
  position,
  onFocus,
  onMenu,
}: {
  project: ProjectEntry;
  order: number;
  position: "prev" | "next";
  onFocus: (path: string) => void;
  onMenu: (project: ProjectEntry, x: number, y: number) => void;
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
      <div
        className="project-col-head"
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onMenu(project, ev.clientX, ev.clientY);
        }}
      >
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

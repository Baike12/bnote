import { useEffect, useRef, useState } from "react";
import { homeApi } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { FolderTypeIcon } from "./FileIcon";
import {
  IconArchive,
  IconFoldAll,
  IconNewSession,
  IconOpenProject,
  IconPanelLeft,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSpinner,
  IconTrash,
  IconUnfoldAll,
  IconWorktree,
} from "./ProjectIcons";
import { openProjectAt, openProjectDialog } from "../commands";
import {
  requestNewSession,
  requestSessionRestore,
  setPendingCodeNewSession,
  setPendingCodeSession,
  takePendingCodeNewSession,
  takePendingCodeSession,
} from "../sessionRequest";
import { useCodeStore } from "../store";
import { visibleSessions, useProjectSidebarStore } from "../projectSidebarStore";
import {
  projectRowIntent,
  relativeTime,
  sessionMatches,
  type ProjectGroup,
  type ProjectSessionItem,
} from "../projectGroups";
import { ArchiveModal } from "./ArchiveModal";

/**
 * The leftmost column of code mode: the project-and-session list.
 *
 * One list, not two sections: the open project is not lifted into a separate
 * 「任务列表」 — its row keeps its position and is only marked active, so the
 * pointer never chases a row that jumped. The store stabilizes that order.
 *
 * The top action is a shortcut for the open project's new session; every
 * project row carries the same action. A git project asks first whether the
 * session starts in its checkout or in a new worktree (Zed's choice at
 * new-thread time); the worktree dialog is not an action of its own. Opening a
 * folder is the section header's plus.
 *
 * One project is one folder row plus its sessions: the main repository and its
 * linked worktrees are merged into that one list, so a worktree is not a
 * separate node. A session that ran in a worktree carries the branch mark at
 * the row's end, and its tooltip names the checkout. A group's identity is the
 * **main repository** (`code_git_main_repo`).
 */
export function ProjectsSidebar() {
  const recent = useAppStore((s) => s.recentCodeProjects);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const showToast = useAppStore((s) => s.showToast);
  const setModal = useAppStore((s) => s.setModal);
  const setRecentCodeProjects = useAppStore((s) => s.setRecentCodeProjects);
  const project = useCodeStore((s) => s.project);

  const groups = useProjectSidebarStore((s) => s.groups);
  const loading = useProjectSidebarStore((s) => s.loading);
  const shown = useProjectSidebarStore((s) => s.shown);
  const collapsed = useProjectSidebarStore((s) => s.collapsed);
  const activeSession = useProjectSidebarStore((s) => s.activeSession);
  const running = useProjectSidebarStore((s) => s.running);
  const refresh = useProjectSidebarStore((s) => s.refresh);
  const showMore = useProjectSidebarStore((s) => s.showMore);
  const toggleGroup = useProjectSidebarStore((s) => s.toggleGroup);
  const expandGroup = useProjectSidebarStore((s) => s.expandGroup);
  const setAllCollapsed = useProjectSidebarStore((s) => s.setAllCollapsed);
  const openWorktreeModal = useProjectSidebarStore((s) => s.openWorktreeModal);

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  /**
   * The row whose destructive action is armed (a two-click confirm, ZCode's
   * shape): `archive:<workdir>:<id>` or `remove:<group key>`. Escape or a
   * pointerdown outside the armed button disarms it.
   */
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  /**
   * Where the new-session choice is open: `"top"` for the shortcut, a group
   * key for that project's row. Only a git project opens it — a plain folder
   * has one way to start a session, so it starts directly.
   */
  const [newMenu, setNewMenu] = useState<string | null>(null);

  const currentRoot = project?.root ?? null;
  const currentGroup = groups.find((g) => g.checkouts.some((c) => c.path === currentRoot)) ?? null;
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed[g.key] === true);
  const menuGroup =
    newMenu === null
      ? null
      : newMenu === "top"
        ? currentGroup
        : (groups.find((g) => g.key === newMenu) ?? null);

  // The snapshot is a disk read (identity + worktrees + session records), so it
  // refreshes when the recent list changes — not on every render. The list
  // order is the store's business; opening a project changes the recent list,
  // not the row's position.
  useEffect(() => {
    void refresh(recent);
  }, [recent, refresh]);

  // The search field mounts on demand; focus follows it once.
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  // An armed confirm and an open menu never outlive their context: Escape, or
  // a press anywhere but the thing itself, closes them.
  useEffect(() => {
    if (confirmKey === null && newMenu === null) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element) {
        if (target.closest(".cp-row-action.is-confirming")) return;
        if (target.closest(".cp-newmenu")) return;
      }
      setConfirmKey(null);
      setNewMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConfirmKey(null);
        setNewMenu(null);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [confirmKey, newMenu]);

  const filtering = query.trim() !== "";
  const matches = (item: ProjectSessionItem) => sessionMatches(item, query);

  async function openSession(item: ProjectSessionItem) {
    if (item.workdir === currentRoot) {
      requestSessionRestore(item.id);
      return;
    }
    setPendingCodeSession(item.workdir, item.id);
    const ok = await openProjectAt(item.workdir);
    if (!ok) {
      // Drop the pending pick: the checkout did not open, so the next open of
      // that path must use the default landing spot, not this stale click.
      takePendingCodeSession(item.workdir);
      showToast("会话所在的项目未能打开");
    }
  }

  async function archiveSession(item: ProjectSessionItem) {
    try {
      await homeApi.archiveSession(item.workdir, item.id);
      await refresh(recent);
      showToast("会话已归档");
    } catch (e) {
      showToast(String(e));
    }
  }

  /**
   * Drop a project from the sidebar list. ZCode's soft delete: only the row
   * goes away — the session records stay on disk, so reopening the folder
   * restores the whole history.
   */
  function removeProject(group: ProjectGroup) {
    const drop = new Set([group.key, ...group.checkouts.map((c) => c.path)]);
    setRecentCodeProjects(recent.filter((path) => !drop.has(path)));
    showToast("已从项目列表移除，会话记录保留");
  }

  /**
   * A project row's click: another project becomes the open one (the row is
   * the switcher) and is revealed, so the sessions of a previously folded
   * project are visible the moment it is opened. The open project has nothing
   * to switch to, so its row folds/unfolds the list.
   */
  function activateGroup(group: ProjectGroup) {
    const intent = projectRowIntent(group, currentRoot);
    if (intent.kind === "fold") {
      toggleGroup(group.key);
      return;
    }
    expandGroup(group.key);
    // A failure is reported by openProjectAt (the row keeps its current state).
    void openProjectAt(intent.root);
  }

  /**
   * A project's "new session": the panel is already mounted for the open
   * project (one-shot restart), otherwise the checkout opens with a pending
   * "start fresh" marker that outranks the restore-the-newest rule.
   */
  async function newSessionIn(group: ProjectGroup) {
    if (currentRoot !== null && group.checkouts.some((c) => c.path === currentRoot)) {
      requestNewSession();
      return;
    }
    setPendingCodeNewSession(group.root);
    const ok = await openProjectAt(group.root);
    if (!ok) {
      takePendingCodeNewSession(group.root);
      showToast("项目未能打开");
    }
  }

  /**
   * The new-session action, shared by the top shortcut and the project rows.
   * A git project opens the choice menu (checkout or new worktree); a plain
   * folder has one answer and starts at once.
   */
  function requestNewSessionIn(group: ProjectGroup, anchor: string) {
    if (!group.isGit) {
      setNewMenu(null);
      void newSessionIn(group);
      return;
    }
    setNewMenu((current) => (current === anchor ? null : anchor));
  }

  function chooseNewSession(group: ProjectGroup, kind: "checkout" | "worktree") {
    setNewMenu(null);
    if (kind === "worktree") {
      openWorktreeModal(group.root);
      return;
    }
    void newSessionIn(group);
  }

  /** The two ways a git project starts a session (Zed's new-thread choice). */
  function newSessionMenu(group: ProjectGroup) {
    return (
      <div className="cp-newmenu" role="menu" aria-label={`在 ${group.name} 新建会话`}>
        <button type="button" role="menuitem" onClick={() => chooseNewSession(group, "checkout")}>
          在当前检出中新建会话
        </button>
        <button type="button" role="menuitem" onClick={() => chooseNewSession(group, "worktree")}>
          在新 Worktree 中新建会话…
        </button>
      </div>
    );
  }

  /** One session row; the worktree mark sits before the time (ZCode's shape). */
  function sessionRow(item: ProjectSessionItem) {
    const key = `${item.workdir}:${item.id}`;
    const active = activeSession?.id === item.id && activeSession.workdir === item.workdir;
    const isRunning =
      running !== null && running.workdir === item.workdir && running.id === item.id;
    const armed = confirmKey === `archive:${key}`;
    // The panel may still be appending to a streaming or open transcript;
    // moving that file would split the record (ZCode disables archive while
    // running for the same reason).
    const blocked = active || isRunning;
    return (
      <div
        key={key}
        className={`cp-row cp-session is-indented${active ? " is-active" : ""}`}
        role="button"
        tabIndex={0}
        title={`${item.title}\n${item.workdir}`}
        onClick={() => void openSession(item)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void openSession(item);
          }
        }}
      >
        {isRunning && (
          <span className="cp-running" title="正在生成回复">
            <IconSpinner />
          </span>
        )}
        <span className="cp-label">{item.title}</span>
        {item.isWorktree && (
          <span className="cp-worktree" title={`Worktree ${item.sourceName}`}>
            <IconWorktree />
          </span>
        )}
        <span className="cp-time">{relativeTime(item.updatedAt)}</span>
        <button
          type="button"
          className={`cp-row-action${armed ? " is-confirming" : ""}`}
          disabled={blocked}
          title={
            active
              ? "当前打开的会话不能归档"
              : isRunning
                ? "正在生成回复，结束后再归档"
                : armed
                  ? "再次点击确认归档"
                  : "归档会话"
          }
          onClick={(event) => {
            event.stopPropagation();
            if (blocked) return;
            if (!armed) {
              setConfirmKey(`archive:${key}`);
              return;
            }
            setConfirmKey(null);
            void archiveSession(item);
          }}
        >
          {armed ? <span className="cp-confirm-label">确认</span> : <IconArchive />}
        </button>
      </div>
    );
  }

  /**
   * A project row: the folder, its collapse state and the project actions.
   * Clicking it switches the code area to the project (the open project only
   * folds, see `activateGroup`); the plus starts a session there.
   */
  function projectRow(group: ProjectGroup, current: boolean) {
    const open = filtering || collapsed[group.key] !== true;
    const armed = confirmKey === `remove:${group.key}`;
    return (
      <div
        className={`cp-row cp-project-row${current ? " is-active" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={current ? `${group.key}\n点击收起会话列表` : `${group.key}\n点击切换到该项目`}
        onClick={() => activateGroup(group)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activateGroup(group);
          }
        }}
      >
        <span className="cp-row-icon">
          <FolderTypeIcon open={open} />
        </span>
        <span className="cp-label">{group.name}</span>
        <button
          type="button"
          className="cp-row-action"
          title="在此项目新建会话"
          onClick={(event) => {
            event.stopPropagation();
            requestNewSessionIn(group, group.key);
          }}
        >
          <IconNewSession />
        </button>
        {!current && (
          <button
            type="button"
            className={`cp-row-action${armed ? " is-confirming" : ""}`}
            title={armed ? "再次点击确认从列表移除" : "从项目列表移除（保留会话记录）"}
            onClick={(event) => {
              event.stopPropagation();
              if (!armed) {
                setConfirmKey(`remove:${group.key}`);
                return;
              }
              setConfirmKey(null);
              removeProject(group);
            }}
          >
            {armed ? <span className="cp-confirm-label">确认</span> : <IconTrash />}
          </button>
        )}
      </div>
    );
  }

  return (
    <aside className="code-projects" aria-label="项目与会话">
      <div className="code-projects-top" data-tauri-drag-region="deep">
        <button
          type="button"
          className="cp-icon-btn"
          title="收起项目侧栏 (⌘⌥B)"
          onClick={() => patchSettings({ codeProjectsOpen: false })}
        >
          <IconPanelLeft />
        </button>
      </div>

      <div className="code-projects-body">
        <button
          type="button"
          className="cp-action"
          disabled={!currentGroup}
          title={currentGroup ? "在当前项目新建会话" : "先打开一个项目"}
          onClick={() => {
            if (currentGroup) requestNewSessionIn(currentGroup, "top");
          }}
        >
          <span className="cp-row-icon">
            <IconNewSession />
          </span>
          <span className="cp-label">新建会话</span>
        </button>
        {newMenu === "top" && menuGroup && newSessionMenu(menuGroup)}

        <div className="cp-section">
          <span className="cp-section-title">项目</span>
          <button
            type="button"
            className="cp-icon-btn"
            title="打开项目…"
            onClick={() => void openProjectDialog()}
          >
            <IconOpenProject />
          </button>
          <span className="cp-section-spacer" />
          <button
            type="button"
            className={`cp-icon-btn${searching ? " is-active" : ""}`}
            title="搜索会话"
            onClick={() => {
              setSearching((on) => {
                if (on) setQuery("");
                return !on;
              });
            }}
          >
            <IconSearch />
          </button>
          <button
            type="button"
            className="cp-icon-btn"
            title="已归档（当前项目）"
            disabled={!currentGroup}
            onClick={() => setArchiveOpen(true)}
          >
            <IconArchive />
          </button>
          <button
            type="button"
            className="cp-icon-btn"
            title="刷新"
            onClick={() => void refresh(recent)}
          >
            <IconRefresh />
          </button>
          <button
            type="button"
            className="cp-icon-btn"
            title={allCollapsed ? "展开全部项目" : "收起全部项目"}
            onClick={() => setAllCollapsed(!allCollapsed)}
          >
            {allCollapsed ? <IconUnfoldAll /> : <IconFoldAll />}
          </button>
        </div>

        {searching && (
          <input
            ref={searchRef}
            className="cp-search"
            placeholder="搜索会话…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
          />
        )}

        {groups.map((group) => {
          const all = filtering ? group.sessions.filter(matches) : group.sessions;
          if (filtering && all.length === 0) return null;
          const visible = filtering ? all : visibleSessions(group, shown);
          const open = filtering || collapsed[group.key] !== true;
          const current = group.checkouts.some((checkout) => checkout.path === currentRoot);
          return (
            <div key={group.key} className="cp-project">
              {projectRow(group, current)}
              {newMenu === group.key && newSessionMenu(group)}
              {open && visible.map((item) => sessionRow(item))}
              {open && !filtering && group.sessions.length > visible.length && (
                <button type="button" className="cp-more" onClick={() => showMore(group.key)}>
                  显示更多
                </button>
              )}
              {open && !filtering && current && group.sessions.length === 0 && (
                <p className="cp-empty">这个项目还没有会话</p>
              )}
            </div>
          );
        })}

        {groups.length === 0 && (
          <p className="cp-empty">{loading ? "正在读取项目…" : "还没有打开项目"}</p>
        )}
        {filtering && groups.every((group) => group.sessions.filter(matches).length === 0) && (
          <p className="cp-empty">没有匹配的会话</p>
        )}
      </div>

      <div className="code-projects-foot">
        <span className="cp-avatar">{(project?.name ?? "b").slice(0, 1).toUpperCase()}</span>
        <span className="cp-label" title={project?.root ?? ""}>
          {project?.name ?? "代码模式"}
        </span>
        <button
          type="button"
          className="cp-icon-btn"
          title="设置"
          onClick={() => setModal("settings")}
        >
          <IconSettings />
        </button>
      </div>

      <ArchiveModal open={archiveOpen} onClose={() => setArchiveOpen(false)} group={currentGroup} />
    </aside>
  );
}

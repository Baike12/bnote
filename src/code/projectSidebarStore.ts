/**
 * The project-and-session sidebar's store: the grouped projects, their
 * checkouts and merged sessions, plus the view state (which groups are open,
 * how many sessions are shown, which session is active).
 *
 * Single writer: this store owns the sidebar's data; the agent panel owns the
 * live conversation and only mirrors `activeSession` here so the row can be
 * highlighted. A refresh is a snapshot of the disk (recent list + worktrees +
 * session records), never a second copy of the panel's state — the refresh
 * token drops a stale snapshot that lands after a newer one.
 */
import { create } from "zustand";
import { homeApi, type SavedSessionMeta } from "@/lib/tauri";
import { codeApi } from "./api";
import {
  checkoutsOf,
  groupRecentProjects,
  mergeGroupSessions,
  orderSessions,
  parseCollapsed,
  PROJECT_SESSION_LIMIT,
  SHOW_MORE_STEP,
  stabilizeGroupOrder,
  type CheckoutSessions,
  type ProjectCheckout,
  type ProjectGroup,
  type ProjectSessionItem,
  type RunningSession,
} from "./projectGroups";
import { projectLabel } from "./projectSwitch";

interface ProjectSidebarState {
  groups: ProjectGroup[];
  loading: boolean;
  /** Group key → collapsed. A group starts expanded (absence = false). */
  collapsed: Record<string, boolean>;
  /** Group key → how many sessions are shown (0 = the default limit). */
  shown: Record<string, number>;
  /** The conversation the agent panel is on, for the active row highlight. */
  activeSession: { workdir: string; id: string } | null;
  /**
   * The session the panel is streaming right now: its row leads the group's
   * list and shows the spinner (one busy session per panel, see AgentPanel).
   */
  running: RunningSession | null;
  /**
   * Whether the create-worktree dialog is open. The dialog is mounted by the
   * code layout, not the sidebar, so a command can open it even while the
   * sidebar is collapsed (a one-shot request would be dropped by the unmounted
   * subscriber before it mounts).
   */
  worktreeOpen: boolean;
  /** The repository to create in (null = the open project). */
  worktreeRoot: string | null;

  refresh: (recent: readonly string[]) => Promise<void>;
  toggleGroup: (key: string) => void;
  /**
   * Reveal a group's sessions. Switching into a project must show it: the row
   * the user clicked can be folded, and a folded flag would keep the new
   * project's sessions hidden after the switch.
   */
  expandGroup: (key: string) => void;
  /** Fold or unfold every project row (the section header's toggle-all). */
  setAllCollapsed: (collapsed: boolean) => void;
  showMore: (key: string) => void;
  setActiveSession: (workdir: string, id: string | null) => void;
  setRunningSession: (session: RunningSession | null) => void;
  /** Open the create-worktree dialog; `root` targets a project other than the open one. */
  openWorktreeModal: (root?: string) => void;
  closeWorktreeModal: () => void;
}

/** One refresh generation: a slow snapshot that lands late is dropped. */
let refreshToken = 0;

/** Where the fold state of the project rows survives a restart (ZCode's shape). */
const COLLAPSED_KEY = "bnote-codeProjectsCollapsed";

/**
 * Read the saved fold state. A group whose key is absent stays expanded, so a
 * newly opened project appears open; storage being unavailable (private mode,
 * tests) degrades to the in-memory default instead of failing the module load.
 */
function loadCollapsed(): Record<string, boolean> {
  try {
    return parseCollapsed(localStorage.getItem(COLLAPSED_KEY));
  } catch {
    return {};
  }
}

/** Write only the collapsed groups: expanded is the default, not a stored value. */
function saveCollapsed(collapsed: Record<string, boolean>): void {
  try {
    if (Object.keys(collapsed).length === 0) localStorage.removeItem(COLLAPSED_KEY);
    else localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
  } catch {
    // The fold still works for this run; the next launch starts expanded.
  }
}

/** The repository identity, tolerating a missing directory (still shown). */
async function resolveMainRepo(root: string): Promise<string | null> {
  try {
    return await codeApi.gitMainRepo(root);
  } catch {
    // The project may have been moved or deleted since it was opened; it still
    // belongs in the list (opening it will report the real error), and without
    // an identity it groups by its own path.
    return null;
  }
}

async function loadCheckouts(root: string, isGit: boolean): Promise<ProjectCheckout[]> {
  if (isGit) {
    try {
      return checkoutsOf(await codeApi.worktreeList(root));
    } catch {
      // The repository may have disappeared since it was opened; fall through
      // to the single-checkout shape so the row still opens and reports it.
    }
  }
  return [{ path: root, name: projectLabel(root), branch: null, isMain: true }];
}

async function loadSessions(checkouts: readonly ProjectCheckout[]): Promise<CheckoutSessions[]> {
  const batches = await Promise.all(
    checkouts.map(async (checkout) => ({
      workdir: checkout.path,
      sessions: await homeApi.sessionsList(checkout.path).catch((): SavedSessionMeta[] => []),
    })),
  );
  return batches;
}

export const useProjectSidebarStore = create<ProjectSidebarState>((set, get) => ({
  groups: [],
  loading: false,
  collapsed: loadCollapsed(),
  shown: {},
  activeSession: null,
  running: null,
  worktreeOpen: false,
  worktreeRoot: null,

  refresh: async (recent) => {
    const token = ++refreshToken;
    set({ loading: true });
    const entries = await Promise.all(
      recent.map(async (root) => ({ root, mainRepo: await resolveMainRepo(root) })),
    );
    if (token !== refreshToken) return;
    const heads = groupRecentProjects(entries);
    const running = get().running;
    const groups = await Promise.all(
      heads.map(async (head) => {
        const checkouts = await loadCheckouts(head.root, head.isGit);
        const sessions = mergeGroupSessions(checkouts, await loadSessions(checkouts), 0, running);
        return { ...head, checkouts, sessions };
      }),
    );
    if (token !== refreshToken) return;
    // The rows keep their positions: a refresh follows the recent list's MRU
    // order, but a project that is already listed must not jump because it was
    // opened. Only a project seen for the first time is inserted (on top).
    set({ groups: stabilizeGroupOrder(get().groups, groups), loading: false });
  },

  toggleGroup: (key) => {
    const collapsed = { ...get().collapsed };
    if (collapsed[key]) delete collapsed[key];
    else collapsed[key] = true;
    saveCollapsed(collapsed);
    set({ collapsed });
  },

  expandGroup: (key) => {
    const collapsed = get().collapsed;
    // Expanded is the default and the persisted map only stores `true` keys, so
    // an already-expanded group is not a write (the map identity stays put).
    if (!collapsed[key]) return;
    const next = { ...collapsed };
    delete next[key];
    saveCollapsed(next);
    set({ collapsed: next });
  },

  setAllCollapsed: (collapsed) => {
    const map: Record<string, boolean> = {};
    if (collapsed) for (const group of get().groups) map[group.key] = true;
    saveCollapsed(map);
    set({ collapsed: map });
  },

  showMore: (key) =>
    set((state) => {
      const current = state.groups.find((g) => g.key === key);
      const before = state.shown[key] ?? 0;
      // Clamp to the real list so the per-group map cannot drift from the data.
      const capped = current
        ? Math.min(before + SHOW_MORE_STEP, current.sessions.length)
        : before + SHOW_MORE_STEP;
      return { shown: { ...state.shown, [key]: capped } };
    }),

  setActiveSession: (workdir, id) => {
    const current = get().activeSession;
    if (id === null) {
      if (current?.workdir === workdir) set({ activeSession: null });
      return;
    }
    if (current?.workdir === workdir && current.id === id) return;
    set({ activeSession: { workdir, id } });
  },

  setRunningSession: (session) => {
    const current = get().running;
    if (
      current === session ||
      (current !== null &&
        session !== null &&
        current.workdir === session.workdir &&
        current.id === session.id)
    ) {
      return;
    }
    // Re-ordering in place is enough: the rows already carry `updatedAt`, so a
    // stopped session falls back to its time position without a disk read.
    set((state) => ({
      running: session,
      groups: state.groups.map((group) => ({
        ...group,
        sessions: orderSessions(group.sessions, session),
      })),
    }));
  },

  openWorktreeModal: (root) => set({ worktreeOpen: true, worktreeRoot: root ?? null }),
  closeWorktreeModal: () => set({ worktreeOpen: false, worktreeRoot: null }),
}));

/**
 * The sessions a group shows right now: the default limit, raised by each
 * "show more" click (the map stores the absolute count, clamped by the store).
 * Every project uses the same limit — the open project is not a special case.
 */
export function visibleSessions(
  group: ProjectGroup,
  shown: Record<string, number>,
  defaultLimit = PROJECT_SESSION_LIMIT,
): ProjectSessionItem[] {
  return group.sessions.slice(0, shown[group.key] ?? defaultLimit);
}

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
  parsePinned,
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
  /**
   * The one project whose sessions are open for browsing (null = every
   * unpinned folder is folded). It follows the open project by default and is
   * moved by the keyboard; pinned projects are open regardless.
   */
  expandedGroup: string | null;
  /** Pinned group keys, newest pin first. Pinned projects lead the list and stay open. */
  pinned: string[];
  /**
   * One-shot "focus the session list" request (the `code.focus-sessions`
   * command). The sidebar consumes the newest seq and leaves it in place, so a
   * remount must not replay an old request.
   */
  sessionsFocus: number;
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
  /**
   * Re-read the one group whose checkout is `workdir`. The agent panel calls
   * this after every session-record write: a new session only enters the list
   * once its first message created the record, and the sidebar's snapshot
   * predates that write.
   */
  refreshGroup: (workdir: string) => Promise<void>;
  /** Open this folder (folding the previously open one), or fold it when it is the open one. */
  toggleGroup: (key: string) => void;
  /**
   * Reveal a group's sessions. Switching into a project must show it: the
   * folder the user came from may be the open one, and leaving it folded
   * would keep the new project's sessions hidden after the switch.
   */
  expandGroup: (key: string) => void;
  /** Fold this folder if it is the expanded one (the keyboard's "leave" action). */
  foldGroup: (key: string) => void;
  /** Pin a project to the top (and keep its folder open), or unpin it. */
  togglePin: (key: string) => void;
  /** Ask the mounted sidebar to take the keyboard and land on the active session. */
  requestSessionsFocus: () => void;
  showMore: (key: string) => void;
  setActiveSession: (workdir: string, id: string | null) => void;
  setRunningSession: (session: RunningSession | null) => void;
  /** Open the create-worktree dialog; `root` targets a project other than the open one. */
  openWorktreeModal: (root?: string) => void;
  closeWorktreeModal: () => void;
}

/**
 * The snapshot writer's queue. Every write to `groups` — a full refresh or one
 * group's re-read — runs after the previous one finished, so a slower older
 * disk read can never overwrite a newer snapshot, and the two kinds cannot
 * disagree about one group. The queue replaces the old refresh token.
 */
let writeChain: Promise<void> = Promise.resolve();

function serialized(task: () => Promise<void>): Promise<void> {
  const next = writeChain.then(task, task);
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * The newest full refresh: only it clears `loading`, so a refresh queued
 * behind another one does not flash the empty state in between.
 */
let refreshGeneration = 0;

/** Where the pinned projects survive a restart. */
const PINNED_KEY = "bnote-codeProjectsPinned";

function loadPinned(): string[] {
  try {
    return parsePinned(localStorage.getItem(PINNED_KEY));
  } catch {
    // Storage unavailable (private mode, tests): nothing is pinned this run.
    return [];
  }
}

function savePinned(pinned: readonly string[]): void {
  try {
    if (pinned.length === 0) localStorage.removeItem(PINNED_KEY);
    else localStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
  } catch {
    // The pin still applies for this run; the next launch starts unpinned.
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
  expandedGroup: null,
  pinned: loadPinned(),
  sessionsFocus: 0,
  shown: {},
  activeSession: null,
  running: null,
  worktreeOpen: false,
  worktreeRoot: null,

  refresh: (recent) => {
    const generation = ++refreshGeneration;
    set({ loading: true });
    return serialized(async () => {
      try {
        const entries = await Promise.all(
          recent.map(async (root) => ({ root, mainRepo: await resolveMainRepo(root) })),
        );
        const heads = groupRecentProjects(entries);
        const running = get().running;
        const groups = await Promise.all(
          heads.map(async (head) => {
            const checkouts = await loadCheckouts(head.root, head.isGit);
            const sessions = mergeGroupSessions(
              checkouts,
              await loadSessions(checkouts),
              0,
              running,
            );
            return { ...head, checkouts, sessions };
          }),
        );
        // The rows keep their positions: a refresh follows the recent list's MRU
        // order, but a project that is already listed must not jump because it was
        // opened. Only a project seen for the first time is inserted (on top).
        set({ groups: stabilizeGroupOrder(get().groups, groups) });
      } finally {
        if (generation === refreshGeneration) set({ loading: false });
      }
    });
  },

  refreshGroup: (workdir) =>
    serialized(async () => {
      // Resolve the group at run time: a full refresh may have replaced the
      // list while this read was queued, and the newest list is the one to
      // extend. An unknown checkout is dropped — the next full refresh is the
      // one that can add its project.
      const group = get().groups.find((g) => g.checkouts.some((c) => c.path === workdir));
      if (!group) return;
      const batches = await loadSessions(group.checkouts);
      // The row may have left the list while the disk was read (the project
      // was removed); writing it back would resurrect it.
      const live = get().groups.find((g) => g.key === group.key);
      if (!live) return;
      const sessions = mergeGroupSessions(live.checkouts, batches, 0, get().running);
      set((state) => ({
        groups: state.groups.map((g) => (g.key === group.key ? { ...g, sessions } : g)),
      }));
    }),

  toggleGroup: (key) => {
    // A pinned project is always open (the pin is the user's shortcut into
    // its sessions); folding it is not a state the list can show.
    if (get().pinned.includes(key)) return;
    set({ expandedGroup: get().expandedGroup === key ? null : key });
  },

  expandGroup: (key) => {
    // Pinned folders are already open, and an already-open folder is not a
    // write (the state keeps its identity, so subscribers do not re-render).
    if (get().pinned.includes(key) || get().expandedGroup === key) return;
    set({ expandedGroup: key });
  },

  foldGroup: (key) => {
    if (get().expandedGroup !== key) return;
    set({ expandedGroup: null });
  },

  togglePin: (key) => {
    const current = get().pinned;
    // The newest pin leads the pinned block, matching "pin puts it on top".
    const next = current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [key, ...current];
    savePinned(next);
    set({ pinned: next });
  },

  requestSessionsFocus: () => set((state) => ({ sessionsFocus: state.sessionsFocus + 1 })),

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

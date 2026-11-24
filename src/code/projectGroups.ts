/**
 * The project-and-session sidebar's model: how the recently opened projects
 * become groups, how a group's checkouts and sessions are merged, and where a
 * new worktree lands.
 *
 * Pure on purpose (node tests, no DOM): the sidebar is only the wiring. The
 * repository identity comes from the backend (`code_git_main_repo`), so the
 * frontend never parses a `.git` file — one owner for that rule. A linked
 * worktree therefore groups under its main repository, which is what makes
 * "one project, many worktrees" read as a single node.
 */
import type { WorktreeInfo } from "./types";
import type { SavedSessionMeta } from "@/lib/tauri";

/** Default cap of `mergeGroupSessions` (the store passes 0 = keep all). */
export const GROUP_SESSION_LIMIT = 20;
/** Sessions listed for a project before "show more". */
export const PROJECT_SESSION_LIMIT = 5;
/** How many rows each "show more" adds. */
export const SHOW_MORE_STEP = 10;

/**
 * The row's relative time, ZCode's vocabulary: 刚刚 / N 分钟 / N 小时 / N 天.
 * A future timestamp (a clock that moved backwards) reads as 刚刚 instead of a
 * negative age.
 */
export function relativeTime(updatedAt: number, now: number = Date.now()): string {
  if (!updatedAt) return "";
  const age = now - updatedAt;
  if (!Number.isFinite(age) || age < 60_000) return "刚刚";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/** Whether a session matches the sidebar's search text (title, path or badge). */
export function sessionMatches(
  item: { title: string; workdir: string; sourceName: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.title.toLowerCase().includes(q) ||
    item.workdir.toLowerCase().includes(q) ||
    item.sourceName.toLowerCase().includes(q)
  );
}

/** A recently opened project plus its repository identity. */
export interface RecentProjectEntry {
  /** The path the user opened (may be a linked worktree). */
  root: string;
  /** `code_git_main_repo(root)`: the main worktree, or null outside a repository. */
  mainRepo: string | null;
}

/** One checkout of a project: the main repository or a linked worktree. */
export interface ProjectCheckout {
  path: string;
  name: string;
  branch: string | null;
  isMain: boolean;
}

/** One project node of the sidebar. */
export interface ProjectGroup {
  /** Group identity: the main repository path, or the project path when not git. */
  key: string;
  /** Display name (the main repository's directory name). */
  name: string;
  /** Whether the group belongs to a git repository (sessions can fan out over worktrees). */
  isGit: boolean;
  /** The checkout to open for this group (the main repository / the project itself). */
  root: string;
  /** Checkouts, main first; a non-git group has exactly one. */
  checkouts: ProjectCheckout[];
  /** Merged sessions across all checkouts, newest first. */
  sessions: ProjectSessionItem[];
}

/** One session row of a group. */
export interface ProjectSessionItem {
  id: string;
  title: string;
  updatedAt: number;
  /** The checkout this session ran in. */
  workdir: string;
  /** `主仓库` for the main checkout, the worktree directory name otherwise. */
  sourceName: string;
  /** Whether the session ran in a linked worktree (drives the badge). */
  isWorktree: boolean;
}

/** What clicking a project row does: fold the open project, or open another. */
export type ProjectRowIntent = { kind: "fold" } | { kind: "open"; root: string };

/**
 * The project row is the project switcher: the group holding the open project
 * only folds/unfolds its session list (there is nothing to switch to), any
 * other group opens its checkout in the code area. The target is the group's
 * canonical checkout (`root`, the main repository), never a worktree the user
 * happened to open last.
 */
export function projectRowIntent(
  group: Pick<ProjectGroup, "root" | "checkouts">,
  currentRoot: string | null,
): ProjectRowIntent {
  const isCurrent =
    currentRoot !== null && group.checkouts.some((checkout) => checkout.path === currentRoot);
  return isCurrent ? { kind: "fold" } : { kind: "open", root: group.root };
}

/**
 * Read the persisted pin list (group keys in pin order). Non-string entries
 * and duplicates are dropped, so a corrupt value degrades to "nothing pinned"
 * instead of failing the module load.
 */
export function parsePinned(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string" && entry && !out.includes(entry)) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Float pinned projects to the top. The pin list is the desired order (the
 * newest pin first, `togglePin` prepends); every other project keeps its
 * stabilized position. A pinned key that is not in the list (a removed
 * project that was never reopened) simply has no row to move.
 */
export function orderPinnedGroups<T extends { key: string }>(
  groups: readonly T[],
  pinned: readonly string[],
): T[] {
  if (pinned.length === 0) return [...groups];
  const position = new Map(pinned.map((key, index) => [key, index]));
  const rank = (group: T): number => position.get(group.key) ?? Number.MAX_SAFE_INTEGER;
  // Stable sort: pinned groups by pin order, everything else in list order.
  return [...groups].sort((a, b) => rank(a) - rank(b));
}

/**
 * Whether a project's session folder is open.
 *
 * The list is an accordion: one folder is open for browsing at a time
 * (`expandedKey`, normally the open project) and pinned projects are always
 * open — they are the user's shortcuts. A search opens every group that has a
 * match, because a match behind a fold would be a dead search.
 */
export function groupOpen(input: {
  key: string;
  pinned: readonly string[];
  expandedKey: string | null;
  filtering: boolean;
}): boolean {
  if (input.filtering) return true;
  if (input.pinned.includes(input.key)) return true;
  return input.key === input.expandedKey;
}

/**
 * The expanded folder after the keyboard moves from one row to another:
 * leaving a folder's block folds it (the accordion closes behind the
 * keyboard), while stepping inside the same folder keeps it open. `from` is
 * the group of the row being left, `to` the group of the destination and
 * `keep` the folder that holds the open session: that one is where the user
 * is working, so walking the list never folds it away.
 */
export function foldLeavingGroup(
  expandedKey: string | null,
  fromGroup: string | null,
  toGroup: string,
  keepGroup: string | null,
): string | null {
  if (expandedKey === null || fromGroup === null || fromGroup === toGroup) return expandedKey;
  if (expandedKey !== fromGroup) return expandedKey;
  return fromGroup === keepGroup ? expandedKey : null;
}

/**
 * Whether a worktree removal failure is git refusing a dirty checkout (the
 * caller may retry with `--force`). Matched by message because the backend
 * forwards git's stderr verbatim.
 */
export function isDirtyRefusal(message: string | null): boolean {
  if (!message) return false;
  return (
    message.includes("use --force") ||
    message.includes("contains modified or untracked") ||
    message.includes("is dirty")
  );
}

/** The directory name of a path (the same rule as `projectLabel`). */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return path;
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

/**
 * Group the recent projects by repository identity.
 *
 * Order: first occurrence in `recent` (the list is already MRU), so a group
 * keeps the position of its most recently opened checkout. Duplicate paths and
 * a main repository that also appears as its own entry collapse into one
 * group.
 */
export function groupRecentProjects(
  recent: readonly RecentProjectEntry[],
): Omit<ProjectGroup, "checkouts" | "sessions">[] {
  const out: Omit<ProjectGroup, "checkouts" | "sessions">[] = [];
  const seen = new Set<string>();
  for (const entry of recent) {
    const key = entry.mainRepo ?? entry.root;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      name: baseName(key),
      isGit: entry.mainRepo !== null,
      root: key,
    });
  }
  return out;
}

/**
 * Keep the project list's order stable across refreshes.
 *
 * Opening a project rewrites the recent list's MRU order; the sidebar must not
 * follow it — a row that jumps because it was clicked is a mis-click waiting to
 * happen. So every project already listed keeps its position, a project seen
 * for the first time is inserted on top (it must be visible), and a project
 * that left the recent list disappears.
 */
export function stabilizeGroupOrder<T extends { key: string }>(
  previous: readonly T[],
  next: readonly T[],
): T[] {
  const position = new Map(previous.map((group, index) => [group.key, index]));
  const known = next
    .filter((group) => position.has(group.key))
    .sort((a, b) => (position.get(a.key) ?? 0) - (position.get(b.key) ?? 0));
  const fresh = next.filter((group) => !position.has(group.key));
  return [...fresh, ...known];
}

/** The worktrees of a group as sidebar checkouts (main first). */
export function checkoutsOf(list: readonly WorktreeInfo[]): ProjectCheckout[] {
  const checkouts = list.map((w) => ({
    path: w.path,
    name: w.name,
    branch: w.branch,
    isMain: w.isMain,
  }));
  checkouts.sort((a, b) => Number(b.isMain) - Number(a.isMain));
  return checkouts;
}

/** One checkout's saved sessions (the `agent_home_sessions_list` result). */
export interface CheckoutSessions {
  workdir: string;
  sessions: readonly SavedSessionMeta[];
}

/** The session the agent panel is streaming right now (one per panel). */
export interface RunningSession {
  workdir: string;
  id: string;
}

/**
 * Order a group's rows: the streaming session first (ZCode's running-first
 * order — its `updatedAt` lags while it is being written), then newest first.
 * Stable for a list that is already newest-first, so a stop restores the time
 * order without another disk read.
 */
export function orderSessions(
  items: readonly ProjectSessionItem[],
  running: RunningSession | null,
): ProjectSessionItem[] {
  const isRunning = (item: ProjectSessionItem) =>
    running !== null && running.workdir === item.workdir && running.id === item.id;
  return [...items].sort((a, b) => {
    const ra = isRunning(a);
    const rb = isRunning(b);
    if (ra !== rb) return ra ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * Merge the sessions of a group's checkouts into one ordered list.
 *
 * A session is keyed by `workdir + id` (the same id can exist in another
 * checkout's project directory only if the transcripts were copied, and then
 * they are still two records). Titles come from the backend's summarizer.
 */
export function mergeGroupSessions(
  checkouts: readonly ProjectCheckout[],
  batches: readonly CheckoutSessions[],
  limit = GROUP_SESSION_LIMIT,
  running: RunningSession | null = null,
): ProjectSessionItem[] {
  const byPath = new Map(checkouts.map((c) => [c.path, c]));
  const items: ProjectSessionItem[] = [];
  for (const batch of batches) {
    const checkout = byPath.get(batch.workdir);
    if (!checkout) continue;
    for (const session of batch.sessions) {
      items.push({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        workdir: checkout.path,
        sourceName: checkout.isMain ? "主仓库" : checkout.name,
        isWorktree: !checkout.isMain,
      });
    }
  }
  const ordered = orderSessions(items, running);
  return limit > 0 ? ordered.slice(0, limit) : ordered;
}

/**
 * Where a worktree of `mainRepo` is created: the sibling-directory rule
 * `<main repo parent>/worktrees/<main repo name>` (mirrors the backend's
 * `worktrees_dir`, so the modal can show the path before the call).
 */
export function worktreesDirFor(mainRepo: string): string {
  const trimmed = mainRepo.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  // A root-level repository ("/demo") has no parent component.
  const parent = at <= 0 ? "" : trimmed.slice(0, at);
  return `${parent}/worktrees/${baseName(trimmed)}`;
}

/** The full path a worktree with this name would take. */
export function worktreePathFor(mainRepo: string, name: string): string {
  return `${worktreesDirFor(mainRepo)}/${name}`;
}

/** Word lists of the random worktree name (Zed's adjective-noun shape). */
const ADJECTIVES = [
  "calm",
  "bright",
  "swift",
  "quiet",
  "bold",
  "gentle",
  "crisp",
  "amber",
  "sunny",
  "vivid",
  "noble",
  "lucid",
  "merry",
  "solid",
  "tidy",
  "warm",
];
const NOUNS = [
  "river",
  "harbor",
  "meadow",
  "summit",
  "orbit",
  "ember",
  "willow",
  "canyon",
  "signal",
  "garden",
  "thicket",
  "bridge",
  "lagoon",
  "ridge",
  "cove",
  "field",
];

/**
 * A random `adjective-noun` worktree name that no existing checkout uses.
 * `random` is injectable so the test can pin the sequence.
 */
export function randomWorktreeName(
  existing: readonly string[],
  random: () => number = Math.random,
): string {
  const taken = new Set(existing);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length) % ADJECTIVES.length];
    const noun = NOUNS[Math.floor(random() * NOUNS.length) % NOUNS.length];
    const name = `${adjective}-${noun}`;
    if (!taken.has(name)) return name;
  }
  // Deterministic fallback: a numeric suffix probes until a free slot is found.
  let index = 1;
  while (taken.has(`worktree-${index}`)) index += 1;
  return `worktree-${index}`;
}

/**
 * Whether a worktree name can be submitted: a single safe path segment (the
 * backend enforces the same rule; this only keeps the button honest).
 */
export function validWorktreeName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 80 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..") &&
    !name.startsWith(".") &&
    name.trim() === name &&
    !/[\u0000-\u001f]/.test(name)
  );
}

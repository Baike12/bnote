import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSessionMeta } from "@/lib/tauri";
import type { ProjectGroup, ProjectSessionItem } from "./projectGroups";

/**
 * The sidebar store's view state. The fold map is the one piece the user edits
 * directly, and it has one writer (this store) so the row's `aria-expanded`,
 * the section's toggle-all and the persisted copy cannot disagree.
 *
 * The session list has one writer too: the agent panel announces each record
 * write, and the store re-reads exactly the announced group.
 */

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

/** The disk the mocked home API exposes (the record directory of each project). */
const disk = vi.hoisted(() => ({ sessions: new Map<string, unknown[]>(), reads: [] as string[] }));

vi.mock("@/lib/tauri", () => ({
  homeApi: {
    sessionsList: async (workdir: string) => {
      disk.reads.push(workdir);
      return disk.sessions.get(workdir) ?? [];
    },
  },
}));

const { useProjectSidebarStore } = await import("./projectSidebarStore");

const PINNED_KEY = "bnote-codeProjectsPinned";

beforeEach(() => {
  storage.clear();
  disk.sessions.clear();
  disk.reads.length = 0;
  useProjectSidebarStore.setState({
    expandedGroup: null,
    pinned: [],
    sessionsFocus: 0,
    groups: [],
  });
});

const meta = (id: string, updatedAt: number): SavedSessionMeta => ({
  id,
  title: id,
  parent: null,
  basedOn: null,
  forkAt: null,
  createdAt: updatedAt,
  updatedAt,
  bytes: 1,
});

const item = (id: string, updatedAt: number): ProjectSessionItem => ({
  id,
  title: id,
  updatedAt,
  workdir: "/a",
  sourceName: "主仓库",
  isWorktree: false,
});

const group = (path: string, sessions: ProjectSessionItem[]): ProjectGroup => ({
  key: path,
  name: path,
  isGit: false,
  root: path,
  checkouts: [{ path, name: path, branch: null, isMain: true }],
  sessions,
});

describe("expanding and folding a project folder", () => {
  it("opens one folder at a time (the accordion)", () => {
    useProjectSidebarStore.getState().expandGroup("/a");
    expect(useProjectSidebarStore.getState().expandedGroup).toBe("/a");
    useProjectSidebarStore.getState().expandGroup("/b");
    expect(useProjectSidebarStore.getState().expandedGroup).toBe("/b");
  });

  it("toggle folds the open folder, and opens another one", () => {
    useProjectSidebarStore.getState().toggleGroup("/a");
    expect(useProjectSidebarStore.getState().expandedGroup).toBe("/a");
    useProjectSidebarStore.getState().toggleGroup("/a");
    expect(useProjectSidebarStore.getState().expandedGroup).toBeNull();
    useProjectSidebarStore.getState().toggleGroup("/b");
    expect(useProjectSidebarStore.getState().expandedGroup).toBe("/b");
  });

  it("foldGroup closes only the folder it names", () => {
    useProjectSidebarStore.getState().expandGroup("/b");
    useProjectSidebarStore.getState().foldGroup("/a");
    expect(useProjectSidebarStore.getState().expandedGroup).toBe("/b");
    useProjectSidebarStore.getState().foldGroup("/b");
    expect(useProjectSidebarStore.getState().expandedGroup).toBeNull();
  });

  it("an already expanded folder is not a write", () => {
    const state = useProjectSidebarStore.getState();
    useProjectSidebarStore.getState().expandGroup("/a");
    expect(useProjectSidebarStore.getState()).not.toBe(state);
    const after = useProjectSidebarStore.getState();
    useProjectSidebarStore.getState().expandGroup("/a");
    expect(useProjectSidebarStore.getState()).toBe(after);
  });
});

describe("togglePin", () => {
  it("puts the newest pin first and persists the list", () => {
    useProjectSidebarStore.getState().togglePin("/a");
    useProjectSidebarStore.getState().togglePin("/b");
    expect(useProjectSidebarStore.getState().pinned).toEqual(["/b", "/a"]);
    expect(JSON.parse(storage.get(PINNED_KEY) ?? "[]")).toEqual(["/b", "/a"]);
  });

  it("pinning an already pinned project unpins it", () => {
    useProjectSidebarStore.getState().togglePin("/a");
    useProjectSidebarStore.getState().togglePin("/a");
    expect(useProjectSidebarStore.getState().pinned).toEqual([]);
    expect(storage.has(PINNED_KEY)).toBe(false);
  });

  it("a pinned project's folder cannot be folded", () => {
    useProjectSidebarStore.getState().togglePin("/a");
    useProjectSidebarStore.getState().toggleGroup("/a");
    expect(useProjectSidebarStore.getState().expandedGroup).toBeNull();
  });
});

describe("requestSessionsFocus", () => {
  it("bumps a one-shot request the sidebar consumes by seq", () => {
    useProjectSidebarStore.getState().requestSessionsFocus();
    expect(useProjectSidebarStore.getState().sessionsFocus).toBe(1);
    useProjectSidebarStore.getState().requestSessionsFocus();
    expect(useProjectSidebarStore.getState().sessionsFocus).toBe(2);
  });
});

describe("refreshGroup", () => {
  it("re-reads only the announced project and shows its new session first", async () => {
    const untouched = group("/b", [item("b1", 1)]);
    useProjectSidebarStore.setState({
      groups: [group("/a", [item("a1", 1)]), untouched],
    });
    disk.sessions.set("/a", [meta("a1", 1), meta("a2", 2)]);

    await useProjectSidebarStore.getState().refreshGroup("/a");

    expect(disk.reads).toEqual(["/a"]);
    const groups = useProjectSidebarStore.getState().groups;
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a2", "a1"]);
    // The other project is not replaced: a record write in one project is not
    // a full snapshot.
    expect(groups[1]).toBe(untouched);
  });

  it("an auxiliary session gets no row of its own", async () => {
    // It lives inside the session it was forked from (the header picker);
    // listed on its own it would duplicate that entry and take a visible slot.
    useProjectSidebarStore.setState({ groups: [group("/a", [])] });
    disk.sessions.set("/a", [
      meta("main", 1),
      { ...meta("fork", 3), parent: "main", basedOn: "基于这条消息" },
      { ...meta("legacy", 2), basedOn: "旧记录" },
    ]);

    await useProjectSidebarStore.getState().refreshGroup("/a");

    expect(useProjectSidebarStore.getState().groups[0].sessions.map((s) => s.id)).toEqual(["main"]);
  });

  it("ignores a workdir that is not in the list", async () => {
    useProjectSidebarStore.setState({ groups: [group("/a", [])] });
    await useProjectSidebarStore.getState().refreshGroup("/elsewhere");
    expect(disk.reads).toEqual([]);
  });

  it("two queued reads of one group run in order", async () => {
    useProjectSidebarStore.setState({ groups: [group("/a", [])] });
    disk.sessions.set("/a", [meta("a1", 1)]);
    const first = useProjectSidebarStore.getState().refreshGroup("/a");
    const second = useProjectSidebarStore.getState().refreshGroup("/a");
    await Promise.all([first, second]);
    // Two reads, both after the other finished: the disk is read in order, and
    // the final list is the newest snapshot.
    expect(disk.reads).toEqual(["/a", "/a"]);
    expect(useProjectSidebarStore.getState().groups[0].sessions.map((s) => s.id)).toEqual(["a1"]);
  });
});

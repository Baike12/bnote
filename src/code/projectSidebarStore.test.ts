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

const COLLAPSED_KEY = "bnote-codeProjectsCollapsed";

beforeEach(() => {
  storage.clear();
  disk.sessions.clear();
  disk.reads.length = 0;
  useProjectSidebarStore.setState({ collapsed: {}, groups: [] });
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

describe("expandGroup", () => {
  it("reveals one folded group and keeps the rest folded", () => {
    useProjectSidebarStore.setState({ collapsed: { "/a": true, "/b": true } });
    useProjectSidebarStore.getState().expandGroup("/a");
    expect(useProjectSidebarStore.getState().collapsed).toEqual({ "/b": true });
    expect(JSON.parse(storage.get(COLLAPSED_KEY) ?? "{}")).toEqual({ "/b": true });
  });

  it("an already expanded group is not a write", () => {
    const collapsed = { "/a": true };
    useProjectSidebarStore.setState({ collapsed });
    useProjectSidebarStore.getState().expandGroup("/c");
    expect(useProjectSidebarStore.getState().collapsed).toBe(collapsed);
    expect(storage.has(COLLAPSED_KEY)).toBe(false);
  });

  it("expanding the last folded group clears the persisted map", () => {
    useProjectSidebarStore.setState({ collapsed: { "/a": true } });
    useProjectSidebarStore.getState().expandGroup("/a");
    expect(useProjectSidebarStore.getState().collapsed).toEqual({});
    expect(storage.has(COLLAPSED_KEY)).toBe(false);
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

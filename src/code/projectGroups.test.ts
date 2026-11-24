import { describe, expect, it } from "vitest";
import {
  checkoutsOf,
  groupOpen,
  GROUP_SESSION_LIMIT,
  groupRecentProjects,
  isDirtyRefusal,
  mergeGroupSessions,
  orderPinnedGroups,
  parseCollapsed,
  parsePinned,
  projectRowIntent,
  randomWorktreeName,
  relativeTime,
  sessionMatches,
  stabilizeGroupOrder,
  validWorktreeName,
  worktreePathFor,
  worktreesDirFor,
  type ProjectCheckout,
} from "./projectGroups";
import type { SavedSessionMeta } from "@/lib/tauri";
import type { WorktreeInfo } from "./types";

function session(id: string, updatedAt: number, title = id): SavedSessionMeta {
  return {
    id,
    title,
    parent: null,
    basedOn: null,
    forkAt: null,
    createdAt: updatedAt - 1000,
    updatedAt,
    bytes: 10,
  };
}

function worktree(path: string, isMain: boolean, branch: string | null): WorktreeInfo {
  return {
    path,
    name: path.split("/").pop() ?? path,
    branch,
    isMain,
    isDetached: branch === null,
  };
}

describe("groupRecentProjects", () => {
  it("groups a linked worktree under its main repository", () => {
    const groups = groupRecentProjects([
      { root: "/repos/worktrees/demo/fix", mainRepo: "/repos/demo" },
      { root: "/repos/demo", mainRepo: "/repos/demo" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("/repos/demo");
    expect(groups[0].name).toBe("demo");
    expect(groups[0].root).toBe("/repos/demo");
    expect(groups[0].isGit).toBe(true);
  });

  it("keeps the first (most recent) position and drops duplicates", () => {
    const groups = groupRecentProjects([
      { root: "/a/one", mainRepo: null },
      { root: "/a/two", mainRepo: null },
      { root: "/a/one", mainRepo: null },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["/a/one", "/a/two"]);
  });

  it("a non-repository groups by its own path", () => {
    const groups = groupRecentProjects([{ root: "/tmp/notes", mainRepo: null }]);
    expect(groups[0]).toMatchObject({ key: "/tmp/notes", name: "notes", isGit: false });
  });
});

describe("checkoutsOf", () => {
  it("puts the main worktree first", () => {
    const checkouts = checkoutsOf([
      worktree("/repos/worktrees/demo/fix", false, "fix"),
      worktree("/repos/demo", true, "main"),
    ]);
    expect(checkouts.map((c) => c.path)).toEqual(["/repos/demo", "/repos/worktrees/demo/fix"]);
    expect(checkouts[0].isMain).toBe(true);
  });
});

describe("mergeGroupSessions", () => {
  const checkouts: ProjectCheckout[] = [
    { path: "/repos/demo", name: "demo", branch: "main", isMain: true },
    { path: "/repos/worktrees/demo/fix", name: "fix", branch: "fix", isMain: false },
  ];

  it("merges the checkouts newest first and badges the worktree rows", () => {
    const items = mergeGroupSessions(checkouts, [
      { workdir: "/repos/demo", sessions: [session("main-1", 100)] },
      { workdir: "/repos/worktrees/demo/fix", sessions: [session("wt-1", 300)] },
    ]);
    expect(items.map((i) => i.id)).toEqual(["wt-1", "main-1"]);
    expect(items[0]).toMatchObject({
      sourceName: "fix",
      isWorktree: true,
      workdir: "/repos/worktrees/demo/fix",
    });
    expect(items[1]).toMatchObject({ sourceName: "主仓库", isWorktree: false });
  });

  it("ignores batches of checkouts outside the group", () => {
    const items = mergeGroupSessions(checkouts, [
      { workdir: "/repos/other", sessions: [session("x", 999)] },
    ]);
    expect(items).toEqual([]);
  });

  it("applies the limit after sorting, not per batch", () => {
    const items = mergeGroupSessions(
      checkouts,
      [
        { workdir: "/repos/demo", sessions: [session("a", 1), session("b", 3)] },
        { workdir: "/repos/worktrees/demo/fix", sessions: [session("c", 2), session("d", 4)] },
      ],
      2,
    );
    expect(items.map((i) => i.id)).toEqual(["d", "b"]);
  });

  it("the default limit matches the sidebar constant", () => {
    const many = Array.from({ length: GROUP_SESSION_LIMIT + 5 }, (_, i) => session(`s${i}`, i));
    const items = mergeGroupSessions(checkouts, [{ workdir: "/repos/demo", sessions: many }]);
    expect(items).toHaveLength(GROUP_SESSION_LIMIT);
  });

  it("puts the streaming session first even when a newer record outranks it", () => {
    const batches = [
      {
        workdir: "/repos/demo",
        sessions: [session("older", 100), session("newer", 300)],
      },
    ];
    const items = mergeGroupSessions(checkouts, batches, 0, {
      workdir: "/repos/demo",
      id: "older",
    });
    expect(items.map((i) => i.id)).toEqual(["older", "newer"]);
  });

  it("applies the running-first order before the limit", () => {
    const many = Array.from({ length: 6 }, (_, i) => session(`s${i}`, i));
    const items = mergeGroupSessions(checkouts, [{ workdir: "/repos/demo", sessions: many }], 2, {
      workdir: "/repos/demo",
      id: "s0",
    });
    expect(items.map((i) => i.id)).toEqual(["s0", "s5"]);
  });
});

describe("stabilizeGroupOrder", () => {
  it("keeps a listed project where it was when the recent order changes", () => {
    const previous = [{ key: "/a" }, { key: "/b" }, { key: "/c" }];
    const next = [{ key: "/c" }, { key: "/a" }, { key: "/b" }];
    expect(stabilizeGroupOrder(previous, next).map((g) => g.key)).toEqual(["/a", "/b", "/c"]);
  });

  it("inserts a project seen for the first time on top", () => {
    const previous = [{ key: "/a" }, { key: "/b" }];
    const next = [{ key: "/d" }, { key: "/b" }, { key: "/a" }];
    expect(stabilizeGroupOrder(previous, next).map((g) => g.key)).toEqual(["/d", "/a", "/b"]);
  });

  it("drops a project that left the recent list", () => {
    const previous = [{ key: "/a" }, { key: "/b" }];
    expect(stabilizeGroupOrder(previous, [{ key: "/b" }]).map((g) => g.key)).toEqual(["/b"]);
  });

  it("the first snapshot keeps the recent order", () => {
    const next = [{ key: "/a" }, { key: "/b" }];
    expect(stabilizeGroupOrder([], next).map((g) => g.key)).toEqual(["/a", "/b"]);
  });
});

describe("projectRowIntent", () => {
  const group = {
    root: "/repos/demo",
    checkouts: [
      { path: "/repos/demo", name: "demo", branch: "main", isMain: true },
      { path: "/repos/worktrees/demo/fix", name: "fix", branch: "fix", isMain: false },
    ],
  };

  it("the group holding the open project folds, from any of its checkouts", () => {
    expect(projectRowIntent(group, "/repos/demo")).toEqual({ kind: "fold" });
    expect(projectRowIntent(group, "/repos/worktrees/demo/fix")).toEqual({ kind: "fold" });
  });

  it("another group opens its canonical checkout, not a worktree", () => {
    expect(projectRowIntent(group, "/repos/other")).toEqual({ kind: "open", root: "/repos/demo" });
    expect(projectRowIntent(group, null)).toEqual({ kind: "open", root: "/repos/demo" });
  });
});

describe("worktree paths", () => {
  it("lands in the sibling worktrees/<project> directory", () => {
    expect(worktreesDirFor("/Users/a/CodeRepo/demo")).toBe("/Users/a/CodeRepo/worktrees/demo");
    expect(worktreePathFor("/Users/a/CodeRepo/demo", "calm-river")).toBe(
      "/Users/a/CodeRepo/worktrees/demo/calm-river",
    );
  });

  it("handles a root-level repository and trailing slashes", () => {
    expect(worktreesDirFor("/demo/")).toBe("/worktrees/demo");
    expect(worktreePathFor("/demo", "x")).toBe("/worktrees/demo/x");
  });
});

describe("randomWorktreeName", () => {
  it("avoids names already taken by the group's checkouts", () => {
    // Pinned sequence: calm-river, calm-river, bright-harbor.
    const rolls = [0, 0, 0.1, 8 / 16];
    let index = 0;
    const random = () => rolls[Math.min(index++, rolls.length - 1)];
    const name = randomWorktreeName(["calm-river"], random);
    expect(name).not.toBe("calm-river");
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("falls back to a numbered name when every roll collides", () => {
    const name = randomWorktreeName(["calm-river", "worktree-1"], () => 0);
    expect(name).toBe("worktree-2");
  });
});

describe("validWorktreeName", () => {
  it("accepts a plain segment", () => {
    expect(validWorktreeName("fix-auth")).toBe(true);
  });

  it("rejects separators, traversal, dot files and padding", () => {
    for (const bad of ["", "a/b", "a\\b", "..", "a..b", ".hidden", " spaced "]) {
      expect(validWorktreeName(bad), bad).toBe(false);
    }
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-22T12:00:00");

  it("reads the ZCode buckets", () => {
    expect(relativeTime(now - 30_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时");
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5 天");
  });

  it("a missing or future timestamp never renders a negative age", () => {
    expect(relativeTime(0, now)).toBe("");
    expect(relativeTime(now + 60_000, now)).toBe("刚刚");
  });
});

describe("sessionMatches", () => {
  const item = {
    title: "修复登录流程",
    workdir: "/repos/worktrees/demo/fix-auth",
    sourceName: "fix-auth",
  };

  it("matches title, checkout path and badge, case-insensitively", () => {
    expect(sessionMatches(item, "")).toBe(true);
    expect(sessionMatches(item, "登录")).toBe(true);
    expect(sessionMatches(item, "FIX-AUTH")).toBe(true);
    expect(sessionMatches(item, "/repos")).toBe(true);
    expect(sessionMatches(item, "nothing")).toBe(false);
  });
});

describe("parseCollapsed", () => {
  it("keeps only collapsed projects, defaulting the rest to expanded", () => {
    expect(parseCollapsed('{"/a":"x","/b":true,"/c":false}')).toEqual({ "/b": true });
    expect(parseCollapsed(null)).toEqual({});
    expect(parseCollapsed("[]")).toEqual({});
    expect(parseCollapsed("not json")).toEqual({});
  });
});

describe("parsePinned", () => {
  it("keeps unique non-empty strings", () => {
    expect(parsePinned('["/a","/b","/a","",3]')).toEqual(["/a", "/b"]);
    expect(parsePinned(null)).toEqual([]);
    expect(parsePinned("{}")).toEqual([]);
    expect(parsePinned("not json")).toEqual([]);
  });
});

describe("orderPinnedGroups", () => {
  const groups = [{ key: "/a" }, { key: "/b" }, { key: "/c" }];

  it("floats pinned projects to the top in pin order", () => {
    expect(orderPinnedGroups(groups, ["/c", "/a"]).map((g) => g.key)).toEqual(["/c", "/a", "/b"]);
  });

  it("ignores pinned keys without a row and keeps the list order otherwise", () => {
    expect(orderPinnedGroups(groups, ["/gone"]).map((g) => g.key)).toEqual(["/a", "/b", "/c"]);
  });

  it("an empty pin list is the untouched list", () => {
    expect(orderPinnedGroups(groups, [])).toEqual(groups);
  });
});

describe("groupOpen", () => {
  const base = { pinned: [] as string[], activeKey: "/a", collapsed: false, filtering: false };

  it("only the active project's folder is open", () => {
    expect(groupOpen({ ...base, key: "/a" })).toBe(true);
    expect(groupOpen({ ...base, key: "/b" })).toBe(false);
  });

  it("a pinned project stays open even when it is not active or was folded", () => {
    expect(groupOpen({ ...base, key: "/b", pinned: ["/b"], collapsed: true })).toBe(true);
  });

  it("the active project can be folded by hand", () => {
    expect(groupOpen({ ...base, key: "/a", collapsed: true })).toBe(false);
  });

  it("a search opens every group with a match", () => {
    expect(groupOpen({ ...base, key: "/b", filtering: true })).toBe(true);
  });
});

describe("isDirtyRefusal", () => {
  it("recognizes git's dirty-checkout refusals", () => {
    expect(isDirtyRefusal("fatal: '/x' is dirty")).toBe(true);
    expect(isDirtyRefusal("error: refusing; use --force")).toBe(true);
    expect(isDirtyRefusal("contains modified or untracked files")).toBe(true);
  });

  it("anything else is not offered a force retry", () => {
    expect(isDirtyRefusal(null)).toBe(false);
    expect(isDirtyRefusal("")).toBe(false);
    expect(isDirtyRefusal("WORKTREE_NOT_FOUND: /x")).toBe(false);
  });
});

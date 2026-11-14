import { describe, expect, it, vi } from "vitest";
import { dailyScaffold } from "./model";
import { openDailyNote, type OpenDailyDeps } from "./open";

const appState = vi.hoisted(() => ({
  currentFile: null as string | null,
  dailyBackFrom: null as string | null,
  toast: vi.fn(),
  openNote: vi.fn(async (_path: string, _line?: number) => {}),
  refreshTree: vi.fn(async () => {}),
}));

vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({
      currentFile: appState.currentFile,
      dailyBackFrom: appState.dailyBackFrom,
      setDailyBackFrom: (p: string | null) => {
        appState.dailyBackFrom = p;
      },
      showToast: appState.toast,
    }),
  },
}));

vi.mock("@/app/actions", () => ({
  openNote: appState.openNote,
  refreshTree: appState.refreshTree,
}));

vi.mock("./runtime", () => ({
  runtimeDeps: () => ({
    io: {
      readFile: async () => null,
      writeFile: async () => {},
      readDir: async () => [],
    },
    vaultRoot: () => "/v",
    today: () => "2026-09-27",
    toast: (msg: string) => appState.toast(msg),
    templatePath: () => null,
  }),
}));

import { openTodayDailyNote } from "./open";

/**
 * The contract of "open today's daily note":
 *  1. The daily note is not on disk -> create it with the same initial content as
 *     the sync engine (dailyScaffold), refresh the file tree, then open it;
 *  2. It is already on disk -> not a single byte is written (a daily note the user
 *     already has is never overwritten);
 *  3. The current file already is today's daily note -> consume the jump-back
 *     slot and jump to the source; every jump from outside a daily note
 *     overwrites the slot.
 */

const DAY = "2026-09-27";
const DAILY = `/v/Daily/${DAY}.md`;

function harness(files: Record<string, string> = {}, over: Partial<OpenDailyDeps> = {}) {
  const disk = new Map(Object.entries(files));
  const written: { path: string; content: string }[] = [];
  const opened: string[] = [];
  let refreshed = 0;
  const toasts: string[] = [];
  let current: string | null = null;
  let dailyBack: string | null = null;
  const deps: OpenDailyDeps = {
    vaultRoot: () => "/v",
    today: () => DAY,
    io: {
      readFile: async (p) => disk.get(p) ?? null,
      writeFile: async (p, c) => {
        disk.set(p, c);
        written.push({ path: p, content: c });
      },
      readDir: async (relPath) => {
        const prefix = `/v/${relPath}/`;
        return [...disk.keys()]
          .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map((k) => k.slice(prefix.length));
      },
    },
    open: async (p) => {
      opened.push(p);
      current = p;
    },
    refresh: async () => {
      refreshed++;
    },
    toast: (m) => toasts.push(m),
    currentFile: () => current,
    getDailyBack: () => dailyBack,
    setDailyBack: (p) => {
      dailyBack = p;
    },
    templatePath: () => null,
    ...over,
  };
  return {
    deps,
    disk,
    written,
    opened,
    toasts,
    stats: () => ({ refreshed }),
    setCurrent: (p: string | null) => {
      current = p;
    },
    back: () => dailyBack,
  };
}

describe("opening today's daily note", () => {
  it("when the file is missing it is created with the same initial content as the engine, the file tree is refreshed and then it is opened", async () => {
    const h = harness();
    expect(await openDailyNote(h.deps)).toBe(DAILY);
    expect(h.written).toEqual([{ path: DAILY, content: dailyScaffold(DAY) }]);
    expect(h.written[0].content).toBe(`# ${DAY}\n`);
    expect(h.stats().refreshed).toBe(1);
    expect(h.opened).toEqual([DAILY]);
  });

  it("when the daily note already exists nothing is written and nothing is refreshed, it is only opened", async () => {
    const existing = `# ${DAY}\n- [ ] 已有一条\n`;
    const h = harness({ [DAILY]: existing });
    expect(await openDailyNote(h.deps)).toBe(DAILY);
    expect(h.written).toEqual([]);
    expect(h.stats().refreshed).toBe(0);
    expect(h.disk.get(DAILY)).toBe(existing);
    expect(h.opened).toEqual([DAILY]);
  });

  it("no vault is open: a toast is shown and no file is opened", async () => {
    const h = harness({}, { vaultRoot: () => null });
    expect(await openDailyNote(h.deps)).toBeNull();
    expect(h.toasts).toEqual(["没有打开仓库"]);
    expect(h.opened).toEqual([]);
  });

  it("the daily note path keeps the existing naming (Daily/YYYY-MM-DD.md)", async () => {
    const h = harness();
    await openDailyNote(h.deps);
    expect(h.opened[0].endsWith("/Daily/2026-09-27.md")).toBe(true);
  });
});

describe("todo rollover of a newly created daily note", () => {
  const PREV = "/v/Daily/2026-09-26.md";

  it("the unfinished todos of the previous note (with the hierarchy) go into the new note, completed leaves do not follow, the anchor chain is kept", async () => {
    const h = harness({
      [PREV]: [
        "# 1 2026-09-26",
        "- [x] 已完成的事 ✅ 2026-09-26",
        "- [ ] 还没做完",
        "  - [x] 中间步骤 ✅ 2026-09-26",
        "    - [ ] 剩下的子项",
      ].join("\n"),
    });
    expect(await openDailyNote(h.deps)).toBe(DAILY);
    expect(h.written[0].content).toBe(
      "# 2026-09-27\n\n- [ ] 还没做完\n  - [x] 中间步骤 ✅ 2026-09-26\n    - [ ] 剩下的子项\n",
    );
  });

  it("it takes the most recent note instead of strictly yesterday: it follows even after a gap of days", async () => {
    const h = harness({ "/v/Daily/2026-09-24.md": "# d\n- [ ] 前几天没做完\n" });
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe("# 2026-09-27\n\n- [ ] 前几天没做完\n");
  });

  it("the Daily directory cannot be listed: the bare scaffold, a failed rollover does not block the creation", async () => {
    const h = harness();
    h.deps.io = { ...h.deps.io, readDir: async () => null };
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe(dailyScaffold(DAY));
  });
});

describe("the template of a newly created daily note", () => {
  const TPL = "/v/Templates/日记.md";

  it("the template content opens the file, {{date}}/{{title}} are replaced with the date of the day", async () => {
    const h = harness(
      { [TPL]: "# {{date}}\n\n## 计划\n- 早会\n" },
      { templatePath: () => "Templates/日记.md" },
    );
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe("# 2026-09-27\n\n## 计划\n- 早会\n");
  });

  it("template and todo rollover stack up: the todo region still follows the first H1 immediately", async () => {
    const h = harness(
      {
        "/v/Daily/2026-09-26.md": "# 前一天\n- [ ] 还没做完\n",
        [TPL]: "# {{title}}\n\n## 计划\n",
      },
      { templatePath: () => "Templates/日记.md" },
    );
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe("# 2026-09-27\n\n- [ ] 还没做完\n\n## 计划\n");
  });

  it("the template file cannot be read: it falls back to the default `# <date>` heading, the creation is not blocked", async () => {
    const h = harness({}, { templatePath: () => "Templates/已删除.md" });
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe(dailyScaffold(DAY));
  });

  it("the template has no H1: the todos go to the very front of the file by the existing engine rule", async () => {
    const h = harness(
      {
        "/v/Daily/2026-09-26.md": "# 前一天\n- [ ] 还没做完\n",
        [TPL]: "## 计划\n",
      },
      { templatePath: () => "Templates/日记.md" },
    );
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe("- [ ] 还没做完\n\n## 计划\n");
  });

  it("the template path escapes the vault (`..`): it is treated as not set", async () => {
    const h = harness({ "/v/../secret.md": "# 不该读\n" }, { templatePath: () => "../secret.md" });
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe(dailyScaffold(DAY));
  });
});

describe("pressing ⌘⇧O again inside the daily note: jump back to the file from before the jump", () => {
  it("jumping from a note into the daily note records the source; pressing again inside the daily note jumps back to the source, the source file stays unchanged", async () => {
    const note = "/v/Job/ideas.md";
    const h = harness({ [note]: "草稿\n" });
    h.setCurrent(note);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([DAILY]);
    expect(h.back()).toBe(note);

    await openDailyNote(h.deps); // already in the daily note: toggle
    expect(h.opened).toEqual([DAILY, note]);
    expect(h.back()).toBeNull(); // consuming clears the slot
    // Jumping back goes through open: of all the writes to disk only the first
    // jump, the one that creates the daily note, writes; the toggle itself puts
    // no byte on disk.
    expect(h.written).toEqual([{ path: DAILY, content: dailyScaffold(DAY) }]);
    expect(h.disk.get(note)).toBe("草稿\n");
  });

  it("toggling back and forth: every jump into the daily note records the source again, the toggle semantics can cycle", async () => {
    const note = "/v/a.md";
    const h = harness({ [note]: "x\n", [DAILY]: "# d\n" });
    h.setCurrent(note);
    await openDailyNote(h.deps);
    await openDailyNote(h.deps); // back to the note
    await openDailyNote(h.deps); // into the daily note again
    await openDailyNote(h.deps); // back to the note again
    expect(h.opened).toEqual([DAILY, note, DAILY, note]);
  });

  it("with no source, pressing again inside the daily note: a toast is shown and it does not jump", async () => {
    const h = harness({ [DAILY]: "# d\n" });
    h.setCurrent(DAILY);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([]);
    expect(h.toasts).toEqual(["没有可跳回的文件"]);
  });

  it("the source file was deleted: a toast is shown and it does not jump, the slot is cleared as usual", async () => {
    const h = harness({ [DAILY]: "# d\n" });
    h.setCurrent("/v/gone.md");
    await openDailyNote(h.deps);
    h.setCurrent(DAILY);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([DAILY]);
    expect(h.toasts).toEqual(["跳回的文件已不存在"]);
    expect(h.back()).toBeNull();
  });

  it("another daily note (yesterday) as the source is recorded too: jumping back lands on it", async () => {
    const yesterday = "/v/Daily/2026-09-26.md";
    const h = harness({ [DAILY]: "# d\n", [yesterday]: "# 前一天\n" });
    h.setCurrent(yesterday);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([DAILY]);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([DAILY, yesterday]);
  });

  it("inside the daily note with an empty source slot, the daily note itself is not recorded as the source", async () => {
    const h = harness({ [DAILY]: "# d\n" });
    h.setCurrent(DAILY);
    await openDailyNote(h.deps);
    expect(h.back()).toBeNull();
  });
});

describe("openTodayDailyNote: the app wiring", () => {
  it("opens today's daily note through the real store slot and the app opener", async () => {
    appState.currentFile = "/v/Job/ideas.md";
    appState.dailyBackFrom = null;
    appState.openNote.mockClear();
    appState.refreshTree.mockClear();
    await openTodayDailyNote();
    expect(appState.openNote).toHaveBeenCalledWith(DAILY);
    expect(appState.dailyBackFrom).toBe("/v/Job/ideas.md");
    expect(appState.toast).not.toHaveBeenCalled();
  });

  it("a failure inside the app wiring reaches the user as a toast instead of rejecting", async () => {
    appState.openNote.mockRejectedValueOnce(new Error("cannot open"));
    appState.toast.mockClear();
    await expect(openTodayDailyNote()).resolves.toBeUndefined();
    expect(appState.toast).toHaveBeenCalledWith("打开日记失败: Error: cannot open");
  });
});

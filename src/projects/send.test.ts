import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { DailyIO } from "@/daily/engine";
import type { LinkStore } from "@/daily/links";

/**
 * The send chain for project todos: the single placement contract is
 * "insert at the very front of today's todo section", and sending the same
 * item twice in one day claims it again without inserting it twice. The bytes
 * written to disk and the link metadata are both assertion targets.
 */

const linksMock = vi.hoisted(() => ({ store: null as unknown as LinkStore }));
const editorMock = vi.hoisted(() => ({ views: new Map<string, unknown>() }));
const refreshTreeMock = vi.hoisted(() => vi.fn(async () => {}));
const appMock = vi.hoisted(() => ({
  vaultPath: null as string | null,
  toasts: [] as string[],
}));

vi.mock("@/editor/api", () => ({
  findEditorFor: (path: string) => editorMock.views.get(path) ?? null,
}));
vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({
      vaultPath: appMock.vaultPath,
      showToast: (msg: string) => appMock.toasts.push(msg),
    }),
  },
}));
vi.mock("@/app/actions", () => ({ refreshTree: refreshTreeMock }));
// The runtime dependencies of the app path (`sendTodoWithToast`) go through
// the real `daily/runtime.ts` wrapper, so the mock models a tiny file system.
const appFiles = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: async (path: string) => {
      const text = appFiles.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    writeFile: async (path: string, content: string) => {
      appFiles.set(path, content);
    },
    readDir: async (rel: string) => {
      const prefix = `${VAULT}/${rel}/`;
      return [...appFiles.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => ({
          name: k.slice(prefix.length),
          relPath: `${rel}/${k.slice(prefix.length)}`,
          kind: "file",
          children: null,
        }));
    },
  },
}));
vi.mock("@/daily/links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/daily/links")>();
  return {
    ...actual,
    ensureLinks: async () => linksMock.store,
    scheduleLinksPersist: () => {},
  };
});

const { LinkStore: Store } = await import("@/daily/links");
const { sendTodoToTodayFront } = await import("./send");

const VAULT = "/vault";
const DAILY = "/vault/Daily/2026-09-23.md";
const PROJECT = "/vault/.bnote/projects-manager/读书.md";

function memIO(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    io: {
      async readFile(p: string) {
        return files.has(p) ? (files.get(p) as string) : null;
      },
      async writeFile(p: string, c: string) {
        files.set(p, c);
      },
      async readDir(relPath: string) {
        const prefix = `${VAULT}/${relPath}/`;
        return [...files.keys()]
          .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map((k) => k.slice(prefix.length));
      },
    } as DailyIO,
  };
}

function makeDeps(io: DailyIO) {
  return {
    io,
    vaultRoot: () => VAULT,
    today: () => "2026-09-23",
    toast: () => {},
    templatePath: () => null,
  };
}

beforeEach(() => {
  linksMock.store = Store.fromJSON(null);
  editorMock.views.clear();
  refreshTreeMock.mockClear();
  appMock.vaultPath = null;
  appMock.toasts.length = 0;
});

/** A fake editor holding a project / daily document, recording its dispatches. */
function fakeEditor(text: string) {
  let state = EditorState.create({ doc: text });
  return {
    get state() {
      return state;
    },
    dispatches: [] as TransactionSpec[],
    dispatch(spec: TransactionSpec) {
      this.dispatches.push(spec);
      state = state.update(spec).state;
    },
  };
}

describe("sendTodoToTodayFront", () => {
  it("no daily note yet: build the scaffold and insert the todo at the very front after H1", async () => {
    const { files, io } = memIO({ [PROJECT]: "- [ ] 甲\n- [ ] 乙\n" });
    const result = await sendTodoToTodayFront({ srcPath: PROJECT, line: 2 }, makeDeps(io));
    expect(result).toBe("sent");
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 乙\n");
  });

  it("entries already exist: insert at the front of the todo section (not the end)", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 甲\n",
      [DAILY]: "# 2026-09-23\n\n- [ ] 旧\n",
    });
    await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n- [ ] 旧\n");
  });

  it("sending twice on the same day: claims the existing entry instead of inserting it again", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 甲\n",
      [DAILY]: "# 2026-09-23\n\n- [ ] 甲\n",
    });
    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io))).toBe("already");
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n");
  });

  it("children travel with their root as one block and are re-indented to the top level", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 甲\n  - [ ] 甲子\n",
      [DAILY]: "# 2026-09-23\n",
    });
    await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n  - [ ] 甲子\n");
  });

  it("a copied mapping is created: both paths, the identity text and the line numbers", async () => {
    const { io } = memIO({
      [PROJECT]: "- [ ] 甲\n",
      [DAILY]: "# 2026-09-23\n",
    });
    await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));
    const links = linksMock.store.all();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      kind: "copied",
      day: "2026-09-23",
      srcPath: PROJECT,
      dailyPath: DAILY,
      text: "甲",
      srcLine: 1,
      dailyLine: 3,
    });
  });

  it("a non-todo line is not sent", async () => {
    const { files, io } = memIO({ [PROJECT]: "普通正文\n" });
    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io))).toBe(
      "not-todo",
    );
    expect(files.has(DAILY)).toBe(false);
  });

  it("the source file cannot be read", async () => {
    const { io } = memIO();
    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io))).toBe(
      "no-source",
    );
  });

  it("a missing vault is reported before any file is touched", async () => {
    const { files, io } = memIO({ [PROJECT]: "- [ ] 甲\n" });
    expect(
      await sendTodoToTodayFront(
        { srcPath: PROJECT, line: 1 },
        { ...makeDeps(io), vaultRoot: () => null },
      ),
    ).toBe("no-vault");
    expect(files.get(DAILY)).toBeUndefined();
  });

  it("a line past the end of the project file clamps to its last line", async () => {
    const { files, io } = memIO({ [PROJECT]: "# 标题\n- [ ] 末", [DAILY]: "# 2026-09-23\n" });
    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 99 }, makeDeps(io))).toBe("sent");
    expect(files.get(DAILY)).toContain("- [ ] 末");
  });

  it("an empty checkbox carries no identity text and is not sent", async () => {
    const { files, io } = memIO({ [PROJECT]: "- [ ] \n" });
    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io))).toBe(
      "not-todo",
    );
    expect(files.has(DAILY)).toBe(false);
  });
});

describe("the daily note is already open in an editor", () => {
  it("patches the in-memory document instead of writing the disk", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 甲\n",
      [DAILY]: "# 2026-09-23\n\n- [ ] 旧\n",
    });
    const view = fakeEditor(files.get(DAILY) as string);
    editorMock.views.set(DAILY, view);

    const result = await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));

    expect(result).toBe("sent");
    expect(view.state.doc.toString()).toBe("# 2026-09-23\n\n- [ ] 甲\n- [ ] 旧\n");
    expect(view.dispatches).toHaveLength(1);
    // The disk copy is the editor's business (autosave); the send must not
    // fight the editor with a second writer.
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 旧\n");
  });

  it("an item already in the open daily note is claimed, not inserted twice", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 甲\n",
      [DAILY]: "# 2026-09-23\n\n- [ ] 甲\n",
    });
    const view = fakeEditor(files.get(DAILY) as string);
    editorMock.views.set(DAILY, view);

    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io))).toBe("already");
    expect(view.dispatches).toEqual([]);
    expect(linksMock.store.all()[0]).toMatchObject({ dailyLine: 3, srcLine: 1 });
  });

  it("the project document in an editor is read from memory, so unsaved edits are sent", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 旧的\n",
      [DAILY]: "# 2026-09-23\n",
    });
    editorMock.views.set(PROJECT, fakeEditor("- [ ] 刚写的\n"));

    await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));

    expect(files.get(DAILY)).toContain("- [ ] 刚写的");
    expect(files.get(DAILY)).not.toContain("旧的");
  });

  it("the first creation of today's note refreshes the tree so the sidebar sees it", async () => {
    const { io } = memIO({ [PROJECT]: "- [ ] 甲\n" });
    await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));
    // The refresh is fired in the background (a floating import), so the
    // assertion waits one turn instead of assuming it completed.
    await vi.waitFor(() => expect(refreshTreeMock).toHaveBeenCalledTimes(1));
  });

  it("an existing daily note does not refresh the tree", async () => {
    const { io } = memIO({ [PROJECT]: "- [ ] 甲\n", [DAILY]: "# 2026-09-23\n" });
    await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));
    expect(refreshTreeMock).not.toHaveBeenCalled();
  });
});

describe("sendTodoWithToast", () => {
  beforeEach(() => {
    appMock.toasts.length = 0;
    appFiles.clear();
  });

  it("reports a send, an already-mapped item and a non-todo line with their own hints", async () => {
    const { sendTodoWithToast } = await import("./send");

    // No vault: the toast names the real reason instead of a generic failure.
    await sendTodoWithToast({ srcPath: PROJECT, line: 1 });
    expect(appMock.toasts[appMock.toasts.length - 1]).toBe("没有打开仓库");

    // With a vault the send reaches the real path; the source file is not on
    // disk, so "unreadable project" is the honest answer.
    appMock.vaultPath = VAULT;
    await sendTodoWithToast({ srcPath: PROJECT, line: 1 });
    expect(appMock.toasts[appMock.toasts.length - 1]).toBe("读不到项目文件");
  });

  it("reports a real send and an already-mapped item", async () => {
    const { sendTodoWithToast } = await import("./send");
    const { dailyPathFor } = await import("@/daily/model");
    const { todayStamp } = await import("@/lib/todoStamp");
    appMock.vaultPath = VAULT;
    appFiles.set(PROJECT, "- [ ] 甲\n");
    appFiles.set(dailyPathFor(VAULT, todayStamp()), "# x\n");

    await sendTodoWithToast({ srcPath: PROJECT, line: 1 });
    expect(appMock.toasts[appMock.toasts.length - 1]).toBe("已发送到今日日记最前");

    await sendTodoWithToast({ srcPath: PROJECT, line: 1 });
    expect(appMock.toasts[appMock.toasts.length - 1]).toBe("已在今日日记中,自动保持同步");
  });

  it("reports a line that is not a todo", async () => {
    const { sendTodoWithToast } = await import("./send");
    appMock.vaultPath = VAULT;
    appFiles.set(PROJECT, "普通正文\n");

    await sendTodoWithToast({ srcPath: PROJECT, line: 1 });
    expect(appMock.toasts[appMock.toasts.length - 1]).toBe("光标行不是待办");
  });
});

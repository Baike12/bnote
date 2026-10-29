import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyIO } from "@/daily/engine";
import type { LinkStore } from "@/daily/links";

/**
 * 项目待办的发送链:唯一位移契约是「插到今天待办区最前面」,以及同一天
 * 重复发送只认领、不重复插入。落盘字节与链接元数据都是断言对象。
 */

const linksMock = vi.hoisted(() => ({ store: null as unknown as LinkStore }));

vi.mock("@/editor/api", () => ({ findEditorFor: () => null }));
vi.mock("@/state/appStore", () => ({
  useAppStore: { getState: () => ({ vaultPath: null, showToast: () => {} }) },
}));
vi.mock("@/app/actions", () => ({ refreshTree: async () => {} }));
vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: async () => {
      throw new Error("测试环境无 IPC");
    },
    writeFile: async () => {},
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
const PROJECT = "/vault/.bnote/projects/读书.md";

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
  return { io, vaultRoot: () => VAULT, today: () => "2026-09-23", toast: () => {} };
}

beforeEach(() => {
  linksMock.store = Store.fromJSON(null);
});

describe("sendTodoToTodayFront", () => {
  it("今天还没有日记:建 scaffold 并把待办插在 H1 之后的最前面", async () => {
    const { files, io } = memIO({ [PROJECT]: "- [ ] 甲\n- [ ] 乙\n" });
    const result = await sendTodoToTodayFront({ srcPath: PROJECT, line: 2 }, makeDeps(io));
    expect(result).toBe("sent");
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 乙\n");
  });

  it("已有条目:插在待办区最前(不是末尾)", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 甲\n",
      [DAILY]: "# 2026-09-23\n\n- [ ] 旧\n",
    });
    await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n- [ ] 旧\n");
  });

  it("同一天重复发送:认领既有条目,不重复插入", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 甲\n",
      [DAILY]: "# 2026-09-23\n\n- [ ] 甲\n",
    });
    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io))).toBe("already");
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n");
  });

  it("子项随根整块搬运并重缩进到一级条目", async () => {
    const { files, io } = memIO({
      [PROJECT]: "- [ ] 甲\n  - [ ] 甲子\n",
      [DAILY]: "# 2026-09-23\n",
    });
    await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io));
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n  - [ ] 甲子\n");
  });

  it("建立 copied 映射:两侧路径、身份文本与行号", async () => {
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

  it("非待办行不发送", async () => {
    const { files, io } = memIO({ [PROJECT]: "普通正文\n" });
    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io))).toBe("not-todo");
    expect(files.has(DAILY)).toBe(false);
  });

  it("源文件读不到", async () => {
    const { io } = memIO();
    expect(await sendTodoToTodayFront({ srcPath: PROJECT, line: 1 }, makeDeps(io))).toBe(
      "no-source",
    );
  });
});

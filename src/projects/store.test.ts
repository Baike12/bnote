import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 项目删除的磁盘契约。
 *
 * 删除不是「调一次 trash 命令」那么简单:编辑器还挂着一笔 800ms 防抖写、
 * 卸载时还会冲刷一次,任何排在删除之后的写入都会把文件重新落回来。这条测试
 * 锁的就是真实的失败形状——删完之后文件仍然不在盘上。
 */

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** write / trash 的完成顺序。 */
  events: [] as string[],
  /** writeFile 的人为延迟:让一次保存在删除时还悬着。 */
  delayMs: 0,
  /** trashPath 的人为延迟:模拟 watcher 在删除进行中读到旧目录。 */
  trashDelayMs: 0,
}));

vi.mock("@/lib/tauri", () => ({
  api: {
    readDir: async (rel: string) => {
      const prefix = `/vault/${rel}/`;
      return [...fs.files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => ({
          name: p.slice(prefix.length),
          relPath: `${rel}/${p.slice(prefix.length)}`,
          kind: "file",
          children: null,
        }));
    },
    readFile: async (path: string) => {
      const v = fs.files.get(path);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFile: async (path: string, text: string) => {
      if (fs.delayMs) await new Promise((r) => setTimeout(r, fs.delayMs));
      fs.files.set(path, text);
      fs.events.push(`write:${path}`);
    },
    ensureDir: async () => {},
    createFile: async (parent: string, name: string) => {
      const path = `/vault/${parent}/${name}`;
      fs.files.set(path, "");
      return { path, relPath: `${parent}/${name}` };
    },
    trashPath: async (path: string) => {
      if (fs.trashDelayMs) await new Promise((r) => setTimeout(r, fs.trashDelayMs));
      fs.files.delete(path);
      fs.events.push(`trash:${path}`);
    },
  },
}));

const VAULT = "/vault";
const PROJECT = "/vault/.bnote/projects/读书.md";
const OTHER = "/vault/.bnote/projects/写作.md";

let store: typeof import("./store");

beforeEach(async () => {
  fs.files.clear();
  fs.events.length = 0;
  fs.delayMs = 0;
  vi.resetModules();
  store = await import("./store");
  fs.files.set(PROJECT, "- [ ] 甲");
  fs.files.set(OTHER, "- [ ] 乙");
  await store.loadProjects(VAULT);
});

describe("删除项目", () => {
  it("文件进废纸篓,列表与文档缓存同步清掉", async () => {
    expect(store.projectEntries().map((e) => e.name)).toEqual(["读书", "写作"]);
    await store.readProjectDoc(PROJECT); // 先占一条缓存

    await store.deleteProject(VAULT, PROJECT);

    expect(fs.files.has(PROJECT)).toBe(false);
    expect(fs.events).toContain(`trash:${PROJECT}`);
    expect(store.projectEntries().map((e) => e.name)).toEqual(["写作"]);
    expect(store.cachedProjectDoc(PROJECT)).toBeUndefined();
  });

  it("删除后迟到的自动保存被丢弃,文件不会复活", async () => {
    await store.deleteProject(VAULT, PROJECT);
    fs.events.length = 0;

    // 编辑器卸载/防抖定时器在删除之后才跑到这里。
    await store.writeProjectDoc(PROJECT, "- [ ] 复活");

    expect(fs.files.has(PROJECT)).toBe(false);
    expect(fs.events).toEqual([]);
  });

  it("删除前已经排队的保存先落盘,再删(顺序契约)", async () => {
    fs.delayMs = 20;
    const save = store.writeProjectDoc(PROJECT, "- [ ] 最新一笔");

    await store.deleteProject(VAULT, PROJECT);
    await save;

    expect(fs.events).toEqual([`write:${PROJECT}`, `trash:${PROJECT}`]);
    expect(fs.files.has(PROJECT)).toBe(false);
  });

  it("文件重新出现(废纸篓还原/外部新建同名)后墓碑失效,可以继续保存", async () => {
    await store.deleteProject(VAULT, PROJECT);
    fs.files.set(PROJECT, "- [ ] 从废纸篓还原");

    await store.loadProjects(VAULT);
    await store.writeProjectDoc(PROJECT, "- [ ] 还原后编辑");

    expect(fs.files.get(PROJECT)).toBe("- [ ] 还原后编辑");
  });

  it("删除进行中,watcher 读到「文件还在」的旧目录也不会撤墓碑", async () => {
    // 真实时序:删盘是异步的,这段时间里 vault watcher 会把删除前的目录
    // 快照送回来。若据此撤墓碑,删除完成后到达的自动保存就会把文件写回来。
    fs.trashDelayMs = 30;
    const del = store.deleteProject(VAULT, PROJECT);
    await new Promise((r) => setTimeout(r, 5));
    await store.loadProjects(VAULT);
    expect(store.projectEntries().some((e) => e.path === PROJECT)).toBe(true);
    await del;

    await store.writeProjectDoc(PROJECT, "- [ ] 迟到");
    expect(fs.files.has(PROJECT)).toBe(false);
  });

  it("删的是当前聚焦项目时把聚焦交还给视图", async () => {
    store.setFocusedProject(PROJECT);
    await store.deleteProject(VAULT, PROJECT);
    expect(store.focusedProjectPath()).toBeNull();
  });

  it("废纸篓失败时撤掉墓碑,项目仍能正常保存", async () => {
    // 这一条防的是「删除失败 → 项目从此写不进任何东西」的静默数据丢失。
    const api = (await import("@/lib/tauri")).api as unknown as { trashPath: () => Promise<void> };
    const original = api.trashPath;
    api.trashPath = async () => {
      throw new Error("TRASH_FAILED");
    };
    await expect(store.deleteProject(VAULT, PROJECT)).rejects.toThrow("TRASH_FAILED");
    api.trashPath = original;

    await store.writeProjectDoc(PROJECT, "- [ ] 还在");
    expect(fs.files.get(PROJECT)).toBe("- [ ] 还在");
  });
});

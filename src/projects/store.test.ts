import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The disk contract of deleting a project.
 *
 * Deleting is not just "call the trash command once": the editor still holds an
 * 800ms debounced write and flushes once more on unmount, and every write that
 * comes after the deletion puts the file back on disk. This test locks exactly
 * that real failure shape - after the deletion the file is still not on the disk.
 */

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** The completion order of the write and the trash calls. */
  events: [] as string[],
  /** Artificial delay of writeFile: keeps one save hanging while the deletion runs. */
  delayMs: 0,
  /** Artificial delay of trashPath: simulates the watcher reading the old directory while the deletion is running. */
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

describe("deleting a project", () => {
  it("the file goes to the trash, the list and the document cache are cleared together", async () => {
    expect(store.projectEntries().map((e) => e.name)).toEqual(["读书", "写作"]);
    await store.readProjectDoc(PROJECT); // occupy a cache entry first

    await store.deleteProject(VAULT, PROJECT);

    expect(fs.files.has(PROJECT)).toBe(false);
    expect(fs.events).toContain(`trash:${PROJECT}`);
    expect(store.projectEntries().map((e) => e.name)).toEqual(["写作"]);
    expect(store.cachedProjectDoc(PROJECT)).toBeUndefined();
  });

  it("a late autosave after the deletion is dropped, the file does not come back", async () => {
    await store.deleteProject(VAULT, PROJECT);
    fs.events.length = 0;

    // The unmount or the debounce timer of the editor only gets here after the
    // deletion.
    await store.writeProjectDoc(PROJECT, "- [ ] 复活");

    expect(fs.files.has(PROJECT)).toBe(false);
    expect(fs.events).toEqual([]);
  });

  it("a save queued before the deletion is written to disk first, then the deletion runs (ordering contract)", async () => {
    fs.delayMs = 20;
    const save = store.writeProjectDoc(PROJECT, "- [ ] 最新一笔");

    await store.deleteProject(VAULT, PROJECT);
    await save;

    expect(fs.events).toEqual([`write:${PROJECT}`, `trash:${PROJECT}`]);
    expect(fs.files.has(PROJECT)).toBe(false);
  });

  it("once the file reappears (restored from trash / created externally with the same name) the tombstone is void and saving works again", async () => {
    await store.deleteProject(VAULT, PROJECT);
    fs.files.set(PROJECT, "- [ ] 从废纸篓还原");

    await store.loadProjects(VAULT);
    await store.writeProjectDoc(PROJECT, "- [ ] 还原后编辑");

    expect(fs.files.get(PROJECT)).toBe("- [ ] 还原后编辑");
  });

  it("while the deletion is in flight, a watcher reading the old directory that still shows the file does not withdraw the tombstone", async () => {
    // The real timing: deleting from the disk is asynchronous and during that
    // time the vault watcher sends back the directory snapshot from before the
    // deletion. If the tombstone were withdrawn on that basis, the autosave that
    // arrives after the deletion would write the file back.
    fs.trashDelayMs = 30;
    const del = store.deleteProject(VAULT, PROJECT);
    await new Promise((r) => setTimeout(r, 5));
    await store.loadProjects(VAULT);
    expect(store.projectEntries().some((e) => e.path === PROJECT)).toBe(true);
    await del;

    await store.writeProjectDoc(PROJECT, "- [ ] 迟到");
    expect(fs.files.has(PROJECT)).toBe(false);
  });

  it("deleting the currently focused project hands the focus back to the view", async () => {
    store.setFocusedProject(PROJECT);
    await store.deleteProject(VAULT, PROJECT);
    expect(store.focusedProjectPath()).toBeNull();
  });

  it("when the trash call fails the tombstone is withdrawn and the project can still be saved", async () => {
    // This case guards against the silent data loss of "the deletion failed ->
    // nothing can be written to the project anymore".
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

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
const PROJECT = "/vault/.bnote/projects-manager/读书.md";
const OTHER = "/vault/.bnote/projects-manager/写作.md";

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

describe("listing the projects", () => {
  it("keeps only markdown files, names them after the file and sorts by name", async () => {
    fs.files.clear();
    fs.files.set("/vault/.bnote/projects-manager/写作.md", "");
    fs.files.set("/vault/.bnote/projects-manager/读书.MD", "");
    fs.files.set("/vault/.bnote/projects-manager/notes.txt", "");
    fs.files.set("/vault/.bnote/projects-manager/.DS_Store", "");
    fs.files.set("/vault/.bnote/projects-manager/sub/嵌套.md", "");

    await store.loadProjects(VAULT);

    const entries = store.projectEntries();
    expect(entries.map((e) => e.name).sort()).toEqual(["写作", "读书"]);
    // The order is the locale collation the card list relies on (a sub-folder
    // is not a project).
    expect(entries.map((e) => e.name)).toEqual(
      ["写作", "读书"].sort((a, b) => a.localeCompare(b, "zh")),
    );
    expect(entries.map((e) => e.path).sort()).toEqual([
      "/vault/.bnote/projects-manager/写作.md",
      "/vault/.bnote/projects-manager/读书.MD",
    ]);
  });

  it("a missing directory is an empty list, not an error", async () => {
    fs.files.clear();
    await store.loadProjects(VAULT);
    expect(store.projectEntries()).toEqual([]);
  });

  it("a trailing slash on the vault root does not double the separator", async () => {
    await store.loadProjects(`${VAULT}/`);
    expect(store.projectEntries()[0]?.path).toBe(PROJECT);
  });

  it("notifies subscribers only when the list really changed", async () => {
    const seen: number[] = [];
    const off = store.subscribeProjects(() => seen.push(store.projectsRevision()));
    const before = store.projectsRevision();

    await store.loadProjects(VAULT);
    expect(seen).toEqual([]);
    expect(store.projectsRevision()).toBe(before);

    fs.files.set(OTHER, "- [ ] 乙");
    fs.files.set("/vault/.bnote/projects-manager/新.md", "");
    await store.loadProjects(VAULT);
    expect(seen).toHaveLength(1);
    expect(store.projectsRevision()).toBe(before + 1);
    off();
  });

  it("a listing that is overtaken by a newer one is dropped (stale snapshot)", async () => {
    const api = (await import("@/lib/tauri")).api as unknown as {
      readDir: (rel: string) => Promise<unknown>;
    };
    const original = api.readDir;
    const gate: { open: (() => void) | null } = { open: null };
    api.readDir = async () => {
      await new Promise<void>((resolve) => (gate.open = resolve));
      return [
        {
          name: "旧的.md",
          relPath: ".bnote/projects-manager/旧的.md",
          kind: "file",
          children: null,
        },
      ];
    };

    const stale = store.loadProjects(VAULT);
    api.readDir = original;
    fs.files.set("/vault/.bnote/projects-manager/新的.md", "");
    await store.loadProjects(VAULT);
    gate.open?.();
    await stale;

    const names = store.projectEntries().map((e) => e.name);
    expect(names).toContain("新的");
    expect(names).not.toContain("旧的");
  });
});

describe("the document cache", () => {
  it("a read populates the cache and the next read does not touch the disk", async () => {
    const api = (await import("@/lib/tauri")).api as unknown as {
      readFile: (path: string) => Promise<string>;
    };
    const spy = vi.spyOn(api, "readFile");

    expect(await store.readProjectDoc(PROJECT)).toBe("- [ ] 甲");
    expect(await store.readProjectDoc(PROJECT)).toBe("- [ ] 甲");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("a failed read is an empty document and it is cached as such", async () => {
    const missing = "/vault/.bnote/projects-manager/没有.md";
    expect(await store.readProjectDoc(missing)).toBe("");
    expect(store.cachedProjectDoc(missing)).toBe("");
  });

  it("writing updates the cache before the disk round trip", () => {
    store.setCachedProjectDoc(PROJECT, "- [ ] 内存");
    expect(store.cachedProjectDoc(PROJECT)).toBe("- [ ] 内存");
  });

  it("a listing drops the cached documents of projects that no longer exist", async () => {
    await store.readProjectDoc(PROJECT);
    await store.readProjectDoc(OTHER);

    fs.files.delete(PROJECT);
    await store.loadProjects(VAULT);

    expect(store.cachedProjectDoc(PROJECT)).toBeUndefined();
    expect(store.cachedProjectDoc(OTHER)).toBe("- [ ] 乙");
  });

  it("a deleted project reads back empty even when the disk still has bytes", async () => {
    await store.deleteProject(VAULT, PROJECT);
    fs.files.set(PROJECT, "- [ ] 幽灵");

    expect(await store.readProjectDoc(PROJECT)).toBe("");
    expect(store.cachedProjectDoc(PROJECT)).toBeUndefined();
  });

  it("caching a document of a deleted project is dropped", async () => {
    await store.deleteProject(VAULT, PROJECT);
    store.setCachedProjectDoc(PROJECT, "- [ ] 幽灵");
    expect(store.cachedProjectDoc(PROJECT)).toBeUndefined();
  });

  it("a failed write is logged, not thrown into the editor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = (await import("@/lib/tauri")).api as unknown as {
      writeFile: (path: string, text: string) => Promise<void>;
    };
    const original = api.writeFile;
    api.writeFile = async () => {
      throw new Error("DISK_FULL");
    };

    await store.writeProjectDoc(PROJECT, "- [ ] 写不进去");

    api.writeFile = original;
    expect(warn).toHaveBeenCalledWith("project save failed", expect.any(Error));
    warn.mockRestore();
  });

  it("the external refresh only reloads the list, keeping the document cache", async () => {
    await store.readProjectDoc(PROJECT);
    fs.files.set("/vault/.bnote/projects-manager/新.md", "");

    await store.refreshProjects(VAULT);

    expect(store.projectEntries().map((e) => e.name)).toContain("新");
    expect(store.cachedProjectDoc(PROJECT)).toBe("- [ ] 甲");
  });
});

describe("creating a project", () => {
  it("creates a file with a first todo line and returns the real entry", async () => {
    const created = await store.createProject(VAULT, "新项目");

    expect(created).toEqual({ name: "新项目", path: "/vault/.bnote/projects-manager/新项目.md" });
    expect(fs.files.get(created?.path ?? "")).toBe("- [ ] ");
    expect(store.projectEntries().map((e) => e.name)).toContain("新项目");
  });

  it("sanitizes the name and dedupes through the backend (name 2.md)", async () => {
    const created = await store.createProject(VAULT, "读/书:计划");
    expect(created?.name).toBe("读 书 计划");

    const api = (await import("@/lib/tauri")).api as unknown as {
      createFile: (parent: string, name: string) => Promise<{ path: string; relPath: string }>;
    };
    const original = api.createFile;
    api.createFile = async (parent: string, name: string) => {
      // The backend refuses an existing name by deduplicating it.
      if (name === "读书.md")
        return { path: `${VAULT}/.bnote/projects-manager/读书 2.md`, relPath: "" };
      return original(parent, name);
    };
    const second = await store.createProject(VAULT, "读书");
    api.createFile = original;

    expect(second?.name).toBe("读书 2");
  });

  it("a name that sanitizes to nothing creates no project", async () => {
    expect(await store.createProject(VAULT, "   ")).toBeNull();
    expect(await store.createProject(VAULT, "///")).toBeNull();
  });

  it("creating a project clears a stale tombstone for that path", async () => {
    await store.deleteProject(VAULT, PROJECT);
    fs.files.delete(PROJECT);

    const created = await store.createProject(VAULT, "读书");
    await store.writeProjectDoc(created?.path ?? "", "- [ ] 重新开始");

    expect(fs.files.get(created?.path ?? "")).toBe("- [ ] 重新开始");
  });
});

describe("focus traversal", () => {
  it("moves to the next and previous project and stops at the boundary", () => {
    store.setFocusedProject(OTHER);
    store.focusAdjacentProject(-1);
    expect(store.focusedProjectPath()).toBe(PROJECT);
    store.focusAdjacentProject(-1);
    expect(store.focusedProjectPath()).toBe(PROJECT);

    store.focusAdjacentProject(1);
    expect(store.focusedProjectPath()).toBe(OTHER);
    store.focusAdjacentProject(1);
    expect(store.focusedProjectPath()).toBe(OTHER);
  });

  it("without a focus the first step enters from the correct end", () => {
    store.setFocusedProject(null);
    store.focusAdjacentProject(1);
    expect(store.focusedProjectPath()).toBe(PROJECT);

    store.setFocusedProject(null);
    store.focusAdjacentProject(-1);
    expect(store.focusedProjectPath()).toBe(OTHER);
  });

  it("an empty list moves nowhere", async () => {
    fs.files.clear();
    await store.loadProjects(VAULT);
    store.setFocusedProject(null);
    store.focusAdjacentProject(1);
    expect(store.focusedProjectPath()).toBeNull();
  });

  it("focusing the same project again does not wake subscribers", () => {
    store.setFocusedProject(PROJECT);
    let writes = 0;
    const off = store.subscribeProjects(() => writes++);
    store.setFocusedProject(PROJECT);
    expect(writes).toBe(0);
    store.setFocusedProject(OTHER);
    expect(writes).toBe(1);
    off();
  });
});

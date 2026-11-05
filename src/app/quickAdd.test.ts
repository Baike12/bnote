import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The creation chain of quick add: the command has a template → the new
 * file's content is the rendered template text; when the template cannot be
 * read, an empty file is created anyway and the reason is reported. The
 * store's toast is an assertion target too.
 */

const disk = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/tauri", () => ({
  api: {
    createFile: async (parent: string, name: string) => {
      const relPath = parent ? `${parent}/${name}` : name;
      const path = `/v/${relPath}`;
      disk.set(path, "");
      return { path, relPath };
    },
    ensureDir: async () => {},
    readFile: async (path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    writeFile: async (path: string, contents: string) => {
      disk.set(path, contents);
    },
    readTree: async () => [],
    listFiles: async () => ({ files: [], dirs: [], assets: [] }),
    readDir: async () => [],
  },
}));

vi.mock("@/editor/api", () => ({
  getView: () => null,
  activeEditors: () => [],
}));

import { useAppStore } from "@/state/appStore";
import { quickAddNote } from "./actions";

const TPL = "/v/Templates/会议.md";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 1, 9, 0, 0) });
  disk.clear();
  useAppStore.setState({
    vaultPath: "/v",
    currentFile: null,
    tree: [],
    folders: [],
    flatFiles: [],
    flatAssets: [],
    toast: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quick add: templates", () => {
  it("the command has a template: the new file content is the rendered template", async () => {
    disk.set(TPL, "# {{date}} 周会\n\n- [ ] 议题:{{title}}\n");
    await quickAddNote("Notes", "产品周会", "Templates/会议.md");
    expect(disk.get("/v/Notes/产品周会.md")).toBe("# 2026-11-01 周会\n\n- [ ] 议题:产品周会\n");
  });

  it("no template configured: the file stays empty (existing behaviour)", async () => {
    await quickAddNote("Notes", "随手记");
    expect(disk.get("/v/Notes/随手记.md")).toBe("");
  });

  it("the template file cannot be read: the file is still created and the reason is reported", async () => {
    const toasts: string[] = [];
    vi.spyOn(useAppStore.getState(), "showToast").mockImplementation((m) => {
      toasts.push(m);
    });
    await quickAddNote("Notes", "产品周会", "Templates/已删除.md");
    expect(disk.get("/v/Notes/产品周会.md")).toBe("");
    expect(toasts).toContain("模板读取失败，已创建空文件");
  });

  it("a template path escaping the repo (`..`): treated as not configured, no file is read", async () => {
    disk.set("/secret.md", "# 不该读\n");
    await quickAddNote("Notes", "x", "../secret.md");
    expect(disk.get("/v/Notes/x.md")).toBe("");
    expect(disk.get("/secret.md")).toBe("# 不该读\n");
  });
});

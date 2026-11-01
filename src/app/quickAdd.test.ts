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

describe("快速添加:模板", () => {
  it("命令配了模板:新文件内容是渲染后的模板", async () => {
    disk.set(TPL, "# {{date}} 周会\n\n- [ ] 议题:{{title}}\n");
    await quickAddNote("Notes", "产品周会", "Templates/会议.md");
    expect(disk.get("/v/Notes/产品周会.md")).toBe(
      "# 2026-11-01 周会\n\n- [ ] 议题:产品周会\n",
    );
  });

  it("没配模板:保持空文件(原有行为)", async () => {
    await quickAddNote("Notes", "随手记");
    expect(disk.get("/v/Notes/随手记.md")).toBe("");
  });

  it("模板文件读不到:照常建文件,并提示原因", async () => {
    const toasts: string[] = [];
    vi.spyOn(useAppStore.getState(), "showToast").mockImplementation((m) => {
      toasts.push(m);
    });
    await quickAddNote("Notes", "产品周会", "Templates/已删除.md");
    expect(disk.get("/v/Notes/产品周会.md")).toBe("");
    expect(toasts).toContain("模板读取失败，已创建空文件");
  });

  it("模板路径越出仓库(`..`):按未配置处理,不读任何文件", async () => {
    disk.set("/secret.md", "# 不该读\n");
    await quickAddNote("Notes", "x", "../secret.md");
    expect(disk.get("/v/Notes/x.md")).toBe("");
    expect(disk.get("/secret.md")).toBe("# 不该读\n");
  });
});

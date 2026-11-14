import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docPathField, setDocPath } from "@/editor/docPath";
import type { DailyIO } from "./engine";
import { captureTodo, formatTodoLine, insertTodoAtFront } from "./capture";

const appState = vi.hoisted(() => ({
  currentFile: null as string | null,
  vaultPath: "/v" as string | null,
  toast: vi.fn(),
  refreshTree: vi.fn(async () => {}),
  view: null as unknown as EditorView | null,
}));

vi.mock("@/editor/api", () => ({ getView: () => appState.view }));
vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({ currentFile: appState.currentFile, vaultPath: appState.vaultPath }),
  },
}));
vi.mock("@/app/actions", () => ({ refreshTree: appState.refreshTree }));
vi.mock("./runtime", () => ({
  runtimeDeps: () => ({
    io: {
      readFile: async () => null,
      writeFile: async () => {},
      readDir: async () => [],
    },
    vaultRoot: () => appState.vaultPath,
    today: () => "2026-10-26",
    toast: (msg: string) => appState.toast(msg),
    templatePath: () => null,
  }),
}));

import { captureTodoToToday } from "./capture";

const ROOT = "/v";
const TODAY = "2026-10-26";
const DAILY = `${ROOT}/Daily/${TODAY}.md`;
const PREV = `${ROOT}/Daily/2026-10-25.md`;

function fakeIO(files: Record<string, string>, dirNames: string[] = []) {
  const map = new Map(Object.entries(files));
  const io: DailyIO = {
    readFile: async (path) => map.get(path) ?? null,
    writeFile: async (path, content) => {
      map.set(path, content);
    },
    readDir: async (rel) => (rel === "Daily" ? dirNames : null),
  };
  return { map, io };
}

function deps(io: DailyIO, overrides: Partial<Parameters<typeof captureTodo>[1]> = {}) {
  return {
    vaultRoot: () => ROOT,
    today: () => TODAY,
    io,
    view: () => null,
    currentFile: () => null,
    refresh: vi.fn(async () => {}),
    toast: vi.fn(),
    templatePath: () => null,
    ...overrides,
  };
}

describe("formatTodoLine", () => {
  it("an empty input returns null", () => {
    expect(formatTodoLine("   \n  ")).toBeNull();
  });

  it("plain text gets the standard checkbox prefix", () => {
    expect(formatTodoLine("买牛奶")).toBe("- [ ] 买牛奶");
  });

  it("a line that is already a todo is kept as is (no second checkbox)", () => {
    expect(formatTodoLine("- [x] 已完成")).toBe("- [x] 已完成");
    expect(formatTodoLine("  * [ ] 子项")).toBe("* [ ] 子项");
  });

  it("multiple lines are folded into one line", () => {
    expect(formatTodoLine("第一行\n  第二行 ")).toBe("- [ ] 第一行 第二行");
  });
});

describe("insertTodoAtFront", () => {
  it("inserted before the first todo of the todo region", () => {
    expect(insertTodoAtFront("# d\n\n- [ ] 甲\n", "- [ ] 新")).toEqual({
      text: "# d\n\n- [ ] 新\n- [ ] 甲\n",
      line: 3,
    });
  });
});

describe("captureTodo", () => {
  it("the daily note exists: the todo lands at the very front, the file tree is not refreshed", async () => {
    const { map, io } = fakeIO({ [DAILY]: "# d\n\n- [ ] 甲\n" });
    const toast = vi.fn();
    const refresh = vi.fn(async () => {});
    const path = await captureTodo("新任务", deps(io, { toast, refresh }));
    expect(path).toBe(DAILY);
    expect(map.get(DAILY)).toBe("# d\n\n- [ ] 新任务\n- [ ] 甲\n");
    expect(refresh).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("已加入今日日记");
  });

  it("the daily note is missing: the creation copies the unfinished todos of the previous note, the new todo is still at the front", async () => {
    const { map, io } = fakeIO(
      {
        [PREV]: "# 2026-10-25\n\n- [ ] 未完成\n  - [ ] 子项\n- [x] 已完成\n",
      },
      ["2026-10-25.md"],
    );
    const refresh = vi.fn(async () => {});
    await captureTodo("今天的新任务", deps(io, { refresh }));
    expect(map.get(DAILY)).toBe("# 2026-10-26\n\n- [ ] 今天的新任务\n- [ ] 未完成\n  - [ ] 子项\n");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("no previous daily note: only the header and the new todo are written", async () => {
    const { map, io } = fakeIO({}, []);
    await captureTodo("新任务", deps(io));
    expect(map.get(DAILY)).toBe("# 2026-10-26\n\n- [ ] 新任务\n");
  });

  it("a daily note template is configured: the template opens the file, the new todo still follows the header immediately", async () => {
    const { map, io } = fakeIO({
      [`${ROOT}/Templates/日记.md`]: "# {{date}} · 记录\n\n## 计划\n",
    });
    await captureTodo("新任务", deps(io, { templatePath: () => "Templates/日记.md" }));
    expect(map.get(DAILY)).toBe("# 2026-10-26 · 记录\n\n- [ ] 新任务\n\n## 计划\n");
  });

  it("the daily note is open in the editor: the in-memory document is edited (autosave handles it), nothing is written to disk", async () => {
    const base = "# d\n\n- [ ] 甲\n";
    let state = EditorState.create({ doc: base, extensions: [docPathField] });
    state = state.update({ effects: setDocPath.of(DAILY) }).state;
    const view = {
      get state() {
        return state;
      },
      dom: { isConnected: true },
      dispatch(spec: Parameters<EditorState["update"]>[0]) {
        state = state.update(spec).state;
      },
    } as unknown as EditorView;
    const writeFile = vi.fn(async () => {});
    const io: DailyIO = {
      readFile: async () => base,
      writeFile,
      readDir: async () => null,
    };
    const path = await captureTodo(
      "新任务",
      deps(io, { view: () => view, currentFile: () => DAILY }),
    );
    expect(path).toBe(DAILY);
    expect(state.doc.toString()).toBe("# d\n\n- [ ] 新任务\n- [ ] 甲\n");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("no vault: nothing is written to disk and a toast is shown", async () => {
    const { io } = fakeIO({});
    const toast = vi.fn();
    const path = await captureTodo("新任务", deps(io, { vaultRoot: () => null, toast }));
    expect(path).toBeNull();
    expect(toast).toHaveBeenCalledWith("没有打开仓库");
  });
});

describe("captureTodoToToday: the app wiring", () => {
  it("an empty input returns null without touching the app state", async () => {
    appState.refreshTree.mockClear();
    await expect(captureTodoToToday("   \n ")).resolves.toBeNull();
    expect(appState.refreshTree).not.toHaveBeenCalled();
  });

  it("no vault open: the runtime toast reports it and nothing is created", async () => {
    appState.vaultPath = null;
    appState.toast.mockClear();
    await expect(captureTodoToToday("新任务")).resolves.toBeNull();
    expect(appState.toast).toHaveBeenCalledWith("没有打开仓库");
    appState.vaultPath = "/v";
  });
});

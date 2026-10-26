import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docPathField, setDocPath } from "@/editor/docPath";
import type { DailyIO } from "./engine";
import { captureTodo, formatTodoLine, insertTodoAtFront } from "./capture";

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
    ...overrides,
  };
}

describe("formatTodoLine", () => {
  it("空输入返回 null", () => {
    expect(formatTodoLine("   \n  ")).toBeNull();
  });

  it("普通文字补标准 checkbox", () => {
    expect(formatTodoLine("买牛奶")).toBe("- [ ] 买牛奶");
  });

  it("已是待办行则原样保留(不重复加 checkbox)", () => {
    expect(formatTodoLine("- [x] 已完成")).toBe("- [x] 已完成");
    expect(formatTodoLine("  * [ ] 子项")).toBe("* [ ] 子项");
  });

  it("多行折成一行", () => {
    expect(formatTodoLine("第一行\n  第二行 ")).toBe("- [ ] 第一行 第二行");
  });
});

describe("insertTodoAtFront", () => {
  it("插到待办区第一条之前", () => {
    expect(insertTodoAtFront("# d\n\n- [ ] 甲\n", "- [ ] 新")).toEqual({
      text: "# d\n\n- [ ] 新\n- [ ] 甲\n",
      line: 3,
    });
  });
});

describe("captureTodo", () => {
  it("日记已存在:待办落在最前方,不刷新文件树", async () => {
    const { map, io } = fakeIO({ [DAILY]: "# d\n\n- [ ] 甲\n" });
    const toast = vi.fn();
    const refresh = vi.fn(async () => {});
    const path = await captureTodo("新任务", deps(io, { toast, refresh }));
    expect(path).toBe(DAILY);
    expect(map.get(DAILY)).toBe("# d\n\n- [ ] 新任务\n- [ ] 甲\n");
    expect(refresh).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("已加入今日日记");
  });

  it("日记缺失:创建时复制上一篇未完成待办,新待办仍在最前", async () => {
    const { map, io } = fakeIO(
      {
        [PREV]: "# 2026-10-25\n\n- [ ] 未完成\n  - [ ] 子项\n- [x] 已完成\n",
      },
      ["2026-10-25.md"],
    );
    const refresh = vi.fn(async () => {});
    await captureTodo("今天的新任务", deps(io, { refresh }));
    expect(map.get(DAILY)).toBe(
      "# 2026-10-26\n\n- [ ] 今天的新任务\n- [ ] 未完成\n  - [ ] 子项\n",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("没有上一篇日记:只写头部与新待办", async () => {
    const { map, io } = fakeIO({}, []);
    await captureTodo("新任务", deps(io));
    expect(map.get(DAILY)).toBe("# 2026-10-26\n\n- [ ] 新任务\n");
  });

  it("日记正开在编辑器里:改内存文档(交给自动保存),不直接写盘", async () => {
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

  it("没有仓库时不落盘并提示", async () => {
    const { io } = fakeIO({});
    const toast = vi.fn();
    const path = await captureTodo("新任务", deps(io, { vaultRoot: () => null, toast }));
    expect(path).toBeNull();
    expect(toast).toHaveBeenCalledWith("没有打开仓库");
  });
});

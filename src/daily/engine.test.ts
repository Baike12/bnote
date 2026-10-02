import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Transaction, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { toggleTodo } from "@/editor/ops";
import { docPathField, setDocPath } from "@/editor/docPath";
import {
  applyIntents,
  dedupeIntents,
  intentsForRange,
  sendTodoToDaily,
  sweepTodosToDaily,
  type DailyDeps,
  type DailyIO,
  type Intent,
} from "./engine";
import {
  ensureLinks,
  flushLinksPersist,
  hasPendingLinksPersist,
  LinkStore,
  type DailyLink,
} from "./links";
import { isDailyPath } from "./model";

/** 元数据落盘的目标:真 API 在测试环境没有 IPC,只截获写出的字节。 */
const tauriWrites = vi.hoisted(() => [] as [string, string][]);
vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: async () => {
      throw new Error("测试环境无 IPC"); // ensureLinks 当空库
    },
    writeFile: async (path: string, content: string) => {
      tauriWrites.push([path, content]);
    },
  },
}));

/**
 * 夹具全部锚在 2026-09-23(日记路径、deps.today()、以及断言里那些 ✅ 戳)。
 * 戳由 todayStamp() 按**真实时钟**生成,所以这里把系统时钟也钉在夹具那一天——
 * 否则这套断言只在真实日期恰好是 09-23 的那天成立(2026-09-24 起一直红)。
 */
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 23, 10, 0, 0) });
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * 引擎级集成测试:真 EditorState + 真 toggleTodo 产生事务,经与
 * extension.ts 相同的「事务 → 意图 → 应用」管线驱动,内存 IO 承载日记与
 * 源文件。锁行为(勾选双向同步/子待办层级/自动同步与聚合/时间顺序/解链规则)。
 */

const VAULT = "/vault";
const DAILY = "/vault/Daily/2026-09-23.md";

function makeDocView(doc: string, path: string, cursors: number[] = [0]) {
  let state = EditorState.create({
    doc,
    extensions: [docPathField, EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
  });
  state = state.update({ effects: setDocPath.of(path) }).state;
  const transactions: Transaction[] = [];
  const view = {
    get state() {
      return state;
    },
    get dom() {
      return { isConnected: true };
    },
    dispatch: (spec: TransactionSpec) => {
      const tr = state.update(spec);
      if (tr.docChanged) transactions.push(tr);
      state = tr.state;
    },
  };
  return { view: view as unknown as EditorView, transactions };
}

function memIO() {
  const files = new Map<string, string>();
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
      async listFiles() {
        return [...files.keys()].map((k) => k.slice(VAULT.length + 1));
      },
    } as DailyIO,
  };
}

function deps(io: DailyIO, toasts: string[] = []): DailyDeps {
  return { io, vaultRoot: () => VAULT, today: () => "2026-09-23", toast: (m) => toasts.push(m) };
}

function makeLink(patch: Partial<DailyLink>): DailyLink {
  return {
    id: "l1",
    kind: "copied",
    day: "2026-09-23",
    srcPath: "/vault/p.md",
    dailyPath: DAILY,
    text: "任务甲",
    srcLine: 1,
    dailyLine: 3,
    ...patch,
  };
}

/** 与 extension.ts 相同的事务 → 意图管线(吃掉积攒的事务)。 */
function drainIntents(transactions: Transaction[], store: LinkStore, path: string): Intent[] {
  const fileLinks = store.forFile(path);
  const out: Intent[] = [];
  for (const tr of transactions.splice(0)) {
    if (!tr.docChanged) continue;
    if (tr.isUserEvent("input.bnote-daily-sync")) continue;
    const allow =
      !isDailyPath(path) && !tr.isUserEvent("input.paste") && !tr.isUserEvent("input.drop");
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) =>
      out.push(...intentsForRange(tr.startState.doc, tr.state.doc, fromA, toA, fromB, toB, fileLinks, allow)),
    );
  }
  return out;
}

async function sync(
  view: EditorView,
  path: string,
  transactions: Transaction[],
  io: DailyIO,
  store: LinkStore,
): Promise<void> {
  const intents = drainIntents(transactions, store, path);
  if (intents.length) await applyIntents(view, path, intents, deps(io), store);
}

describe("发送命令", () => {
  it("发送一级待办与子树:日记文件自动创建,映射持久", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const toasts: string[] = [];
    const { view } = makeDocView("# 项目\n\n- [ ] 写章节\n  - [ ] 查资料\n", "/vault/proj.md", [13]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 写章节\n  - [ ] 查资料\n");
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({ kind: "copied", text: "写章节", srcLine: 3, dailyLine: 3 });
    expect(toasts).toEqual(["已发送到今日日记"]);
  });

  it("发送时日记不存在:建出的文件先带上一篇的未完成待办,发送条目随后", async () => {
    const { files, io } = memIO();
    files.set("/vault/Daily/2026-09-22.md", "# 2026-09-22\n\n- [x] 昨天做完 ✅ 2026-09-22\n- [ ] 昨天没做完\n");
    const store = new LinkStore();
    const { view } = makeDocView("- [ ] 新任务\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 昨天没做完\n- [ ] 新任务\n");
  });

  it("第二次发送按时间顺序追加在既有条目之后", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const { view: v1 } = makeDocView("- [ ] 甲\n", "/vault/p.md", [0]);
    await sendTodoToDaily(v1, deps(io), store);
    const { view: v2 } = makeDocView("- [ ] 乙\n", "/vault/p.md", [0]);
    await sendTodoToDaily(v2, deps(io), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n- [ ] 乙\n");
  });

  it("在子待办行按下:子待办成为一级条目,自己的子树保持层级", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const { view } = makeDocView("- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n", "/vault/p.md", [8]);
    await sendTodoToDaily(view, deps(io), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 子\n  - [ ] 孙\n");
    expect(store.all()[0]).toMatchObject({ text: "子", srcLine: 2 });
  });

  it("重复按快捷键不重复发送", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const toasts: string[] = [];
    const { view } = makeDocView("- [ ] 甲\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    await sendTodoToDaily(view, deps(io, toasts), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n");
    expect(store.all()).toHaveLength(1);
    expect(toasts[1]).toBe("已在今日日记中,自动保持同步");
  });

  it("块根已链接时,在其子待办上按下也提示已同步", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const toasts: string[] = [];
    const { view } = makeDocView("- [ ] 父\n  - [ ] 子\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    const { view: v2 } = makeDocView("- [ ] 父\n  - [ ] 子\n", "/vault/p.md", [8]);
    await sendTodoToDaily(v2, deps(io, toasts), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 父\n  - [ ] 子\n");
    expect(store.all()).toHaveLength(1);
    expect(toasts[1]).toBe("已在今日日记中,自动保持同步");
  });

  it("完成记录被显式发送时升级为正式映射", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    store.upsert(makeLink({ id: "r1", kind: "recorded" }));
    files.set(DAILY, "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
    const toasts: string[] = [];
    const { view } = makeDocView("- [ ] 任务甲\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
    expect(store.getById("r1")?.kind).toBe("copied");
    expect(toasts).toEqual(["已在今日日记中,自动保持同步"]);
  });

  it("日记已有同文条目时认领而不重复追加", async () => {
    const { files, io } = memIO();
    files.set(DAILY, "# 2026-09-23\n\n- [ ] 手写的\n\n正文\n");
    const store = new LinkStore();
    const { view } = makeDocView("- [ ] 手写的\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 手写的\n\n正文\n");
    expect(store.all()[0]).toMatchObject({ text: "手写的", dailyLine: 3 });
  });

  it("今日日记文件被删除后再次发送:重建文件", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const toasts: string[] = [];
    const { view } = makeDocView("- [ ] 甲\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    files.delete(DAILY);
    await sendTodoToDaily(view, deps(io, toasts), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n");
    expect(store.all()).toHaveLength(1);
    expect(toasts[1]).toBe("已发送到今日日记");
  });

  it("今日日记里的条目被手工删掉后再次发送:重新追加", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const toasts: string[] = [];
    const { view } = makeDocView("- [ ] 甲\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    files.set(DAILY, "# 2026-09-23\n");
    await sendTodoToDaily(view, deps(io, toasts), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 甲\n");
    expect(toasts[1]).toBe("已发送到今日日记");
  });

  it("祖先映射的日记条目也没了:在子待办上按下重新发送", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const toasts: string[] = [];
    const { view } = makeDocView("- [ ] 父\n  - [ ] 子\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    files.set(DAILY, "# 2026-09-23\n");
    const { view: v2 } = makeDocView("- [ ] 父\n  - [ ] 子\n", "/vault/p.md", [8]);
    await sendTodoToDaily(v2, deps(io, toasts), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 子\n");
    expect(toasts[1]).toBe("已发送到今日日记");
  });

  it("昨天的映射不阻止今天发送(按日归属)", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const toasts: string[] = [];
    const yesterday = "/vault/Daily/2026-09-22.md";
    store.upsert(makeLink({ id: "y1", day: "2026-09-22", dailyPath: yesterday }));
    files.set(yesterday, "# 2026-09-22\n\n- [ ] 任务甲\n");
    const { view } = makeDocView("- [ ] 任务甲\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 任务甲\n");
    expect(files.get(yesterday)).toBe("# 2026-09-22\n\n- [ ] 任务甲\n"); // 昨天的映射保留
    expect(store.all()).toHaveLength(2);
    expect(toasts[0]).toBe("已发送到今日日记");
  });

  it("非待办行 / 日记文件自身 提示且不写盘", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const toasts: string[] = [];
    const { view } = makeDocView("普通文字\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io, toasts), store);
    expect(toasts).toEqual(["光标行不是待办"]);
    const { view: v2 } = makeDocView("- [ ] 甲\n", DAILY, [0]);
    await sendTodoToDaily(v2, deps(io, toasts), store);
    expect(toasts[1]).toBe("日记文件的头部就是待办列表,无需发送");
    expect(files.size).toBe(0);
  });
});

describe("自动同步(触碰即发)", () => {
  it("勾选未映射待办 → 发送到今日日记(带 ✅ 戳,勾选状态随行)", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 任务甲\n- [ ] 任务乙\n", "/vault/p.md", [0]);
    toggleTodo(view);
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
    expect(store.all()[0]).toMatchObject({ kind: "auto", text: "任务甲", srcLine: 1 });
  });

  it("未勾选待办被编辑也自动同步(存在即同步,不要求先勾选)", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 新任务\n", "/vault/p.md", [6]);
    view.dispatch({ changes: { from: 9, to: 9, insert: "!" } }); // 纯文本编辑,没勾选
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 新任务!\n");
    expect(store.all()[0]).toMatchObject({ kind: "auto", text: "新任务!" });
  });

  it("发送追加在既有条目之后(时间顺序)", async () => {
    const { files, io } = memIO();
    files.set(DAILY, "# 2026-09-23\n\n- [ ] 早上的事\n");
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 任务甲\n", "/vault/p.md", [0]);
    toggleTodo(view);
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 早上的事\n- [x] 任务甲 ✅ 2026-09-23\n");
  });

  it("发送建日记时也跟随:上一篇未完成在前,发送条目在后", async () => {
    const { files, io } = memIO();
    files.set("/vault/Daily/2026-09-22.md", "# 2026-09-22\n\n- [ ] 昨天没做完\n");
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 任务甲\n", "/vault/p.md", [0]);
    toggleTodo(view);
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 昨天没做完\n- [x] 任务甲 ✅ 2026-09-23\n");
  });

  it("记录型待办再取消完成:日记条目清掉、链接解除", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    store.upsert(makeLink({ id: "r1", kind: "recorded" }));
    files.set(DAILY, "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
    const { view, transactions } = makeDocView("- [x] 任务甲 ✅ 2026-09-23\n", "/vault/p.md", [0]);
    // 与 checkbox 点击一致:box 翻回 + 戳剥掉
    const line = view.state.doc.line(1);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "- [ ] 任务甲" } });
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n");
    expect(store.all()).toHaveLength(0);
  });

  it("子待办触碰(父未链接):整块随根发送,镜像语义保持原始层级", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n", "/vault/p.md", [8]);
    toggleTodo(view);
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 父\n  - [x] 子 ✅ 2026-09-23\n    - [ ] 孙\n");
    expect(store.all()[0]).toMatchObject({ kind: "auto", text: "父" });
  });

  it("子待办触碰(父已链接):随块镜像到日记,不重复发送", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    store.upsert(makeLink({ id: "p1", text: "父", srcLine: 1, dailyLine: 3 }));
    files.set(DAILY, "# 2026-09-23\n\n- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n");
    const { view, transactions } = makeDocView("- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n", "/vault/p.md", [8]);
    toggleTodo(view);
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 父\n  - [x] 子 ✅ 2026-09-23\n    - [ ] 孙\n");
    expect(store.all()).toHaveLength(1); // 没有为「子」新建链接
  });
});

describe("双向镜像", () => {
  it("源侧完成复制型待办:日记条目同步勾选,条目保留", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 任务甲\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io), store); // 建立映射
    const line = view.state.doc.line(1);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "- [x] 任务甲 ✅ 2026-09-23" } });
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
    expect(store.all()).toHaveLength(1);
  });

  it("源侧取消复制型待办:两侧回到未勾选,条目保留", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    store.upsert(makeLink({ id: "c1" }));
    files.set(DAILY, "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
    const { view, transactions } = makeDocView("- [x] 任务甲 ✅ 2026-09-23\n", "/vault/p.md", [0]);
    const line = view.state.doc.line(1);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "- [ ] 任务甲" } });
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 任务甲\n");
    expect(store.all()).toHaveLength(1); // 复制型:条目保留
  });

  it("日记侧勾选:镜像回源文件并带 ✅ 戳", async () => {
    const { files, io } = memIO();
    files.set("/vault/p.md", "- [ ] 任务甲\n");
    const store = new LinkStore();
    store.upsert(makeLink({ id: "c1" }));
    const { view, transactions } = makeDocView("# 2026-09-23\n\n- [ ] 任务甲\n", DAILY, [14]);
    const line = view.state.doc.line(3);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "- [x] 任务甲 ✅ 2026-09-23" } });
    await sync(view, DAILY, transactions, io, store);
    expect(files.get("/vault/p.md")).toBe("- [x] 任务甲 ✅ 2026-09-23\n");
  });

  it("日记侧加子待办:镜像回源并还原源根缩进", async () => {
    const { files, io } = memIO();
    files.set("/vault/p.md", "  - [ ] 任务甲\n");
    const store = new LinkStore();
    store.upsert(makeLink({ id: "c1" }));
    const { view, transactions } = makeDocView("# 2026-09-23\n\n- [ ] 任务甲\n", DAILY, [14]);
    const line = view.state.doc.line(3);
    view.dispatch({ changes: { from: line.to, insert: "\n  - [ ] 新子项" } });
    await sync(view, DAILY, transactions, io, store);
    expect(files.get("/vault/p.md")).toBe("  - [ ] 任务甲\n    - [ ] 新子项\n");
  });

  it("源侧改名:日记条目跟着改,链接锚迁移到新文本", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    store.upsert(makeLink({ id: "c1", text: "旧名" }));
    files.set(DAILY, "# 2026-09-23\n\n- [ ] 旧名\n");
    const { view, transactions } = makeDocView("- [ ] 旧名\n", "/vault/p.md", [0]);
    const line = view.state.doc.line(1);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "- [ ] 新名" } });
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 新名\n");
    expect(store.getById("c1")).toMatchObject({ text: "新名" });
  });

  it("源侧根转纯文本(待办取消):删日记条目并解链", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    store.upsert(makeLink({ id: "c1" }));
    files.set(DAILY, "# 2026-09-23\n\n- [ ] 任务甲\n");
    const { view, transactions } = makeDocView("- [ ] 任务甲\n", "/vault/p.md", [0]);
    const line = view.state.doc.line(1);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "任务甲" } });
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n");
    expect(store.all()).toHaveLength(0);
  });

  it("日记条目被用户删除:只解链,源待办保留", async () => {
    const { files, io } = memIO();
    files.set("/vault/p.md", "- [ ] 任务甲\n");
    const store = new LinkStore();
    store.upsert(makeLink({ id: "c1" }));
    const { view, transactions } = makeDocView("# 2026-09-23\n\n- [ ] 任务甲\n\n正文\n", DAILY, [0]);
    const line = view.state.doc.line(3);
    view.dispatch({ changes: { from: line.from, to: line.to + 1, insert: "" } });
    await sync(view, DAILY, transactions, io, store);
    expect(files.get("/vault/p.md")).toBe("- [ ] 任务甲\n");
    expect(store.all()).toHaveLength(0);
  });

  it("日记侧根转纯文本:只解链,源不动", async () => {
    const { files, io } = memIO();
    files.set("/vault/p.md", "- [ ] 任务甲\n");
    const store = new LinkStore();
    store.upsert(makeLink({ id: "c1" }));
    const { view, transactions } = makeDocView("# 2026-09-23\n\n- [ ] 任务甲\n", DAILY, [14]);
    const line = view.state.doc.line(3);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "任务甲" } });
    await sync(view, DAILY, transactions, io, store);
    expect(files.get("/vault/p.md")).toBe("- [ ] 任务甲\n");
    expect(store.all()).toHaveLength(0);
  });

  it("对侧文件不可读(删除/改名):解链不崩溃", async () => {
    const { files, io } = memIO();
    files.set(DAILY, "# 2026-09-23\n\n- [ ] 任务甲\n"); // 源文件 p.md 不在
    const store = new LinkStore();
    store.upsert(makeLink({ id: "c1" }));
    const { view, transactions } = makeDocView("# 2026-09-23\n\n- [ ] 任务甲\n", DAILY, [14]);
    const line = view.state.doc.line(3);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "- [x] 任务甲 ✅ 2026-09-23" } });
    await sync(view, DAILY, transactions, io, store);
    expect(store.all()).toHaveLength(0);
  });
});

describe("链接映射持久化", () => {
  it("发送建立的映射落盘;已同步的重复发送不再写元数据", async () => {
    const { io } = memIO();
    const store = await ensureLinks(VAULT);
    const { view } = makeDocView("- [ ] 甲\n", "/vault/p.md", [0]);
    await sendTodoToDaily(view, deps(io), store);
    expect(hasPendingLinksPersist()).toBe(true);
    flushLinksPersist();
    expect(tauriWrites.map(([p]) => p)).toEqual(["/vault/.bnote/daily-links.json"]);
    expect(LinkStore.fromJSON(tauriWrites[0]?.[1] ?? "").all()).toMatchObject([
      { kind: "copied", text: "甲", srcPath: "/vault/p.md" },
    ]);

    tauriWrites.length = 0;
    await sendTodoToDaily(view, deps(io), store); // 已在今日日记里,无事发生
    expect(hasPendingLinksPersist()).toBe(false);
    expect(tauriWrites).toHaveLength(0);
  });
});

describe("意图提取与合并", () => {
  const start = (t: string) => EditorState.create({ doc: t }).doc;
  const link = makeLink({ id: "L", text: "甲" });

  it("触碰未链接待办产生发送意图;已链接则改为镜像", () => {
    const s = start("- [ ] 甲\n");
    const e = start("- [x] 甲 ✅ 2026-09-23\n");
    expect(intentsForRange(s, e, 0, s.length, 0, e.length, [], true)).toEqual([
      { type: "send", rootHint: 1, text: "甲" },
    ]);
    expect(intentsForRange(s, e, 0, s.length, 0, e.length, [link], true)).toEqual([
      { type: "mirror", linkId: "L", rootHint: 1, renamedTo: "甲" },
    ]);
  });

  it("触碰嵌套待办:发送锚在块根,不是子行自己", () => {
    const s = start("- [ ] 父\n  - [ ] 子\n");
    const e = start("- [ ] 父\n  - [x] 子\n");
    expect(intentsForRange(s, e, 0, s.length, 0, e.length, [], true)).toEqual([
      { type: "send", rootHint: 1, text: "父" },
    ]);
  });

  it("空文本待办不自动发送(还在打字);普通文本行不是待办也不发", () => {
    const s = start("");
    const e = start("- [ ] \n");
    expect(intentsForRange(s, e, 0, 0, 0, e.length, [], true)).toEqual([]);
    const s2 = start("正文\n");
    const e2 = start("正文改\n");
    expect(intentsForRange(s2, e2, 0, s2.length, 0, e2.length, [], true)).toEqual([]);
  });

  it("改名携带新文本;根转纯文本时提示为空", () => {
    const s = start("- [ ] 旧名\n");
    const e = start("- [ ] 新名\n");
    expect(intentsForRange(s, e, 0, s.length, 0, e.length, [makeLink({ id: "L", text: "旧名" })], true)).toEqual([
      { type: "mirror", linkId: "L", rootHint: 1, renamedTo: "新名" },
    ]);
    const e2 = start("旧名\n");
    expect(intentsForRange(s, e2, 0, s.length, 0, e2.length, [makeLink({ id: "L", text: "旧名" })], true)).toEqual([
      { type: "mirror", linkId: "L", rootHint: null, renamedTo: null },
    ]);
  });

  it("粘贴/拖放事务不产生发送意图(allowSend=false)", () => {
    const s = start("- [ ] 甲\n");
    const e = start("- [x] 甲 ✅ 2026-09-23\n");
    expect(intentsForRange(s, e, 0, s.length, 0, e.length, [], false)).toEqual([]);
  });

  it("dedupeIntents:镜像按链接合并、发送按文本合并", () => {
    const out = dedupeIntents([
      { type: "mirror", linkId: "L", rootHint: null, renamedTo: null },
      { type: "mirror", linkId: "L", rootHint: 3, renamedTo: null },
      { type: "send", rootHint: 5, text: "甲" },
      { type: "send", rootHint: 9, text: "甲" },
    ]);
    expect(out).toEqual([
      { type: "mirror", linkId: "L", rootHint: 3, renamedTo: null },
      { type: "send", rootHint: 5, text: "甲" },
    ]);
  });
});


describe("每日聚合(sweepTodosToDaily)", () => {
  /** sweptKey 以 vault::day 占位,每个用例用独立日期避免互相污染。 */
  it("全仓聚合:各文件的未完成待办进日记,已完成叶子过滤,kind=auto", async () => {
    const { files, io } = memIO();
    files.set(DAILY, "# 2026-09-23\n");
    files.set(
      "/vault/Anc/anc todo.md",
      "# anc\n\n- [x] 已完成 ✅ 2026-09-22\n- [ ] 待办一\n  - [x] 中间 ✅ 2026-09-22\n    - [ ] 待办二\n",
    );
    files.set("/vault/Job/job todo.md", "# job\n\n- [ ] 任务乙\n");
    files.set("/vault/Daily/2026-09-22.md", "# 2026-09-22\n\n- [ ] 别聚合日记自己\n");
    files.set("/vault/.bnote/meta.md", "- [ ] 别聚配置目录\n");
    files.set("/vault/notes.txt", "- [ ] 别聚非 md\n");
    const store = new LinkStore();
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-23", store)).toBe(true);
    expect(files.get(DAILY)).toBe(
      "# 2026-09-23\n\n- [ ] 待办一\n  - [x] 中间 ✅ 2026-09-22\n    - [ ] 待办二\n- [ ] 任务乙\n",
    );
    expect(store.all()).toHaveLength(2);
    expect(store.all()[0]).toMatchObject({
      kind: "auto",
      day: "2026-09-23",
      srcPath: "/vault/Anc/anc todo.md",
      dailyPath: DAILY,
      text: "待办一",
      srcLine: 4,
    });
    expect(store.all()[1]).toMatchObject({ text: "任务乙", srcLine: 3 });
  });

  it("同日幂等:再扫一遍不重复追加、不新建链接", async () => {
    const { files, io } = memIO();
    const daily = "/vault/Daily/2026-09-24.md";
    files.set(daily, "# 2026-09-24\n");
    files.set("/vault/p.md", "- [ ] 甲\n");
    const store = new LinkStore();
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-24", store)).toBe(true);
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-24", store)).toBe(false);
    expect(files.get(daily)).toBe("# 2026-09-24\n\n- [ ] 甲\n");
    expect(store.all()).toHaveLength(1);
  });

  it("认领日记里已有的同文条目(rollover 带来的),不重复追加", async () => {
    const { files, io } = memIO();
    const daily = "/vault/Daily/2026-09-25.md";
    files.set(daily, "# 2026-09-25\n\n- [ ] 甲\n");
    files.set("/vault/p.md", "- [ ] 甲\n  - [ ] 子项\n");
    const store = new LinkStore();
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-25", store)).toBe(true);
    expect(files.get(daily)).toBe("# 2026-09-25\n\n- [ ] 甲\n"); // 字节不动
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({ text: "甲", dailyLine: 3 });
  });

  it("跨文件同文:先到先得,不重复建链接", async () => {
    const { files, io } = memIO();
    const daily = "/vault/Daily/2026-09-26.md";
    files.set(daily, "# 2026-09-26\n");
    files.set("/vault/a.md", "- [ ] 同名\n");
    files.set("/vault/b.md", "- [ ] 同名\n");
    const store = new LinkStore();
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-26", store)).toBe(true);
    expect(files.get(daily)).toBe("# 2026-09-26\n\n- [ ] 同名\n");
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].srcPath).toBe("/vault/a.md");
  });

  it("过期 auto 链接按日清理;显式发送的 copied 不动", async () => {
    const { files, io } = memIO();
    files.set("/vault/Daily/2026-09-27.md", "# 2026-09-27\n");
    const store = new LinkStore();
    store.upsert(makeLink({ id: "old", kind: "auto", day: "2026-09-22" }));
    store.upsert(makeLink({ id: "keep", kind: "copied", day: "2026-09-22" }));
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-27", store)).toBe(true);
    expect(store.getById("old")).toBeNull();
    expect(store.getById("keep")).not.toBeNull();
  });

  it("今日日记不存在:放弃且不占位,建好后再扫成功", async () => {
    const { files, io } = memIO();
    files.set("/vault/p.md", "- [ ] 甲\n");
    const store = new LinkStore();
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-28", store)).toBe(false);
    files.set(DAILY, "# 2026-09-28.md placeholder");
    files.set("/vault/Daily/2026-09-28.md", "# 2026-09-28\n");
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-28", store)).toBe(true);
    expect(files.get("/vault/Daily/2026-09-28.md")).toBe("# 2026-09-28\n\n- [ ] 甲\n");
  });

  it("次日再聚:昨天的日记不聚合(rollover 管),今天重新链接源文件", async () => {
    const { files, io } = memIO();
    files.set("/vault/Daily/2026-09-29.md", "# 2026-09-29\n");
    files.set("/vault/p.md", "- [ ] 甲\n");
    const store = new LinkStore();
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-29", store)).toBe(true);
    const nextDay = "/vault/Daily/2026-09-30.md";
    files.set(nextDay, "# 2026-09-30\n");
    expect(await sweepTodosToDaily(io, VAULT, "2026-09-30", store)).toBe(true);
    expect(files.get(nextDay)).toBe("# 2026-09-30\n\n- [ ] 甲\n");
    expect(store.all().filter((l) => l.day === "2026-09-30")).toHaveLength(1);
    expect(store.all().filter((l) => l.kind === "auto" && l.day === "2026-09-29")).toHaveLength(0);
  });
});

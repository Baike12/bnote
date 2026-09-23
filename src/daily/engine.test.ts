import { describe, expect, it } from "vitest";
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
  type DailyDeps,
  type DailyIO,
  type Intent,
} from "./engine";
import { LinkStore, type DailyLink } from "./links";
import { isDailyPath } from "./model";

/**
 * 引擎级集成测试:真 EditorState + 真 toggleTodo 产生事务,经与
 * extension.ts 相同的「事务 → 意图 → 应用」管线驱动,内存 IO 承载日记与
 * 源文件。锁行为(勾选双向同步/子待办层级/记录与清理/时间顺序/解链规则)。
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

describe("完成记录(自动)", () => {
  it("勾选未映射待办 → 记录到今日日记(带 ✅ 戳,勾选状态随行)", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 任务甲\n- [ ] 任务乙\n", "/vault/p.md", [0]);
    toggleTodo(view);
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
    expect(store.all()[0]).toMatchObject({ kind: "recorded", text: "任务甲", srcLine: 1 });
  });

  it("记录追加在既有条目之后(时间顺序)", async () => {
    const { files, io } = memIO();
    files.set(DAILY, "# 2026-09-23\n\n- [ ] 早上的事\n");
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 任务甲\n", "/vault/p.md", [0]);
    toggleTodo(view);
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [ ] 早上的事\n- [x] 任务甲 ✅ 2026-09-23\n");
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

  it("子待办勾选(父未链接):子待办作为一级记录,子树随行", async () => {
    const { files, io } = memIO();
    const store = new LinkStore();
    const { view, transactions } = makeDocView("- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n", "/vault/p.md", [8]);
    toggleTodo(view);
    await sync(view, "/vault/p.md", transactions, io, store);
    expect(files.get(DAILY)).toBe("# 2026-09-23\n\n- [x] 子 ✅ 2026-09-23\n  - [ ] 孙\n");
  });

  it("子待办勾选(父已链接):随块镜像到日记,不单独记录", async () => {
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

describe("意图提取与合并", () => {
  const start = (t: string) => EditorState.create({ doc: t }).doc;
  const link = makeLink({ id: "L", text: "甲" });

  it("勾选翻转产生记录意图;祖先已链接则改为镜像", () => {
    const s = start("- [ ] 甲\n");
    const e = start("- [x] 甲 ✅ 2026-09-23\n");
    expect(intentsForRange(s, e, 0, s.length, 0, e.length, [], true)).toEqual([
      { type: "record", rootHint: 1, text: "甲" },
    ]);
    expect(intentsForRange(s, e, 0, s.length, 0, e.length, [link], true)).toEqual([
      { type: "mirror", linkId: "L", rootHint: 1, renamedTo: "甲" },
    ]);
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

  it("粘贴/拖放事务不产生记录意图(allowRecord=false)", () => {
    const s = start("- [ ] 甲\n");
    const e = start("- [x] 甲 ✅ 2026-09-23\n");
    expect(intentsForRange(s, e, 0, s.length, 0, e.length, [], false)).toEqual([]);
  });

  it("dedupeIntents:镜像按链接合并、记录按文本合并", () => {
    const out = dedupeIntents([
      { type: "mirror", linkId: "L", rootHint: null, renamedTo: null },
      { type: "mirror", linkId: "L", rootHint: 3, renamedTo: null },
      { type: "record", rootHint: 5, text: "甲" },
      { type: "record", rootHint: 9, text: "甲" },
    ]);
    expect(out).toEqual([
      { type: "mirror", linkId: "L", rootHint: 3, renamedTo: null },
      { type: "record", rootHint: 5, text: "甲" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { commandMappingKeymap, lookupVimCommand, vimCapturesKey } from "./vim";
import { buildSession, escapeForSnippet, setSession, snippetField, type SnippetSession } from "@/editor/snippets/extension";
import { parseReplacement } from "@/editor/snippets/engine";
import { useAppStore } from "@/state/appStore";

/**
 * 「普通模式 Enter/Backspace 被改写、活会话吃掉第一下 Esc」的根因回归。
 *
 * CM6 把所有 keyBindings 汇进一个共享 keydown 处理器，flatten 在第一个
 * keymap.of 声明的位置（baseExtensions 里 snippetsExtension() 最靠前），排在
 * vim 引擎之前；而引擎自己的链入口从不返回 true（以副作用动作、从不认领
 * 事件）。于是凡是被任何 keymap 绑过的键，引擎永远轮不到：普通模式 Enter
 * 落到 defaultKeymap 的 insertNewlineAndIndent（凭空插行）、Backspace 落到
 * deleteCharBackward（删字）；活片段会话把第一下 Esc 吃掉（退出要按两下）。
 *
 * 修复的两条契约在这里锁死（分发顺序本身要 DOM，浏览器协议验证）：
 * 1. vimCapturesKey：捕获分发器只接管 normal/visual，insert 让路给
 *    snippet/latex 的编辑增强，IME 组合/死键/上游已认领一律不碰；
 * 2. 命令映射注册表：`nmap <C-b> :Bnote…` 与引擎原生 <C-b>（翻页）冲突，
 *    捕获分发要在引擎之前查它；vimrc 删掉的映射不残留。
 * 3. snippet 的 Esc 门控：vim 开启时让引擎先退插入态。
 */

const capturesBase = {
  insertMode: false,
  composing: false,
  deadKey: false,
  targetIsContentDOM: true,
  defaultPrevented: false,
};

describe("vimCapturesKey：捕获分发的决策核", () => {
  it("normal/visual 模式交给引擎", () => {
    expect(vimCapturesKey(capturesBase)).toBe(true);
  });

  it("insert 让路：snippet 的 Tab/Escape、latex 的 Backspace 在插入态合法地先跑", () => {
    expect(vimCapturesKey({ ...capturesBase, insertMode: true })).toBe(false);
  });

  it("IME 组合中/死键/上游已认领/目标不在编辑内容上 → 不碰", () => {
    expect(vimCapturesKey({ ...capturesBase, composing: true })).toBe(false);
    expect(vimCapturesKey({ ...capturesBase, deadKey: true })).toBe(false);
    expect(vimCapturesKey({ ...capturesBase, defaultPrevented: true })).toBe(false);
    expect(vimCapturesKey({ ...capturesBase, targetIsContentDOM: false })).toBe(false);
  });
});

describe("lookupVimCommand：命令映射注册表（捕获分发先于引擎查它）", () => {
  const mappings = [
    { lhs: "<C-s>", rhs: ":w<CR>", mode: "normal" as const, commandId: "workspace.save-note", noremap: false },
    {
      lhs: "<C-b>",
      rhs: ":Bnote nav.toggle-sidebar<CR>",
      mode: "normal" as const,
      commandId: "nav.toggle-sidebar",
      noremap: false,
    },
    // 多键 lhs：keymap 兜不住（normalizeVimKey 返回 null），不进注册表
    { lhs: "gs", rhs: ":Bnote x.y<CR>", mode: "normal" as const, commandId: "x.y", noremap: false },
  ];

  it("按 模式\\0引擎键词 命中；模式不符/未绑定不命中", () => {
    commandMappingKeymap(mappings);
    expect(lookupVimCommand("<C-b>", "normal")).toBe("nav.toggle-sidebar");
    expect(lookupVimCommand("<C-s>", "normal")).toBe("workspace.save-note");
    expect(lookupVimCommand("<C-b>", "insert")).toBeUndefined();
    expect(lookupVimCommand("<C-z>", "normal")).toBeUndefined();
  });

  it("多键 lhs 不进注册表（与 keymap 同口径）", () => {
    commandMappingKeymap(mappings);
    expect(lookupVimCommand("gs", "normal")).toBeUndefined();
  });

  it("重建即全量替换：vimrc 删掉的映射不残留", () => {
    commandMappingKeymap(mappings.slice(0, 1));
    expect(lookupVimCommand("<C-b>", "normal")).toBeUndefined();
    expect(lookupVimCommand("<C-s>", "normal")).toBe("workspace.save-note");
  });
});

/* ---- escapeForSnippet：活会话不得吃掉 vim 的第一下 Esc ---- */

function withSession(doc: string, session: SnippetSession | null): EditorState {
  const base = EditorState.create({ doc, extensions: [snippetField] });
  return base.update({ effects: setSession.of(session) }).state;
}

function fakeView(initial: EditorState): EditorView {
  let current = initial;
  return {
    get state() {
      return current;
    },
    dispatch: (spec: TransactionSpec) => {
      current = current.update(spec).state;
    },
  } as unknown as EditorView;
}

const dmSession = () => buildSession(0, parseReplacement("$$\n$0\n$$", [], null))!;

describe("escapeForSnippet：活会话不得吃掉 vim 的第一下 Esc", () => {
  it("vim 开启 → 返回 false（放行给引擎退插入态），会话原样保留", () => {
    useAppStore.getState().patchSettings({ vim: true });
    const view = fakeView(withSession("$$\nx\n$$", dmSession()));
    expect(escapeForSnippet(view)).toBe(false);
    expect(view.state.field(snippetField, false)).not.toBeNull();
  });

  it("vim 关闭 → 维持 latex-suite 语义：Esc 结束会话", () => {
    useAppStore.getState().patchSettings({ vim: false });
    const view = fakeView(withSession("$$\nx\n$$", dmSession()));
    expect(escapeForSnippet(view)).toBe(true);
    expect(view.state.field(snippetField, false)).toBeNull();
  });
});

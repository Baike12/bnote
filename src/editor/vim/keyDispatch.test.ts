import { describe, expect, it } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { commandMappingKeymap, lookupVimCommand, vimCapturesKey } from "./vim";
import { buildSession, escapeForSnippet, setSession, snippetField, type SnippetSession } from "@/editor/snippets/extension";
import { parseReplacement } from "@/editor/snippets/engine";
import { useAppStore } from "@/state/appStore";

/**
 * Root-cause regression for "normal-mode Enter/Backspace get rewritten and a
 * live session swallows the first Esc".
 *
 * CM6 funnels all keyBindings into one shared keydown handler, flattened at
 * the position of the first keymap.of declaration (in baseExtensions that is
 * snippetsExtension(), the earliest one), so it runs before the vim engine.
 * The engine's own chain entry never returns true (it acts through side
 * effects and never claims the event), so any key bound by some keymap never
 * reaches the engine: in normal mode Enter lands on defaultKeymap's
 * insertNewlineAndIndent (inserting a line out of nowhere) and Backspace on
 * deleteCharBackward (deleting a character); a live snippet session swallows
 * the first Esc (so leaving takes two presses).
 *
 * The two contracts of the fix are locked here (the dispatch order itself
 * needs a DOM and is verified in the browser):
 * 1. vimCapturesKey: the capture dispatcher only takes over in normal/visual
 *    mode; insert mode yields to the snippet/latex editing enhancements, and
 *    IME composition, dead keys and already-claimed events are never touched;
 * 2. the command mapping registry: `nmap <C-b> :Bnote…` collides with the
 *    engine's native <C-b> (page down), so the capture dispatch must consult
 *    it before the engine; mappings deleted from the vimrc do not linger.
 * 3. the snippet Esc gate: with vim enabled the engine leaves insert mode
 *    first.
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
    // Multi-key lhs: the keymap cannot catch it (normalizeVimKey returns
    // null), so it stays out of the registry
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

/* ---- escapeForSnippet: a live session must not swallow vim's first Esc ---- */

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

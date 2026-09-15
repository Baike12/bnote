import { vim, Vim, getCM, CodeMirror } from "@replit/codemirror-vim";

// Re-exported for harness/debug access to the underlying engine singleton.
export { Vim, getCM };
import type { EditorView, KeyBinding } from "@codemirror/view";
import { keymap, ViewPlugin, Decoration } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { EditorSelection, RangeSetBuilder } from "@codemirror/state";
import { setSearchQuery, SearchQuery } from "@codemirror/search";
import type { VimMapping, VimMode } from "./vimrc";
import { readClipboardText, writeClipboardText } from "@/lib/clipboard";

export type RunCommand = (commandId: string) => void;

let runCommandRef: RunCommand = () => {};

/** :w / :wq / :q … plus :Bnote <command-id> for any bnote command. */
export function registerVimExCommands(run: RunCommand) {
  runCommandRef = run;
  Vim.defineEx("write", "w", () => run("workspace.save-note"));
  Vim.defineEx("wq", "wq", () => {
    run("workspace.save-note");
    run("workspace.close-window");
  });
  Vim.defineEx("x", "x", () => {
    run("workspace.save-note");
    run("workspace.close-window");
  });
  Vim.defineEx("quit", "q", () => run("workspace.close-window"));
  Vim.defineEx("noh", "noh", (cm) => {
    const view = (cm as unknown as { cm6: EditorView }).cm6;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  });
  Vim.defineEx("Bnote", "B", (_cm, params) => {
    const id = (params?.args ?? [])[0];
    if (id) run(id);
  });
}

export function vimModeExtension(): Extension {
  patchVimNewlineIndent();
  patchVimNotice();
  return vim();
}

/* ---- 底部消息：屏蔽 yank 提示，其余消息改成"按任意键收掉"。
   引擎的消息都走 showConfirm → openNotification（适配器独有的出口）：
   - yank 每次都会弹一条 1.5s 的红色 "N lines yanked"。vim 里这条归 report 选项管，
     引擎没实现该开关，也没有任何 option 能关掉它，所以在这一层按内容丢掉；
   - 其余消息（报错、:set 回显等）引擎只挂了个 15s 定时器：关不掉、只能干等。
     vim 的手感是"下一条命令/按键就清掉"，所以这里把 close 挂到
     state.closeVimNotification 上——引擎自己的按键路径（multiSelectHandleKey）
     下一次按键就会调用它。长消息（需要回车确认的 :reg）引擎自己会挂，行为不变。 ---- */

let noticePatched = false;

/** showConfirm 拼出的 yank 消息：`N lines yanked`，带寄存器时尾部是 `into "a`
    （引擎少拼了一个右引号，别按正常引号对写）。两个调用点都是这个形状。 */
const YANK_NOTICE = /^\d+ lines yanked(?: into ".+)?$/;

/** 非阻塞消息的停留时长；引擎默认 15s，按 vim 的手感调短（按键仍可立刻收掉）。 */
const NOTICE_MS = 4000;

function patchVimNotice() {
  if (noticePatched) return;
  noticePatched = true;
  try {
    const proto = CodeMirror.prototype as unknown as {
      openNotification: (
        this: { state: { closeVimNotification?: (() => void) | null } },
        template: HTMLElement,
        options?: { duration?: number },
      ) => (() => void) | undefined;
    };
    const open = proto.openNotification;
    proto.openNotification = function (template, options) {
      if (YANK_NOTICE.test(template.textContent?.trim() ?? "")) return undefined;
      // duration 0 = 需要回车确认的长消息，保持原样。
      const duration = Math.min(options?.duration ?? NOTICE_MS, NOTICE_MS);
      const close = open.call(this, template, { ...options, duration });
      if (typeof close === "function") this.state.closeVimNotification = close;
      return close;
    };
  } catch (e) {
    console.warn("[bnote] vim notice patch failed", e);
  }
}

/* ---- vim o/O indent compat: the engine implements `o`/`O` via CM6's
   insertNewlineAndIndent, which expands a tab indent to spaces (tabStop
   columns). Vim copies the leading whitespace verbatim — patch the shim
   command and the open-line action so o/O keep tabs and exact spaces
   (O takes the CURRENT line's indent, not the line above's). ---- */

let newlineIndentPatched = false;

function patchVimNewlineIndent() {
  if (newlineIndentPatched) return;
  newlineIndentPatched = true;
  try {
    const VimAny = Vim as unknown as Record<string, any>;
    const commands = (CodeMirror as unknown as {
      commands: Record<string, ((cm: { cm6: EditorView }) => void) | undefined>;
    }).commands;
    // Safety net for other engine paths that newline-and-indent.
    commands.newlineAndIndent = (cm) => {
      const view = cm.cm6;
      const state = view.state;
      view.dispatch(
        state.update(
          state.changeByRange((range) => {
            const line = state.doc.lineAt(range.head);
            const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
            return {
              changes: { from: range.head, insert: state.lineBreak + indent },
              range: EditorSelection.cursor(range.head + state.lineBreak.length + indent.length),
            };
          }),
          { scrollIntoView: true, userEvent: "input" },
        ),
      );
    };
    // Faithful port of the engine's newLineAndEnterInsertMode with verbatim
    // indent (O uses the current line's indent, vim-style).
    VimAny.defineAction("newLineAndEnterInsertMode", function (
      this: Record<string, any>,
      cm: { cm6: EditorView },
      actionArgs: { after?: boolean; repeat?: number },
      vimState: Record<string, unknown>,
    ) {
      vimState.insertMode = true;
      const view = cm.cm6;
      const state = view.state;
      const line = state.doc.lineAt(state.selection.main.head);
      const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
      const openAfter = actionArgs.after !== false;
      if (!openAfter && line.number === 1) {
        view.dispatch({
          changes: { from: 0, insert: indent + state.lineBreak },
          selection: { anchor: indent.length },
          scrollIntoView: true,
        });
      } else {
        const at = openAfter ? line.to : state.doc.line(line.number - 1).to;
        view.dispatch({
          changes: { from: at, insert: state.lineBreak + indent },
          selection: { anchor: at + state.lineBreak.length + indent.length },
          scrollIntoView: true,
        });
      }
      this.enterInsertMode(cm, { repeat: actionArgs.repeat }, vimState);
    });
  } catch (e) {
    console.warn("[bnote] vim o/O indent patch failed", e);
  }
}

/* ---- clipboard=unnamed: sync the vim unnamed register with the system clipboard.
   The underlying vim engine already maps register "+" to navigator.clipboard;
   here we patch the unnamed register '"' to follow it: every yank/delete/change
   writes to the clipboard, and p/P reads it back. ---- */

let clipboardUnnamed = false;
let clipboardPatched = false;

export function setVimClipboardUnnamed(on: boolean) {
  clipboardUnnamed = on;
  if (!on || clipboardPatched) return;
  clipboardPatched = true;
  try {
    const VimAny = Vim as unknown as Record<string, any>;
    const controller = VimAny.getRegisterController();
    // Prototype-level patch survives the engine resetting its global state.
    const proto = Object.getPrototypeOf(controller);
    const origPush = proto.pushText;
    proto.pushText = function (
      registerName: string,
      operator: string,
      text: string,
      linewise: boolean,
      blockwise: boolean,
    ) {
      origPush.call(this, registerName, operator, text, linewise, blockwise);
      if (clipboardUnnamed && registerName !== "_" && registerName !== "+") {
        const out = linewise && !text.endsWith("\n") ? `${text}\n` : text;
        void writeClipboardText(out);
      }
    };
    // Redefine the paste action: when clipboard=unnamed and no explicit
    // register was given, read the system clipboard first. `this` inside a
    // vim action is the engine's actions object (continuePaste lives there).
    // 读走 lib/clipboard（WKWebView 里 navigator.clipboard.readText 不可用，
    // 这条路径此前一直静默失败）；失败时回退寄存器内容。
    VimAny.defineAction("paste", function (
      this: Record<string, any>,
      cm: unknown,
      actionArgs: { registerName?: string },
      vimState: unknown,
    ) {
      const controller = VimAny.getRegisterController();
      const name = actionArgs.registerName || "";
      if (clipboardUnnamed && name === "") {
        const register = controller.getRegister("");
        readClipboardText().then((value) => {
          if (value) register.setText(value, value.endsWith("\n"), false);
          this.continuePaste(cm, actionArgs, vimState, register.toString(), register);
        });
        return;
      }
      // Default engine behavior: "+" reads the clipboard, others read the register.
      const register = controller.getRegister(name);
      if (name === "+") {
        void readClipboardText().then((value) => {
          if (value !== null) this.continuePaste(cm, actionArgs, vimState, value, register);
        });
      } else {
        this.continuePaste(cm, actionArgs, vimState, register.toString(), register);
      }
    });
  } catch (e) {
    console.warn("[bnote] clipboard=unnamed patch failed", e);
  }
}

/* ---- visual-mode line shade: band every line touched by a (non-empty)
   selection while vim visual mode is on, mirroring the current-line shade. ---- */

const visualLineDeco = Decoration.line({ class: "cm-vimVisualLine" });

interface Pos {
  line: number;
  ch: number;
}

export function vimVisualHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private lastVisual: boolean;

      constructor(view: EditorView) {
        this.lastVisual = !!vimStateOf(view)?.visualMode;
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate) {
        const visual = !!vimStateOf(u.view)?.visualMode;
        if (u.docChanged || u.selectionSet || u.viewportChanged || visual !== this.lastVisual) {
          this.lastVisual = visual;
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const vimState = vimStateOf(view) as
          | { visualMode?: boolean; visualLine?: boolean; sel?: { anchor?: Pos; head?: Pos } }
          | null;
        if (!vimState?.visualMode) return Decoration.set([]);
        const doc = view.state.doc;
        const lines = new Set<number>();
        // The engine tracks the visual range in vim.sel (CodeMirror 5-style
        // 0-based line/ch); linewise visual often keeps the CM selection empty.
        const sel = vimState.sel;
        if (sel?.anchor != null && sel?.head != null) {
          const aLine = Math.min(sel.anchor.line, sel.head.line) + 1;
          const bLine = Math.max(sel.anchor.line, sel.head.line) + 1;
          const endLine = doc.lines;
          const from = Math.max(1, Math.min(aLine, endLine));
          const to = Math.max(1, Math.min(bLine, endLine));
          const hasExtent =
            sel.anchor.line !== sel.head.line || sel.anchor.ch !== sel.head.ch;
          if (!hasExtent && !vimState.visualLine) {
            // Charwise visual with a collapsed range: nothing visible yet.
            return Decoration.set([]);
          }
          for (let n = from; n <= to; n++) lines.add(n);
        } else {
          for (const range of view.state.selection.ranges) {
            if (range.empty) continue;
            // A selection ending at a line start really ends on the previous line.
            let to = range.to;
            if (to > range.from && to === doc.lineAt(to).from) to -= 1;
            for (let n = doc.lineAt(range.from).number; n <= doc.lineAt(to).number; n++) {
              lines.add(n);
            }
          }
        }
        const builder = new RangeSetBuilder<Decoration>();
        for (const n of [...lines].sort((a, b) => a - b)) {
          const line = doc.line(n);
          builder.add(line.from, line.from, visualLineDeco);
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function vimStateOf(view: EditorView): { insertMode?: boolean; visualMode?: boolean } | null {
  const cm = getCM(view) as unknown as { state?: { vim?: { insertMode?: boolean; visualMode?: boolean } } } | null;
  return cm?.state?.vim ?? null;
}

export function currentVimMode(view: EditorView): VimMode | null {
  const v = vimStateOf(view);
  if (!v) return null;
  if (v.insertMode) return "insert";
  if (v.visualMode) return "visual";
  return "normal";
}

const SPECIAL_KEYS: Record<string, string> = {
  esc: "Escape",
  cr: "Enter",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  bs: "Backspace",
  bar: "|",
  lt: "<",
  gt: ">",
  lead: "\\",
};

/** `<C-s>` → CM6 key string "Ctrl-s"; `<D-s>` → "Mod-s". */
export function normalizeVimKey(lhs: string): string | null {
  if (!lhs.startsWith("<") || !lhs.endsWith(">")) {
    return lhs.length === 1 ? lhs : null;
  }
  const inner = lhs.slice(1, -1);
  let result = "";
  let mods = "";
  const parts = inner.split("-");
  let keyPart = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "c" || mod === "ctrl") mods += "Ctrl-";
    else if (mod === "d" || mod === "cmd" || mod === "meta") mods += "Mod-";
    else if (mod === "m" || mod === "a" || mod === "alt") mods += "Alt-";
    else if (mod === "s" || mod === "shift") mods += "Shift-";
    else return null;
  }
  const lower = keyPart.toLowerCase();
  if (SPECIAL_KEYS[lower]) {
    keyPart = SPECIAL_KEYS[lower];
  } else if (keyPart.length !== 1 && !/^(F\d+|Arrow.+|Home|End|PageUp|PageDown|Delete|Insert)$/.test(keyPart)) {
    return null;
  }
  result = keyPart;
  return mods + result;
}

/** Builds the CM6 keymap that runs bnote commands for `:command` mappings. */
export function commandMappingKeymap(mappings: VimMapping[]): Extension {
  // A key can be mapped more than once per mode (`noremap` plus `vnoremap`, or
  // a stray duplicate); vim lets the LAST definition win, while a keymap picks
  // the first binding it finds — so collapse duplicates back-to-front.
  const byKey = new Map<string, KeyBinding>();
  for (const m of mappings) {
    if (!m.commandId) continue;
    const key = normalizeVimKey(m.lhs);
    if (!key) continue;
    const mode = m.mode;
    byKey.set(`${mode}\u0000${key}`, {
      key,
      run: (view) => {
        const current = currentVimMode(view);
        if (!current) return false; // vim not enabled — don't hijack keys
        if (mode === "insert" && current !== "insert") return false;
        if (mode === "normal" && current !== "normal") return false;
        if (mode === "visual" && current !== "visual") return false;
        runCommandRef(m.commandId!);
        return true;
      },
    });
  }
  const bindings = [...byKey.values()];
  return bindings.length > 0 ? keymap.of(bindings) : [];
}

/** Applies key-sequence mappings through the vim engine itself. */
export function applyNativeMappings(mappings: VimMapping[]) {
  try {
    Vim.mapclear();
  } catch {
    // mapclear without args is fine on a fresh Vim instance
  }
  for (const m of mappings) {
    if (m.commandId) continue; // handled by the CM6 keymap
    const ctx =
      m.mode === "insert" ? "insert" : m.mode === "visual" ? "visual" : "normal";
    const rhs = m.rhs
      .replace(/<Esc>/gi, "Esc")
      .replace(/<CR>/gi, "CR")
      .replace(/<Tab>/gi, "Tab")
      .replace(/<Space>/gi, "Space");
    try {
      if (m.noremap) Vim.noremap(m.lhs, rhs, ctx);
      else Vim.map(m.lhs, rhs, ctx);
    } catch (e) {
      console.warn(`vimrc: cannot map ${m.lhs} → ${m.rhs}`, e);
    }
  }
}

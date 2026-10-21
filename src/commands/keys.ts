import type { Extension } from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";
import { getCommand } from "./registry";

/**
 * Keybinding configuration.
 *
 * Every binding maps a command id to CM6 key strings ("Mod-k" where Mod is
 * Cmd on macOS / Ctrl elsewhere). Users override via keybindings.json:
 *   { "edit.insert-math-block": ["Ctrl-m"], "workspace.new-note": null }
 * `null` removes the default binding; arrays allow several bindings.
 */

export const DEFAULT_BINDINGS: Record<string, string | string[]> = {
  "workspace.new-note": "Mod-n",
  "workspace.quick-add": "Mod-Shift-a",
  // ⌘⇧O 归「打开今日日记」。原占位者 workspace.open-vault 让出该键位——它仍可
  // 从命令面板(⌘P)与欢迎页调用;要键位就在 keybindings.json 里自行指派。
  "workspace.open-daily": "Mod-Shift-o",
  "workspace.save-note": "Mod-s",
  // ⌘D 在不少个人配置里已被占用(如插入代码块),画图用 ⌘O(open canvas)。
  "workspace.open-drawing": "Mod-o",
  "workspace.open-settings": "Mod-,",
  // 快速切仓,对齐 zed 的 recent projects(R = Recent)。不用 zed 的 ⌃R——
  // 那是 vim normal 模式的 redo,窗口级 capture 分发没有 vim 守卫,会吞键。
  "workspace.switch-recent-vault": "Mod-Shift-r",

  "nav.quick-switcher": "Mod-o",
  "nav.back-link": "Mod-[",
  "nav.command-palette": "Mod-p",
  "nav.toggle-sidebar": "Mod-\\",
  "nav.focus-sidebar": "Mod-i",
  "nav.header-todos": "Mod-t",

  "edit.insert-math-block": "Mod-m",
  "edit.insert-inline-math": "Mod-Shift-m",
  "edit.insert-code-block": "Mod-Shift-c",
  "edit.insert-inline-code": "Mod-`",
  // 与 Mod-b(加粗)同族区分:Shift 位给块级容器,callout 承接「块注」——
  // 有选区时在文末建带标题的块,无选区时跳转/回跳/就地开空块(ops.insertCallout)。
  "edit.insert-callout": "Mod-Shift-b",
  "edit.insert-wikilink": "Mod-k",
  "edit.insert-horizontal-rule": "Mod-Shift-h",
  "edit.toggle-bold": "Mod-b",
  "edit.toggle-italic": "Mod-Shift-i",
  "edit.toggle-strikethrough": "Mod-Shift-d",
  "edit.toggle-todo": "Mod-l",
  "edit.todo-to-daily": "Mod-Shift-j",
  "edit.toggle-bullet-list": "Mod-;",
  "edit.toggle-numbered-list": "Mod-Shift-;",
  "edit.toggle-heading": "Mod-j",
  "edit.heading-1": "Mod-1",
  "edit.heading-2": "Mod-2",
  "edit.heading-3": "Mod-3",
  "edit.heading-4": "Mod-4",
  "edit.heading-5": "Mod-5",
  "edit.heading-6": "Mod-6",

  // Jupyter/Colab 同款手感:⌘↩ 运行当前笔记的全部 python 块。
  "python.run-note": "Mod-Enter",

  "editor.toggle-live-preview": "Mod-e",
  "editor.toggle-vim": "Mod-Shift-v",
  "editor.toggle-typewriter": "Mod-Shift-t",
  "editor.toggle-snippets": "Mod-Shift-l",

  "view.toggle-study-mode": "Mod-Shift-s",
  "view.zoom-in": "Mod-=",
  "view.zoom-out": "Mod--",
  "view.zoom-reset": "Mod-0",

  // 学习模式翻页(PDF 与网页阅读器共用,按设置里的步长滚动)。动作由阅读器
  // 注册(见 study/pdfNav.ts),命令带 `when`:焦点在输入框/可编辑区、弹窗
  // 打开或正在框选时不抢键。
  "study.pdf-prev-page": ["PageUp", "ArrowLeft"],
  "study.pdf-next-page": ["PageDown", "ArrowRight"],
};

export type BindingValue = string | string[] | null;
export type BindingOverrides = Record<string, BindingValue>;

/**
 * 固定翻页键:PageUp/PageDown **永远**翻学习模式的内容页(PDF 或网页),
 * 不受 keybindings.json 影响。
 *
 * 可配置绑定改到别处后,用户仍要能靠这两个标准阅读键翻页。它们走和普通
 * 绑定相同的归属规则(焦点在编辑器/输入框里时归编辑器,弹窗/框选时命令
 * `when` 为 false 就原样放行),只是不能被覆盖表删掉。
 */
export const FIXED_PAGE_COMMANDS: Record<string, string> = {
  PageUp: "study.pdf-prev-page",
  PageDown: "study.pdf-next-page",
};

/** 无修饰键的 PageUp/PageDown → 固定翻页命令;其余按键返回 null。 */
export function fixedPageCommandFor(event: KeyboardEvent): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  return FIXED_PAGE_COMMANDS[event.key] ?? null;
}

let overrides: BindingOverrides = {};

export function setBindingOverrides(o: BindingOverrides) {
  overrides = o ?? {};
}

/** Resolved bindings for a command, [] when unbound. */
export function bindingsForCommand(id: string): string[] {
  const o = overrides[id];
  if (o === null) return [];
  if (typeof o === "string") return [o];
  if (Array.isArray(o)) return o;
  const d = DEFAULT_BINDINGS[id];
  if (!d) return [];
  return Array.isArray(d) ? d : [d];
}

export function buildCommandKeymap(): Extension {
  const bindings: KeyBinding[] = [];
  for (const id of new Set([...Object.keys(DEFAULT_BINDINGS), ...Object.keys(overrides)])) {
    for (const key of bindingsForCommand(id)) {
      bindings.push({
        key,
        run: () => {
          // 这份 keymap 只在编辑器内部生效:裸导航键属于编辑器,命令不能抢。
          // 带修饰键的绑定(⌘/⌃/⌥/⇧)照常执行。
          if (FOCUS_OWNED_PLAIN_KEYS.has(key)) return false;
          const cmd = getCommand(id);
          if (!cmd || (cmd.when && !cmd.when())) return false;
          void cmd.run();
          return true;
        },
      });
    }
  }
  return bindings.length ? keymap.of(bindings) : [];
}

/** Maps a shifted symbol key back to its base key via the physical key
 *  (US/macOS: Shift+; reports ":", Shift+- reports "_", …). Bindings are
 *  written for the physical key — "Mod-Shift-;" — like the letters, whose
 *  Shift state already survives via toLowerCase above. */
const SHIFT_SYMBOL_BASE: Record<string, string> = {
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/**
 * 不带修饰键也能成为快捷键的键。只收导航/功能键:字母数字若允许裸绑,
 * 窗口级分发会把正常输入吞掉。
 */
const PLAIN_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

/**
 * 裸导航键在编辑器/输入框里有原生含义(移动光标、翻页滚动)。窗口级命令分发
 * 不能抢它们——带修饰键的绑定不在此列:用户显式按 ⌃J,就是要命令生效。
 */
const FOCUS_OWNED_PLAIN_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/** 不带修饰键、且归编辑器所有的按键。 */
export function isPlainFocusOwnedKey(event: KeyboardEvent): boolean {
  return (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    FOCUS_OWNED_PLAIN_KEYS.has(event.key)
  );
}

/** 焦点是否落在会自己消费按键的编辑器/输入框里。 */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** Normalizes a KeyboardEvent into a CM6 key string for the settings UI. */
export function eventToKey(e: KeyboardEvent): string | null {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod && !e.altKey && !e.shiftKey && !e.ctrlKey && !PLAIN_KEYS.has(e.key)) {
    return null;
  }

  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toLowerCase();
  if (e.shiftKey && key.length === 1 && !/[a-z0-9]/.test(key)) {
    key = SHIFT_SYMBOL_BASE[e.code] ?? key;
  }

  // A lone modifier press is not a binding.
  if (["Shift", "Control", "Alt", "Meta"].includes(key)) return null;

  const parts: string[] = [];
  if (mod) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (!isMac && e.metaKey) parts.push("Meta");
  parts.push(key);
  return parts.join("-");
}

/** Navigation keys read better as glyphs in chips and tooltips. */
const KEY_GLYPH: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/** Human-friendly display, e.g. "Ctrl-Shift-M" → "⌘⇧M" (mac) / "Ctrl+Shift+M". */
export function formatBinding(key: string): string {
  const label = (p: string) => KEY_GLYPH[p] ?? (p.length === 1 ? p.toUpperCase() : p);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (isMac) {
    return key
      .split("-")
      .map((p) =>
        p === "Mod"
          ? "⌘"
          : p === "Shift"
            ? "⇧"
            : p === "Alt"
              ? "⌥"
              : p === "Ctrl"
                ? "⌃"
                : label(p),
      )
      .join("");
  }
  return key
    .split("-")
    .map(label)
    .join("+");
}

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

export const DEFAULT_BINDINGS: Record<string, string> = {
  "workspace.new-note": "Mod-n",
  "workspace.open-vault": "Mod-Shift-o",
  "workspace.save-note": "Mod-s",
  "workspace.open-settings": "Mod-,",

  "nav.quick-switcher": "Mod-o",
  "nav.command-palette": "Mod-p",
  "nav.toggle-sidebar": "Mod-\\",
  "nav.focus-sidebar": "Mod-i",

  "edit.insert-math-block": "Mod-m",
  "edit.insert-inline-math": "Mod-Shift-m",
  "edit.insert-code-block": "Mod-Shift-c",
  "edit.insert-inline-code": "Mod-`",
  "edit.insert-wikilink": "Mod-k",
  "edit.insert-horizontal-rule": "Mod-Shift-h",
  "edit.toggle-bold": "Mod-b",
  "edit.toggle-italic": "Mod-Shift-i",
  "edit.toggle-strikethrough": "Mod-Shift-d",
  "edit.heading-1": "Mod-1",
  "edit.heading-2": "Mod-2",
  "edit.heading-3": "Mod-3",
  "edit.heading-4": "Mod-4",
  "edit.heading-5": "Mod-5",
  "edit.heading-6": "Mod-6",

  "editor.toggle-live-preview": "Mod-e",
  "editor.toggle-vim": "Mod-Shift-v",
  "editor.toggle-typewriter": "Mod-Shift-t",
  "editor.toggle-snippets": "Mod-Shift-l",

  "view.zoom-in": "Mod-=",
  "view.zoom-out": "Mod--",
  "view.zoom-reset": "Mod-0",
};

export type BindingValue = string | string[] | null;
export type BindingOverrides = Record<string, BindingValue>;

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
  return d ? [d] : [];
}

export function buildCommandKeymap(): Extension {
  const bindings: KeyBinding[] = [];
  for (const id of new Set([...Object.keys(DEFAULT_BINDINGS), ...Object.keys(overrides)])) {
    for (const key of bindingsForCommand(id)) {
      bindings.push({
        key,
        run: () => {
          const cmd = getCommand(id);
          if (!cmd) return false;
          void cmd.run();
          return true;
        },
      });
    }
  }
  return bindings.length ? keymap.of(bindings) : [];
}

/** Normalizes a KeyboardEvent into a CM6 key string for the settings UI. */
export function eventToKey(e: KeyboardEvent): string | null {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod && !e.altKey && !e.shiftKey && !e.ctrlKey) return null;

  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toLowerCase();

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

/** Human-friendly display, e.g. "Ctrl-Shift-M" → "⌘⇧M" (mac) / "Ctrl+Shift+M". */
export function formatBinding(key: string): string {
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
                : p.length === 1
                  ? p.toUpperCase()
                  : p,
      )
      .join("");
  }
  return key
    .split("-")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .join("+");
}

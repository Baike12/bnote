import { vim, Vim, getCM } from "@replit/codemirror-vim";
import type { EditorView, KeyBinding } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { setSearchQuery, SearchQuery } from "@codemirror/search";
import type { VimMapping, VimMode } from "./vimrc";

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
  return vim();
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
  const bindings: KeyBinding[] = [];
  for (const m of mappings) {
    if (!m.commandId) continue;
    const key = normalizeVimKey(m.lhs);
    if (!key) continue;
    const mode = m.mode;
    bindings.push({
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

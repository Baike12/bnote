/**
 * Region-aware keybinding model.
 *
 * The same key can be bound to different commands in the four focus regions
 * (modelled on zed's context keybindings):
 *   global  —— active under any focus (workspace/navigation/view actions)
 *   notes   —— active when the note editor has focus
 *   reading —— active when the reading region (PDF / web / WeChat Reading) has focus
 *   agent   —— active when the study assistant panel has focus
 *   project —— active when the project view has focus (project list / project cards)
 *
 * Region dispatch: the current region is looked up first, then global. A region
 * binding can therefore "override" the global meaning of the same key (in the
 * Agent panel ⌘[ is "back to the previous session", not the note's back-link).
 * project additionally inherits the notes bindings (see commandsForKey): the
 * project cards edit markdown too, so bold / toggle-todo / edit commands must
 * keep working there — only project-specific actions take precedence.
 *
 * Overrides are configured in the region that owns the candidate key; the file
 * is `<vault>/.bnote/keybindings.json`:
 *   {
 *     "_hint": "…",
 *     "global":  { "nav.command-palette": "Mod-p" },
 *     "notes":   { "edit.toggle-bold": ["Mod-b"], "edit.toggle-italic": null },
 *     "reading": { "study.pdf-next-page": ["PageDown", "ArrowRight"] },
 *     "agent":   { "agent.new-session": "Mod-Shift-n" }
 *   }
 * Omitted commands use the built-in default; null = unbound; a command
 * written under another region = moved to that region. The legacy flat table
 * (command → binding, without regions) is still readable and is split by each
 * command's default region.
 */

export type KeyRegion = "global" | "notes" | "reading" | "agent" | "project" | "code";

export const KEY_REGIONS: { id: KeyRegion; label: string; hint: string }[] = [
  { id: "global", label: "通用", hint: "焦点在任何地方都生效。命令面板、保存、切换学习模式/项目管理这类动作放这里。" },
  { id: "notes", label: "笔记区", hint: "焦点在笔记编辑器时生效(学习模式右栏的笔记也算笔记区)。" },
  { id: "reading", label: "阅读区", hint: "焦点在阅读区时生效:PDF、网页、微信读书,以及中栏的工具栏。对阅读区动手的两条命令例外——翻页与截图,带修饰键的键位在笔记区 / Agent 面板按下也执行;翻页只滚内容,不改变焦点。滚轮/点击滚过阅读区后,键盘也归它(阅读区不取得 DOM 焦点)。" },
  { id: "agent", label: "Agent 面板", hint: "焦点在学习助手面板时生效(输入框、消息区、历史会话)。" },
  { id: "project", label: "项目管理", hint: "焦点在项目管理视图(项目列表、项目卡片)时生效。这里继承笔记区的编辑键位(加粗、切换待办、保存等),只是项目专属动作优先:⌘⇧↑/↓ 轮转项目、⌘⇧J 把待办发到今日待办区最前、⌘⌥N 跳到右侧日记。" },
  { id: "code", label: "代码区", hint: "焦点在代码编辑器时生效。**这是独立的一界**:⌘S 在这里是「保存代码文件」,⌘⇧O 是「快速打开文件」,与笔记区各说各的。代码区只继承少数应用级命令(命令面板、快速跳转、切学习模式、设置),其余键位一律归代码区自己,可在 keybindings.json 的 code 段里改绑。" },
];

export const KEY_REGION_IDS: KeyRegion[] = KEY_REGIONS.map((r) => r.id);

export const DEFAULT_BINDINGS: Record<string, string | string[]> = {
  // app.quit is deliberately unbound by default (user decision 2026-11-03):
  // an accidental ⌘Q must not quit the app. The command stays in the palette
  // and keybindings.json can bind it (or anything else) to Mod-q. The hard
  // lock still swallows ⌘Q while a pomodoro runs (focus.rs).
  "workspace.new-note": "Mod-n",
  "workspace.quick-add": "Mod-Shift-a",
  // Capture a todo on the fly: same family as "send todo to the daily note"
  // (⌘⇧J), but the entry point is a dialog instead of the cursor line.
  "workspace.capture-todo": "Mod-Shift-k",
  // ⌘⇧O belongs to "open today's daily note". The former holder
  // workspace.open-vault yields that key — it is still reachable from the
  // command palette (⌘P) and the welcome screen; assign it a key yourself in
  // keybindings.json if you want one.
  "workspace.open-daily": "Mod-Shift-o",
  "workspace.save-note": "Mod-s",
  // Drawings take no keybinding by default: ⌘O belongs to the quick switcher
  // (as in Obsidian) and ⌘D is already taken in many personal configs. Assign
  // a key yourself in keybindings.json if you need one.
  "workspace.open-settings": "Mod-,",
  // Quick vault switch, aligned with zed's recent projects (R = Recent). Zed's
  // ⌃R is not reused — that is vim normal mode's redo, and the window-level
  // capture dispatch has no vim guard, so it would swallow the key.
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
  // Distinguished from the Mod-b (bold) family: the Shift slot goes to the
  // block-level container, the callout carries the "block annotation" — with
  // a selection it creates a titled block at the end of the note, without one
  // it jumps / goes back / opens an empty block in place (ops.insertCallout).
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

  // Same feel as Jupyter/Colab: ⌘↩ runs every python block of the current note.
  "python.run-note": "Mod-Enter",

  "editor.toggle-live-preview": "Mod-e",
  "editor.toggle-vim": "Mod-Shift-v",
  "editor.toggle-typewriter": "Mod-Shift-t",
  "editor.toggle-snippets": "Mod-Shift-l",

  "view.toggle-study-mode": "Mod-Shift-s",
  "view.toggle-projects": "Mod-Shift-p",
  "view.zoom-in": "Mod-=",
  "view.zoom-out": "Mod--",
  "view.zoom-reset": "Mod-0",

  // Focus mode: ⌘⌥T starts one focus session (idempotent: pressing it again
  // while running does not restart it). There is no pause/end/unlock
  // keybinding afterwards — the session has to run to the end, so a second
  // key is not needed.
  "focus.pomodoro-start": "Mod-Alt-t",

  // Project management view (project region). ⌘⇧↑/↓ rotate the cards; ⌘⇧J is
  // the same key as the notes region's "send to the end of today's daily note",
  // but inside a project it means "insert at the top of today's todo area" —
  // the region override lets one key carry two intents by context. In the
  // project region ⌘⌥N is overridden to "go to the journal on the right".
  "project.prev": "Mod-Shift-ArrowUp",
  "project.next": "Mod-Shift-ArrowDown",
  "project.send-todo": "Mod-Shift-j",
  "project.new": "Mod-Shift-n",
  // ⌘⌫ means the same as in Finder (move to trash). It only covers the
  // "current project" and only applies inside the project region: the notes
  // region does not claim ⌘⌫, so editing the body never deletes a project.
  "project.delete": "Mod-Backspace",
  "project.focus-daily": "Mod-Alt-n",
  "region.focus-project": "Mod-Alt-p",

  // Page zoom of the study mode web preview (browser-level zoom: text
  // reflows, the whole page grows). Same keys as Chrome: ⌘= / ⌘- / ⌘0.
  // Configured in the reading region; while the focus is in the native child
  // webview the in-page runtime forwards them back to the main window over the
  // title channel (see ContentPane). ⌘⇧= is the physical form of the "+"
  // key and means the same as ⌘=.
  "study.web-zoom-in": ["Mod-=", "Mod-Shift-="],
  "study.web-zoom-out": "Mod--",
  "study.web-zoom-reset": "Mod-0",

  // Study mode paging (shared by the PDF and web readers, scrolling by the
  // step from settings). These keys only page while the focus is in the
  // reading region (see the region dispatch in globalKeys).
  "study.pdf-prev-page": ["PageUp", "ArrowLeft"],
  "study.pdf-next-page": ["PageDown", "ArrowRight"],
  // Screenshot of the reading region sent to the study assistant (S =
  // screenshot). Key resolution goes through event.key: on macOS Option+letter
  // turns into characters like å/ß/®, so ⌥⌘S cannot be used; ⌘⇧E is free in
  // this region (⌘⇧S is the global "toggle study mode" and must not be
  // taken). The action lives in builtin.ts + study/pdfSnapshot.ts.
  "study.pdf-snap-to-agent": "Mod-Shift-e",
  // Switch between the main and the auxiliary session of the study assistant
  // (the session list lives inside the panel; the command only signals).
  "study.agent-switch-session": "Mod-Shift-y",

  // Switching between the three focusable regions: ⌘⌥A / ⌘⌥N / ⌘⌥R =
  // focus Agent / notes / reading. The same command has one default binding
  // per region (regions do not affect each other), so every region can reach
  // every other one; pressing it inside its own region is useful too — it
  // hands the focus back to that region's input / editor (e.g. ⌘⌥A inside the
  // Agent panel). When the focus is in a PDF/web page, the in-page runtime
  // forwards the keys back to the main window over the title channel (see
  // study/webAnnotations.ts).
  "region.focus-agent": "Mod-Alt-a",
  "region.focus-notes": "Mod-Alt-n",
  "region.focus-reading": "Mod-Alt-r",

  // Session actions inside the study assistant panel. ⌘[ overrides the
  // global "back-link" here.
  "agent.toggle-creative": "Mod-Shift-g",
  "agent.new-session": "Mod-Shift-n",
  "agent.fork-session": "Mod-Shift-f",
  "agent.back-from-fork": "Mod-[",
  "agent.focus-history": "Mod-Shift-h",

  // Code region (code region). These bindings only apply here — the notes /
  // reading regions and the Agent panel are unaffected, and vice versa (⌘S
  // saves the note in the notes region, the code file in the code region).
  // The bindings largely follow VSCode: F12 go to definition, ⇧F12 find
  // references, F2 rename, ⌃Space trigger completion. Not ⌘Space: on macOS
  // that belongs to Spotlight, which swallows the key before the app sees it.
  "code.save-file": "Mod-s",
  "code.quick-open": "Mod-Shift-o",
  "code.find-in-files": "Mod-Shift-f",
  "code.go-to-definition": "F12",
  "code.go-to-type-definition": "Mod-F12",
  "code.find-references": "Shift-F12",
  "code.rename-symbol": "F2",
  "code.trigger-completion": "Ctrl-Space",
  "code.toggle-tree": "Mod-b",
  // Focus the file tree (VSCode/Zed's Explorer binding). Only active in the
  // code region; the reading region's screenshot key ⌘⇧E is a cross-region
  // chord, but "the region's own binding wins" — pressing ⌘⇧E inside the
  // code region focuses the tree and does not also screenshot the reading
  // region.
  "code.focus-tree": "Mod-Shift-e",
  "code.toggle-problems": "Mod-Shift-m",
  // VSCode / Zed's integrated terminal key. Ctrl (not Mod): ⌘` is free on
  // macOS, but the habit comes from both references and the chord must not
  // collide with a future ⌘ binding.
  "code.toggle-terminal": "Ctrl-`",
  "code.next-tab": "Mod-Alt-ArrowRight",
  "code.prev-tab": "Mod-Alt-ArrowLeft",
  "code.next-problem": "F8",
  "code.prev-problem": "Shift-F8",
  "code.git-diff": "Mod-Shift-d",
  "code.toggle-wrap": "Alt-z",
};

/** Commands without an explicit placement table are assigned by prefix; the few exceptions are listed below. */
const REGION_EXACT: Record<string, KeyRegion> = {
  "nav.header-todos": "notes",
  // "Switch assistant session" is an in-panel action: it should only respond
  // while the focus is in the panel.
  "study.agent-switch-session": "agent",
};

const REGION_PREFIXES: [string, KeyRegion][] = [
  ["study.pdf-", "reading"],
  ["study.web-", "reading"],
  ["region.", "reading"],
  ["agent.", "agent"],
  ["project.", "project"],
  ["edit.", "notes"],
  ["editor.", "notes"],
  ["python.", "notes"],
  ["code.", "code"],
];

/**
 * The same command can belong to several regions at once (each region is
 * independent). The region-switch commands have a copy in every region: from
 * any region you can reach any other, and "hand the focus back to my own
 * region" is meaningful too — ⌘⌥A inside the Agent panel sends the focus
 * back to its input (especially needed from the message list / history).
 */
const REGION_PLACEMENT: Record<string, KeyRegion[]> = {
  "region.focus-agent": ["reading", "notes", "agent", "code"],
  "region.focus-notes": ["reading", "notes", "agent", "code"],
  "region.focus-reading": ["reading", "notes", "agent"],
  // Both columns of the project view are focusable: the cards and the
  // journal on the right. ⌘⌥P sends the focus back to the cards in the
  // project region and holds in the journal column too (no need to go back
  // to the cards first).
  "region.focus-project": ["project", "notes"],
};

/**
 * The global commands the code region inherits (whitelist).
 *
 * The code editor is **a separate world**: ⌘S here means "save the code
 * file", not "save the note". So the code region does not inherit the whole
 * global layer, only these truly application-level commands — command
 * palette, quick switcher, toggle study mode, settings. Other global
 * bindings (⌘⇧P toggle project view, ⌘⇧O open today's daily note) yield to
 * the code region's own actions.
 */
const CODE_INHERITED_GLOBALS = new Set([
  "nav.command-palette",
  "nav.quick-switcher",
  "view.toggle-study-mode",
  "workspace.open-settings",
]);

/**
 * Two kinds of commands that do not depend on the focus: their bindings are
 * **not restricted to a focus region** and run wherever they are pressed.
 *
 *   - Acting on the reading region: paging (scrolls the content only, the
 *     focus stays put) and screenshot (attaches the current page to the
 *     assistant's input). They depend on what is in the reading region, not
 *     on where the cursor sits.
 *   - Region navigation: ⌘⌥A/N/R go to Agent / notes / reading. Navigation
 *     means "reachable from anywhere", so where it was pressed makes no
 *     difference (⌘⌥A inside the Agent panel sending the focus back to its
 *     input holds too).
 *
 * Two disciplines:
 *   1. The region's own binding wins (see commandsForKey): when the notes
 *      region binds the same key to another command, pressing it there runs
 *      the notes region's meaning.
 *   2. An explicit unbind only takes effect in its own region: a region that
 *      writes the command as null does not respond to it there at all (it
 *      does not come back to life because a binding exists elsewhere).
 *
 * Chords only: bare keys like PageUp/PageDown/arrows have native meanings in
 * the editor and in ordinary pages, so they must keep working in the reading
 * region alone (see the bare-key pass-through in globalKeys).
 */
const REGION_FREE_COMMANDS = new Set([
  "study.pdf-prev-page",
  "study.pdf-next-page",
  "study.pdf-snap-to-agent",
  "region.focus-agent",
  "region.focus-notes",
  "region.focus-reading",
  "region.focus-project",
]);

/** Whether a binding spec (such as "Mod-Shift-a") carries a modifier that claims the key without colliding with text input. */
function isChord(key: string): boolean {
  const head = key.split("-")[0];
  return head === "Mod" || head === "Ctrl" || head === "Alt";
}

/** The command's default region (primary region, used as the fallback when no explicit region is given). */
export function defaultRegionOf(id: string): KeyRegion {
  const placement = REGION_PLACEMENT[id];
  if (placement) return placement[0];
  const exact = REGION_EXACT[id];
  if (exact) return exact;
  for (const [prefix, region] of REGION_PREFIXES) {
    if (id.startsWith(prefix)) return region;
  }
  return "global";
}

/** The regions a command appears in by default (most commands have exactly one). */
export function defaultRegionsOf(id: string): KeyRegion[] {
  return REGION_PLACEMENT[id] ?? [defaultRegionOf(id)];
}

export type BindingValue = string | string[] | null;
export type BindingMap = Record<string, BindingValue>;
export type Keymap = Record<KeyRegion, BindingMap>;
export type OverrideMap = Partial<Record<KeyRegion, BindingMap>>;

function emptyKeymap(): Keymap {
  const km = {} as Keymap;
  for (const region of KEY_REGION_IDS) km[region] = {};
  return km;
}

function defaultKeymap(): Keymap {
  const km = emptyKeymap();
  for (const [id, value] of Object.entries(DEFAULT_BINDINGS)) {
    for (const region of defaultRegionsOf(id)) km[region][id] = value;
  }
  return km;
}

let current: Keymap = defaultKeymap();
let revision = 0;
/** Per-region "key → command" index: each keystroke looks up two Maps instead of scanning the binding table. */
let keyIndex: Record<KeyRegion, Map<string, string[]>> = indexShell();
/** The chords of REGION_FREE_COMMANDS: they hit in every region (the binding comes from the region it was configured in). */
let regionFreeIndex = new Map<string, string[]>();

function indexShell(): Record<KeyRegion, Map<string, string[]>> {
  const out = {} as Record<KeyRegion, Map<string, string[]>>;
  for (const region of KEY_REGION_IDS) out[region] = new Map();
  return out;
}

function reindex(): void {
  const byKey = indexShell();
  for (const region of KEY_REGION_IDS) {
    const keys = byKey[region];
    for (const [id, value] of Object.entries(current[region])) {
      for (const key of keysOf(value)) {
        const list = keys.get(key);
        if (list) list.push(id);
        else keys.set(key, [id]);
      }
    }
  }
  keyIndex = byKey;

  const free = new Map<string, string[]>();
  for (const region of KEY_REGION_IDS) {
    for (const [id, value] of Object.entries(current[region])) {
      if (!REGION_FREE_COMMANDS.has(id)) continue;
      for (const key of keysOf(value)) {
        if (!isChord(key)) continue;
        const list = free.get(key);
        if (list) {
          if (!list.includes(id)) list.push(id);
        } else free.set(key, [id]);
      }
    }
  }
  regionFreeIndex = free;
}

reindex();

export function setKeymap(km: Keymap): void {
  current = km;
  revision += 1;
  reindex();
}

export function getKeymap(): Keymap {
  return current;
}

export function keymapRevision(): number {
  return revision;
}

/** Whether the command has an entry in this region (including the null of an "explicitly unbound" command). */
export function commandInRegion(id: string, region: KeyRegion): boolean {
  return Object.prototype.hasOwnProperty.call(current[region], id);
}

/** The regions the command currently appears in (defaults plus user overrides). */
export function commandRegions(id: string): KeyRegion[] {
  return KEY_REGION_IDS.filter((region) => commandInRegion(id, region));
}

/**
 * Which region tab a row of the settings page belongs to: it appears when
 * the region holds an entry (including null); a command that was never
 * configured is shown once under its default region so it does not vanish
 * from the list.
 */
export function commandBelongs(id: string, region: KeyRegion): boolean {
  if (commandInRegion(id, region)) return true;
  return commandRegions(id).length === 0 && defaultRegionOf(id) === region;
}

/** The command's default region (without multi-region placement it is its only region). */
export function regionOfCommand(id: string): KeyRegion {
  return defaultRegionOf(id);
}

/** The built-in default bindings of this region (an override identical to the default need not be written). */
export function defaultBindingsFor(id: string, region: KeyRegion): string[] {
  if (!defaultRegionsOf(id).includes(region)) return [];
  return keysOf(DEFAULT_BINDINGS[id]);
}

export function keysOf(value: BindingValue | undefined): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((k) => typeof k === "string" && k);
  return [];
}

/**
 * Resolved bindings for a command. Passing region = only that region (the
 * settings page edits per region); omitting it = all regions merged and
 * de-duplicated (the command palette / hint bar show "which keys trigger
 * it").
 */
export function bindingsForCommand(id: string, region?: KeyRegion): string[] {
  if (region) return keysOf(current[region]?.[id]);
  const out: string[] = [];
  for (const r of KEY_REGION_IDS) {
    for (const key of keysOf(current[r][id])) {
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

/**
 * The commands this key may trigger in the current region: the region
 * bindings first, then the global bindings, and finally the cross-region
 * commands (REGION_FREE_COMMANDS). A list is returned instead of a single id
 * — when the previous command's `when` is false, the dispatch layer tries
 * the next one.
 */
export function commandsForKey(key: string, region: KeyRegion): string[] {
  const own = keyIndex[region].get(key);
  const out = own ? own.slice() : [];
  const add = (ids: string[] | undefined) => {
    if (!ids) return;
    for (const id of ids) if (!out.includes(id)) out.push(id);
  };
  // The project region is "the notes region + project-specific actions": the
  // cards edit markdown too, so edit.* commands like bold / toggle-todo /
  // save must not stop working because the region changed. The project's own
  // bindings come first; a command explicitly unbound (null) in the project
  // region is no longer inherited from the notes region.
  if (region === "project") {
    add(keyIndex.notes.get(key)?.filter((id) => !unboundHere(id, "project")));
  }
  if (region === "code") {
    // The code region only inherits the whitelisted global commands (see
    // CODE_INHERITED_GLOBALS).
    add((keyIndex.global.get(key) ?? []).filter((id) => CODE_INHERITED_GLOBALS.has(id)));
  } else if (region !== "global") {
    add(keyIndex.global.get(key));
  }
  // add() de-duplicates when `own` already holds the command. An explicit
  // unbind (null / empty array) only takes effect in its own region: writing
  // ⌘⌥A as null in notes must not let it come back to life in notes through
  // the reading region's binding.
  //
  // While a modal is open the region passed is "global" (the focus belongs to
  // no region, only global commands are let through): cross-region commands
  // are not let through either — they would steal the focus from the modal
  // (paging likewise; do not scroll the reading region hidden behind it).
  if (region !== "global") {
    add(regionFreeIndex.get(key)?.filter((id) => !unboundHere(id, region)));
  }
  return out;
}

/** Whether the command is explicitly unbound in this region (it has an entry but not a single key). */
function unboundHere(id: string, region: KeyRegion): boolean {
  const map = current[region];
  if (!Object.prototype.hasOwnProperty.call(map, id)) return false;
  return keysOf(map[id]).length === 0;
}

/**
 * The keys that must be forwarded back to the main window while the focus is
 * in the native web child webview.
 *
 * The child webview's keydown does not bubble to the main window, so the
 * in-page runtime only honors this list (on a match it writes document.title
 * and comes back over the title channel). The list is derived from the
 * binding table instead of being hand-enumerated — global commands are
 * "active under any focus" by definition (quick todo, command palette, ...),
 * the reading region's bindings are executed by the main window too, and the
 * same holds for the cross-region navigation commands; missing one means one
 * keybinding silently dies inside a web page.
 *
 * The exceptions are the commands the page consumes itself: paging scrolls
 * locally (no IPC round trip) and a PDF screenshot is meaningless for a web
 * page. They are handled in the page and not forwarded.
 */
const PAGE_OWNED_COMMANDS = new Set([
  "study.pdf-prev-page",
  "study.pdf-next-page",
  "study.pdf-snap-to-agent",
]);

export function pageForwardKeys(): string[] {
  const out: string[] = [];
  const add = (keys: string[]) => {
    for (const key of keys) if (!out.includes(key)) out.push(key);
  };
  for (const value of Object.values(current.global)) add(keysOf(value));
  for (const [id, value] of Object.entries(current.reading)) {
    if (PAGE_OWNED_COMMANDS.has(id)) continue;
    add(keysOf(value));
  }
  // A cross-region command (region navigation) counts as "usable anywhere"
  // no matter which region it was configured in: pressing it inside a web
  // page must forward to the main window too, otherwise the copy bound in the
  // notes / Agent region silently dies inside the page.
  for (const region of KEY_REGION_IDS) {
    if (region === "reading") continue;
    for (const [id, value] of Object.entries(current[region])) {
      if (!REGION_FREE_COMMANDS.has(id) || PAGE_OWNED_COMMANDS.has(id)) continue;
      add(keysOf(value).filter(isChord));
    }
  }
  return out;
}

/**
 * Apply the user overrides: lay down the defaults first, then place the
 * overrides per region. The regions **do not affect each other** — the same
 * command may have one binding in several regions (as the region-switch
 * commands do); null only unbinds that region.
 */
export function applyOverrides(overrides: OverrideMap): void {
  const km = defaultKeymap();
  for (const region of KEY_REGION_IDS) {
    const map = overrides[region];
    if (!map) continue;
    for (const [id, value] of Object.entries(map)) {
      km[region][id] = value;
    }
  }
  setKeymap(km);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeValue(value: unknown): BindingValue | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (Array.isArray(value)) {
    const keys = value.filter(
      (k): k is string => typeof k === "string" && k.trim() !== "",
    );
    return keys.length > 0 ? keys : null;
  }
  return undefined;
}

/**
 * Read the config file: the new format is grouped by region; the legacy flat
 * table (command → binding) is still readable and every entry is split by the
 * command's default region — no existing keybinding is lost on upgrade.
 */
export function normalizeOverrides(raw: unknown): OverrideMap {
  if (!isPlainObject(raw)) return {};
  const out: OverrideMap = {};
  const hasRegions = KEY_REGION_IDS.some((region) => isPlainObject(raw[region]));
  if (!hasRegions) {
    for (const [id, value] of Object.entries(raw)) {
      if (id.startsWith("_") || id.startsWith("$")) continue;
      const normalized = normalizeValue(value);
      if (normalized === undefined) continue;
      const region = defaultRegionOf(id);
      (out[region] ??= {})[id] = normalized;
    }
    return out;
  }
  for (const region of KEY_REGION_IDS) {
    const map = raw[region];
    if (!isPlainObject(map)) continue;
    for (const [id, value] of Object.entries(map)) {
      if (id.startsWith("_") || id.startsWith("$")) continue;
      const normalized = normalizeValue(value);
      if (normalized === undefined) continue;
      (out[region] ??= {})[id] = normalized;
    }
  }
  return out;
}

const FILE_HINT =
  "按焦点区域覆盖快捷键。global 在所有区域生效;notes/reading/agent 只在焦点位于该区域时生效,并可盖住同一个键的通用绑定。同一条命令可以在多个区域各有一份,区域互不影响;省略的命令用默认键位,null 只解绑该区域(跨区域生效的命令也一样)。翻页、截图、区域切换这类跨区域命令带修饰键的键位在哪个区域按下都生效。保存即生效。";

/** Write the config file: only the overrides are written (an entry identical to the default need not be written), empty regions are omitted. */
export function serializeOverrides(overrides: OverrideMap): string {
  const doc: Record<string, unknown> = { _hint: FILE_HINT };
  for (const region of KEY_REGION_IDS) {
    const map = overrides[region];
    if (!map || Object.keys(map).length === 0) continue;
    doc[region] = map;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** For the legacy (regionless) write path: all regions flattened into one command → binding table. */
export function flattenOverrides(overrides: OverrideMap): BindingMap {
  const flat: BindingMap = {};
  for (const region of KEY_REGION_IDS) {
    const map = overrides[region];
    if (!map) continue;
    for (const [id, value] of Object.entries(map)) flat[id] = value;
  }
  return flat;
}

export function bindingEquals(a: BindingValue | undefined, b: BindingValue | undefined): boolean {
  const left = keysOf(a);
  const right = keysOf(b);
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

/**
 * Fixed paging keys: PageUp/PageDown **always** page the study mode content
 * (PDF or web), unaffected by keybindings.json. They only apply while the
 * focus is in the reading region (see globalKeys), so they never take
 * PageUp away from the note editor or the sidebar.
 */
export const FIXED_PAGE_COMMANDS: Record<string, string> = {
  PageUp: "study.pdf-prev-page",
  PageDown: "study.pdf-next-page",
};

/** Unmodified PageUp/PageDown → the fixed paging command; every other key returns null. */
export function fixedPageCommandFor(event: KeyboardEvent): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  return FIXED_PAGE_COMMANDS[event.key] ?? null;
}

/**
 * Normalization of the event's main key: Shift+symbol and macOS Option+letter
 * are both restored to the **physical key**.
 *
 * On macOS Option+letter produces an event.key of å/ß/®, and Option+N even
 * produces "Dead" — while the binding table says "Mod-Alt-a", so event.key
 * never matches on its own. The body must be self-contained: it is
 * serialized into the web runtime (see study/webAnnotations.ts).
 */
export function eventKeyName(event: {
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
}): string {
  const SYMBOLS: Record<string, string> = {
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
  let key = event.key;
  if (key === " ") return "Space";
  if (key.length === 1) key = key.toLowerCase();
  if (event.shiftKey && key.length === 1 && !/[a-z0-9]/.test(key)) {
    key = SYMBOLS[event.code] ?? key;
  }
  if (event.altKey && (key === "Dead" || (key.length === 1 && !/[a-z0-9]/.test(key)))) {
    if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase();
    else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
    else key = SYMBOLS[event.code] ?? key;
  }
  return key;
}

/**
 * The keys that may become a keybinding even without a modifier. Only
 * navigation/function keys are accepted: if bare letters and digits were
 * allowed, the window-level dispatch would swallow normal typing.
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
 * Bare navigation keys have native meanings in the editor and in inputs
 * (moving the cursor, scrolling). The window-level command dispatch must not
 * take them — modified bindings are not in this set: the user explicitly
 * pressed ⌃J and wants the command to run.
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

/** Keys that carry no modifier and belong to the editor. */
export function isPlainFocusOwnedKey(event: KeyboardEvent): boolean {
  return (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    FOCUS_OWNED_PLAIN_KEYS.has(event.key)
  );
}

/**
 * The platform's text editing chords: the text input controls
 * (input/textarea) own them.
 *
 * Once a region binds the same key, the window-level dispatch may not take
 * it — otherwise, after binding ⌘A to some command in the notes region, ⌘A
 * inside the editor's search box or the link-suggest input would no longer
 * select all. The editor itself is contenteditable and is not in this set
 * (there ⌘A belongs to the editor/command).
 */
const FORM_EDIT_CHORDS = new Set(["Mod-a", "Mod-c", "Mod-x", "Mod-v", "Mod-z", "Mod-Shift-z"]);

/** Whether the key should stay inside the text input control (tagName comes from the event target element). */
export function formOwnsEditChord(key: string, tagName: string | null | undefined): boolean {
  if (tagName !== "INPUT" && tagName !== "TEXTAREA") return false;
  return FORM_EDIT_CHORDS.has(key);
}

/** Whether the focus sits in an editor/input that consumes keys itself. */
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

  const key = eventKeyName(e);

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

/**
 * Split a binding string into "modifiers + main key".
 *
 * A plain `split("-")` does not work: the minus key is itself "-"
 * (⌘− is written "Mod--"), so splitting on the separator only leaves a row
 * of empty strings. Instead the modifiers are peeled off one by one from the
 * front and the rest is the main key — "Mod--" loses "Mod-" and leaves "-",
 * "Mod-Shift-=" loses two and leaves "=".
 *
 * This function is serialized into the web runtime (injected into the native
 * webview), so its body must be self-contained: the modifier table lives
 * inside the function and no module constant is referenced.
 */
export function parseBinding(binding: string): { mods: string[]; key: string } {
  const MODIFIERS = ["Mod", "Shift", "Alt", "Ctrl", "Meta"];
  const mods: string[] = [];
  let rest = binding;
  for (;;) {
    const name = MODIFIERS.find(
      (m) => rest.length > m.length + 1 && rest.startsWith(`${m}-`),
    );
    if (!name) break;
    mods.push(name);
    rest = rest.slice(name.length + 1);
  }
  return { mods, key: rest };
}

/** Human-friendly display, e.g. "Ctrl-Shift-M" → "⌘⇧M" (mac) / "Ctrl+Shift+M". */
export function formatBinding(key: string): string {
  const label = (p: string) => KEY_GLYPH[p] ?? (p.length === 1 ? p.toUpperCase() : p);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const { mods, key: base } = parseBinding(key);
  if (isMac) {
    const glyph = (p: string) =>
      p === "Mod" ? "⌘" : p === "Shift" ? "⇧" : p === "Alt" ? "⌥" : p === "Ctrl" ? "⌃" : label(p);
    return [...mods.map(glyph), label(base)].join("");
  }
  return [...mods, base].map(label).join("+");
}

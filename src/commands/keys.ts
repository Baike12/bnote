/**
 * 分区域的快捷键模型。
 *
 * 同一个按键在三个焦点区域里可以绑到不同命令(参考 zed 的 context 键位):
 *   global  —— 任何焦点都生效(工作区/导航/视图这类全局动作)
 *   notes   —— 焦点在笔记编辑器时生效
 *   reading —— 焦点在阅读区(PDF / 网页 / 微信读书)时生效
 *   agent   —— 焦点在学习助手面板时生效
 *
 * 区域分发:先查当前区域,再退回 global;区域绑定因此可以「盖住」同一个键的
 * 全局含义(例如 Agent 面板里 ⌘[ 是「返回上一条会话」,不是笔记的回退链接)。
 *
 * 配置在候选键的归属区域里覆盖,文件是 `<vault>/.bnote/keybindings.json`:
 *   {
 *     "_hint": "…",
 *     "global":  { "nav.command-palette": "Mod-p" },
 *     "notes":   { "edit.toggle-bold": ["Mod-b"], "edit.toggle-italic": null },
 *     "reading": { "study.pdf-next-page": ["PageDown", "ArrowRight"] },
 *     "agent":   { "agent.new-session": "Mod-Shift-n" }
 *   }
 * 省略的命令用内置默认;null = 解绑;一条命令写进别的区域 = 挪到该区域。
 * 旧版扁平表(命令 → 键位,没有区域)仍能读,按命令的默认归属自动分区。
 */

export type KeyRegion = "global" | "notes" | "reading" | "agent";

export const KEY_REGIONS: { id: KeyRegion; label: string; hint: string }[] = [
  { id: "global", label: "通用", hint: "焦点在任何地方都生效。命令面板、保存、切换学习模式这类动作放这里。" },
  { id: "notes", label: "笔记区", hint: "焦点在笔记编辑器时生效(学习模式右栏的笔记页签也算笔记区)。" },
  { id: "reading", label: "阅读区", hint: "焦点在阅读区时生效:PDF、网页、微信读书,以及中栏的工具栏。翻页的两条命令例外——带修饰键的键位在笔记区 / Agent 面板按下也会滚动,并把焦点交回阅读区。" },
  { id: "agent", label: "Agent 面板", hint: "焦点在学习助手面板时生效(输入框、消息区、历史会话)。" },
];

export const KEY_REGION_IDS: KeyRegion[] = KEY_REGIONS.map((r) => r.id);

export const DEFAULT_BINDINGS: Record<string, string | string[]> = {
  "workspace.new-note": "Mod-n",
  "workspace.quick-add": "Mod-Shift-a",
  // 随手记一条待办:与「发送待办到日记」(⌘⇧J)同族,但入口是弹窗而不是光标行。
  "workspace.capture-todo": "Mod-Shift-k",
  // ⌘⇧O 归「打开今日日记」。原占位者 workspace.open-vault 让出该键位——它仍可
  // 从命令面板(⌘P)与欢迎页调用;要键位就在 keybindings.json 里自行指派。
  "workspace.open-daily": "Mod-Shift-o",
  "workspace.save-note": "Mod-s",
  // 画图默认不占键位:⌘O 归快速跳转(与 Obsidian 一致),⌘D 在不少个人
  // 配置里已被占用。需要键位就在 keybindings.json 里自行指派。
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

  // 学习模式网页预览的页面缩放(浏览器级缩放:文字重排、整页一起放大)。
  // 与 Chrome 同键:⌘= / ⌘- / ⌘0。配置归属阅读区;焦点在原生子 webview
  // 里时由页内运行时经 title 通道转回主窗口执行(见 ContentPane)。
  // ⌘⇧= 是 "+" 键的物理形式,与 ⌘= 同义。
  "study.web-zoom-in": ["Mod-=", "Mod-Shift-="],
  "study.web-zoom-out": "Mod--",
  "study.web-zoom-reset": "Mod-0",

  // 学习模式翻页(PDF 与网页阅读器共用,按设置里的步长滚动)。只有焦点在
  // 阅读区时才按这套键翻页(见 globalKeys 的区域分发)。
  "study.pdf-prev-page": ["PageUp", "ArrowLeft"],
  "study.pdf-next-page": ["PageDown", "ArrowRight"],
  // 阅读区截图送到学习助手(S = screenshot)。按键解析走 event.key:macOS
  // 上 Option+字母会变成 å/ß/® 这类字符,所以不能用 ⌥⌘S;⌘⇧E 在这个
  // 区域没有占用(⌘⇧S 是全局的「切换学习模式」,不能抢)。动作见
  // builtin.ts + study/pdfSnapshot.ts。
  "study.pdf-snap-to-agent": "Mod-Shift-e",
  // 学习模式右栏:笔记页与学习助手页来回切。它是「切换视图」,任何焦点下
  // 都该能用,所以归通用。
  "study.toggle-right-tab": "Mod-Shift-u",
  // 学习助手里主会话与辅助会话来回切(会话列表在面板内部,命令只发信号)。
  "study.agent-switch-session": "Mod-Shift-y",

  // 三个可聚焦区域之间互相切换:⌘⌥A / ⌘⌥N / ⌘⌥R = 聚焦 Agent / 笔记区 /
  // 阅读区。同一条命令在多个区域各有一份默认键位(区域之间互不影响),所以
  // 从任意区域都能去另外两个。焦点在 PDF/网页里时,网页里的按键由页内
  // 运行时经 title 通道转回主窗口(见 study/webAnnotations.ts)。
  "region.focus-agent": "Mod-Alt-a",
  "region.focus-notes": "Mod-Alt-n",
  "region.focus-reading": "Mod-Alt-r",

  // 学习助手面板内的会话操作。⌘[ 在这里盖住全局的「回退链接」。
  "agent.new-session": "Mod-Shift-n",
  "agent.fork-session": "Mod-Shift-f",
  "agent.back-from-fork": "Mod-[",
  "agent.focus-history": "Mod-Shift-h",
};

/** 无显式归属表的命令按前缀分;少数例外写在下面。 */
const REGION_EXACT: Record<string, KeyRegion> = {
  "nav.header-todos": "notes",
  // 「学习助手切换会话」是面板内动作:焦点在面板里才该响应。
  "study.agent-switch-session": "agent",
};

const REGION_PREFIXES: [string, KeyRegion][] = [
  ["study.pdf-", "reading"],
  ["study.web-", "reading"],
  ["region.", "reading"],
  ["agent.", "agent"],
  ["edit.", "notes"],
  ["editor.", "notes"],
  ["python.", "notes"],
];

/**
 * 同一条命令可以同时属于多个区域(区域各自独立)。只有区域切换命令需要这样:
 * 焦点在 A 区时要能去 B/C 区,反过来也一样。
 */
const REGION_PLACEMENT: Record<string, KeyRegion[]> = {
  "region.focus-agent": ["reading", "notes"],
  "region.focus-notes": ["reading", "agent"],
  "region.focus-reading": ["notes", "agent"],
};

/**
 * 翻页命令的键位**不按焦点区域设限**:配置仍在阅读区(改键也在阅读区改),
 * 但在任何区域按下都滚阅读内容——命令自己负责把焦点交回阅读区。
 *
 * 只对带 Mod/Ctrl/Alt 的和弦这样处理:PageUp/PageDown/方向键在编辑器与普通
 * 页面里有原生含义,必须继续只在阅读区生效(见 globalKeys 的裸键让路)。
 */
const REGION_FREE_COMMANDS = new Set(["study.pdf-prev-page", "study.pdf-next-page"]);

/** 键位规格(如 "Mod-Shift-a")是否带占用性强、不会和文本输入撞车的修饰键。 */
function isChord(key: string): boolean {
  const head = key.split("-")[0];
  return head === "Mod" || head === "Ctrl" || head === "Alt";
}

/** 命令的默认归属区域(主归属,用于没有显式区域参数时的兜底)。 */
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

/** 命令默认出现在哪些区域(大多数命令只有一个)。 */
export function defaultRegionsOf(id: string): KeyRegion[] {
  return REGION_PLACEMENT[id] ?? [defaultRegionOf(id)];
}

export type BindingValue = string | string[] | null;
export type BindingMap = Record<string, BindingValue>;
export type Keymap = Record<KeyRegion, BindingMap>;
export type OverrideMap = Partial<Record<KeyRegion, BindingMap>>;

function defaultKeymap(): Keymap {
  const km = { global: {}, notes: {}, reading: {}, agent: {} } as Keymap;
  for (const [id, value] of Object.entries(DEFAULT_BINDINGS)) {
    for (const region of defaultRegionsOf(id)) km[region][id] = value;
  }
  return km;
}

let current: Keymap = defaultKeymap();
let revision = 0;
/** 每个区域的「按键 → 命令」索引:每次按键只查两次 Map,不遍历绑定表。 */
let keyIndex: Record<KeyRegion, Map<string, string[]>> = {
  global: new Map(),
  notes: new Map(),
  reading: new Map(),
  agent: new Map(),
};
/** REGION_FREE_COMMANDS 的和弦:各区都可命中,键位取自阅读区那一份。 */
let regionFreeIndex = new Map<string, string[]>();

function reindex(): void {
  const byKey: Record<KeyRegion, Map<string, string[]>> = {
    global: new Map(),
    notes: new Map(),
    reading: new Map(),
    agent: new Map(),
  };
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
  for (const [id, value] of Object.entries(current.reading)) {
    if (!REGION_FREE_COMMANDS.has(id)) continue;
    for (const key of keysOf(value)) {
      if (!isChord(key)) continue;
      const list = free.get(key);
      if (list) list.push(id);
      else free.set(key, [id]);
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

/** 命令在这个区域里有没有条目(含「显式解绑」的 null)。 */
export function commandInRegion(id: string, region: KeyRegion): boolean {
  return Object.prototype.hasOwnProperty.call(current[region], id);
}

/** 命令当前出现在哪些区域(默认 + 用户覆盖后)。 */
export function commandRegions(id: string): KeyRegion[] {
  return KEY_REGION_IDS.filter((region) => commandInRegion(id, region));
}

/**
 * 设置页的一行该出现在哪个区域页签:区域里有条目(含 null)就出现;从没配过
 * 键位的命令按默认归属展示一次,免得从列表里消失。
 */
export function commandBelongs(id: string, region: KeyRegion): boolean {
  if (commandInRegion(id, region)) return true;
  return commandRegions(id).length === 0 && defaultRegionOf(id) === region;
}

/** 命令的默认归属(没有多区域放置时就是它唯一的区域)。 */
export function regionOfCommand(id: string): KeyRegion {
  return defaultRegionOf(id);
}

/** 这个区域的内置默认键位(与默认一致时不必写覆盖项)。 */
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
 * Resolved bindings for a command. 传 region = 只看该区域(设置页按区域编辑);
 * 不传 = 所有区域合并去重(命令面板/提示条展示「按哪些键能触发它」)。
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
 * 当前区域里这个键可能触发的命令:先区域绑定,再通用绑定,最后是跨区域
 * 生效的翻页和弦。返回列表而不是单个 id——前一条命令的 `when` 为 false 时,
 * 分发层会继续试下一条。
 */
export function commandsForKey(key: string, region: KeyRegion): string[] {
  const own = keyIndex[region].get(key);
  const out = own ? own.slice() : [];
  const add = (ids: string[] | undefined) => {
    if (!ids) return;
    for (const id of ids) if (!out.includes(id)) out.push(id);
  };
  if (region !== "global") add(keyIndex.global.get(key));
  // 阅读区的 own 里已经有一份,add 去重。
  add(regionFreeIndex.get(key));
  return out;
}

/**
 * 应用用户覆盖:先铺默认,再按区域放覆盖项。区域之间**互不影响**——同一条
 * 命令可以在多个区域各有一份绑定(区域切换命令就是如此);null 只解绑该区域。
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
 * 读配置文件:新格式按区域分组;旧版扁平表(命令 → 键位)照旧能读,
 * 每条按命令的默认归属自动分区——升级时用户的既有键位一条不丢。
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
  "按焦点区域覆盖快捷键。global 在所有区域生效;notes/reading/agent 只在焦点位于该区域时生效,并可盖住同一个键的通用绑定。同一条命令可以在多个区域各有一份,区域互不影响;省略的命令用默认键位,null 只解绑该区域。保存即生效。";

/** 写配置文件:只落覆盖项(与默认相同的项不必写),空区域省略。 */
export function serializeOverrides(overrides: OverrideMap): string {
  const doc: Record<string, unknown> = { _hint: FILE_HINT };
  for (const region of KEY_REGION_IDS) {
    const map = overrides[region];
    if (!map || Object.keys(map).length === 0) continue;
    doc[region] = map;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 旧版(无区域)写盘用:所有区域拍成一张命令 → 键位的表。 */
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
 * 固定翻页键:PageUp/PageDown **永远**翻学习模式的内容页(PDF 或网页),
 * 不受 keybindings.json 影响。只有焦点在阅读区时才生效(见 globalKeys),
 * 不会把笔记编辑器/侧栏里的 PageUp 抢走。
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

/**
 * 平台文本编辑和弦:文本输入控件(input/textarea)自己拥有它们。
 *
 * 区域里绑了同一个键之后,窗口级分发不能再抢——否则在笔记区把 ⌘A 绑成某个
 * 命令后,编辑器内的搜索框、链接补全输入框里按 ⌘A 就不再是全选。编辑器本体
 * 是 contenteditable,不在此列(那里的 ⌘A 归编辑器/命令)。
 */
const FORM_EDIT_CHORDS = new Set(["Mod-a", "Mod-c", "Mod-x", "Mod-v", "Mod-z", "Mod-Shift-z"]);

/** 这个按键是否应该留在文本输入控件里(tagName 来自按键目标元素)。 */
export function formOwnsEditChord(key: string, tagName: string | null | undefined): boolean {
  if (tagName !== "INPUT" && tagName !== "TEXTAREA") return false;
  return FORM_EDIT_CHORDS.has(key);
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

/**
 * 把绑定串拆成「修饰键 + 主键」。
 *
 * 不能简单 `split("-")`:减号键自己就是 "-"(⌘− 写作 "Mod--"),按分隔符
 * 切开只会剩下一串空串。改成从头逐个剥修饰键,剩下的整段都是主键——"Mod--"
 * 剥掉 "Mod-" 后主键是 "-","Mod-Shift-=" 剥两次后主键是 "="。
 *
 * 这个函数会被序列化进网页运行时(注入原生 webview),函数体必须自包含:
 * 修饰键表写在函数内部,不引用模块常量。
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

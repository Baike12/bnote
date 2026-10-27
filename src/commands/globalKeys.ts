import { getCommand, runCommand } from "./registry";
import {
  commandsForKey,
  eventToKey,
  fixedPageCommandFor,
  formOwnsEditChord,
  isEditableTarget,
  isPlainFocusOwnedKey,
  type KeyRegion,
} from "./keys";
import { recordCommandChord } from "./lastChord";

/**
 * Command keybindings are dispatched at the window level (capture phase) so
 * they work everywhere — sidebar, modals, editor — mirroring Obsidian.
 * Set `recordingHotkey` while the settings UI captures a new binding.
 */
let recordingHotkey = false;

export function setHotkeyRecording(v: boolean) {
  recordingHotkey = v;
}

/**
 * 画布打开时进入「画布模式」:画布内部有一整套自己的键位(1-9 工具、
 * Alt+S 吸附、⌘D 复制、⌘Z 撤销…),窗口级命令分发必须让路——但画图本身
 * 也是「一个文件」,Obsidian 式的文件切换要照常可用,所以只放行快速跳转、
 * 命令面板和打开今日日记(切走时会先收尾画布,见 actions.openNote /
 * finalizeDrawingSession)。
 */
export type CommandKeyContext = "drawing" | null;

let keyContext: CommandKeyContext = null;

/**
 * 弹窗(设置 / 命令面板 / 快速跳转…)打开时,焦点在浮层输入框里,不属于三个
 * 区域中的任何一个:这时只放行通用命令,区域键位一律让路(否则在设置页里
 * 按 ⌘⇧N 会在背后给 Agent 新建会话)。
 */
let modalOpen = false;

export function setKeyModalOpen(open: boolean): void {
  modalOpen = open;
}

const DRAWING_ALLOWED = new Set(["nav.quick-switcher", "nav.command-palette", "workspace.open-daily"]);

export function setCommandKeyContext(ctx: CommandKeyContext) {
  keyContext = ctx;
}

/**
 * 焦点区域。三个可聚焦区域在 DOM 上各带 `data-key-region`:
 * 阅读区(ContentPane)、笔记区(EditorPane)、Agent 面板。
 *
 * 按键时优先看 `document.activeElement`:PDF/画布这类不可聚焦的容器点了
 * 不会转移焦点,所以 pointerdown / focusin 时再记一次「最后落在哪个区域」,
 * 焦点回到 body(点侧栏、标题栏)后沿用这个记忆。
 */
const REGION_ATTR = "data-key-region";
export type FocusRegion = Exclude<KeyRegion, "global">;

let lastRegion: FocusRegion = "notes";

export function regionFromTarget(target: EventTarget | null): FocusRegion | null {
  const el = target instanceof Element ? target : null;
  const host = el?.closest(`[${REGION_ATTR}]`);
  const attr = host?.getAttribute(REGION_ATTR);
  return attr === "reading" || attr === "agent" || attr === "notes" ? attr : null;
}

export function setActiveKeyRegion(region: FocusRegion): void {
  lastRegion = region;
}

export function activeKeyRegion(): FocusRegion {
  const fromFocus = regionFromTarget(document.activeElement);
  return fromFocus ?? lastRegion;
}

/** 挑一条现在能执行的命令(前一条的 `when` 为 false 就试下一条)。 */
function pickCommand(ids: string[]): string | null {
  for (const id of ids) {
    const cmd = getCommand(id);
    if (!cmd) continue;
    if (cmd.when && !cmd.when()) continue;
    return id;
  }
  return null;
}

/**
 * 按已解析的按键执行命令。窗口级分发与网页阅读器的转发通道共用这一条路径,
 * 保证「页内按的键」和「主窗口按的键」走同一套区域规则。
 */
export function runBoundKey(key: string, region: FocusRegion): boolean {
  const id = pickCommand(commandsForKey(key, region));
  if (!id) return false;
  if (keyContext === "drawing" && !DRAWING_ALLOWED.has(id)) return false;
  runCommand(id);
  return true;
}

export function installGlobalKeybindings() {
  const rememberRegion = (event: Event) => {
    const region = regionFromTarget(event.target);
    if (region) lastRegion = region;
  };
  window.addEventListener("pointerdown", rememberRegion, true);
  window.addEventListener("focusin", rememberRegion, true);

  window.addEventListener(
    "keydown",
    (e) => {
      if (recordingHotkey || e.defaultPrevented) return;
      const key = eventToKey(e);
      if (!key) return;
      // 文本输入控件自己的编辑和弦(⌘A/C/X/V/⌘Z)不参与区域分发:同区域内
      // 绑了这些键,输入框里按下去仍要是全选/复制/粘贴(见 editingChords)。
      const chordTarget = e.target instanceof Element ? e.target : document.activeElement;
      if (chordTarget instanceof Element && formOwnsEditChord(key, chordTarget.tagName)) {
        return;
      }
      // 裸导航键(翻页/方向键)在编辑器、输入框里有原生含义,必须原样放行;
      // 带修饰键的绑定(如 ⌃J)则在任何焦点下都生效——用户显式按了组合键。
      if (
        isPlainFocusOwnedKey(e) &&
        (isEditableTarget(e.target) || isEditableTarget(document.activeElement))
      ) {
        return;
      }
      const region: FocusRegion | "global" = modalOpen ? "global" : activeKeyRegion();
      const id = pickCommand(commandsForKey(key, region));
      if (id) {
        if (keyContext === "drawing" && !DRAWING_ALLOWED.has(id)) return;
        e.preventDefault();
        e.stopPropagation();
        recordCommandChord(e);
        runCommand(id);
        return;
      }

      // 固定翻页键:PageUp/PageDown 永远翻阅读区的内容页(PDF 或网页),
      // 即使用户把 study.pdf-* 改绑到别处。只在阅读区生效——笔记编辑器
      // 里的 PageUp 归编辑器自己。
      if (keyContext === "drawing" || region !== "reading") return;
      const fixed = fixedPageCommandFor(e);
      if (!fixed) return;
      const fixedCmd = getCommand(fixed);
      if (!fixedCmd || (fixedCmd.when && !fixedCmd.when())) return;
      e.preventDefault();
      e.stopPropagation();
      recordCommandChord(e);
      runCommand(fixed);
    },
    true,
  );
}

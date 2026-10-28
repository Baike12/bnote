import { getCommand, runCommand, type CommandDef } from "./registry";
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
 * 归属只认「用户最近一次在哪个区域里动手」:指针按下、焦点进入、滚轮/触摸
 * 滚动都算,谁后发生听谁的(单一写入者 = 下面四个输入事件)。
 *
 * 不能只看 `document.activeElement`:阅读区(PDF / 网页占位)故意不取得焦点
 * ——给阅读器加 tabindex/focus 会让 WebKit 的文字选区锚点跳变(见
 * PdfViewer 的键盘归属注释),所以滚页面、点正文都不改 activeElement。焦点
 * 停在 Agent 输入框或笔记编辑器上时就照它算区域,阅读区的快捷键(截图、
 * 区域切换)会静默落到别的命令上或什么也不做。滚轮算「动手」也是这个道理:
 * 阅读一篇 PDF 的主要动作就是滚,不点也在读。
 */
const REGION_ATTR = "data-key-region";
export type FocusRegion = Exclude<KeyRegion, "global">;
/** 兜底顺序:阅读区不会取得焦点,「无主」时它是最安全的落点。 */
const FOCUS_REGIONS: FocusRegion[] = ["reading", "notes", "agent"];

let ownerRegion: FocusRegion | null = null;

export function regionFromTarget(target: EventTarget | null): FocusRegion | null {
  const el = target instanceof Element ? target : null;
  const host = el?.closest(`[${REGION_ATTR}]`);
  const attr = host?.getAttribute(REGION_ATTR);
  return attr === "reading" || attr === "agent" || attr === "notes" ? attr : null;
}

/**
 * 区域此刻是否在场。三栏(助手 / 内容 / 笔记)都常驻挂载;不在学习模式时
 * 只有笔记区存在。看不见的区域不能占着键盘——不可见的东西不该接收按键。
 */
export function regionOnScreen(region: FocusRegion): boolean {
  const el = document.querySelector(`[${REGION_ATTR}="${region}"]`);
  if (!el) return false;
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

/**
 * 键盘此刻归哪个区域(纯函数,门禁在 globalKeys.test.ts)。
 * 顺序:最近一次输入落在的区域 → 焦点所在 → 任一在场区域(阅读区优先)。
 */
export function pickKeyRegion(input: {
  owner: FocusRegion | null;
  focus: FocusRegion | null;
  onScreen: (region: FocusRegion) => boolean;
}): FocusRegion {
  if (input.owner && input.onScreen(input.owner)) return input.owner;
  if (input.focus && input.onScreen(input.focus)) return input.focus;
  for (const region of FOCUS_REGIONS) {
    if (input.onScreen(region)) return region;
  }
  return "notes";
}

export function setActiveKeyRegion(region: FocusRegion): void {
  ownerRegion = region;
}

export function activeKeyRegion(): FocusRegion {
  return pickKeyRegion({
    owner: ownerRegion,
    focus: regionFromTarget(document.activeElement),
    onScreen: regionOnScreen,
  });
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
 * 当前区域里这个键最终会执行的命令(已过 `when` 筛选)。
 *
 * 网页转发通道要在「抢焦点 → 执行」之前知道目标命令是不是需要主窗口焦点
 * (见 CommandDef.keepsPageFocus),所以这里把解析结果暴露出来。
 */
export function resolveBoundCommand(
  key: string,
  region: FocusRegion,
): CommandDef | null {
  const id = pickCommand(commandsForKey(key, region));
  return id ? (getCommand(id) ?? null) : null;
}

/**
 * 按已解析的按键执行命令。窗口级分发与网页阅读器的转发通道共用这一条路径,
 * 保证「页内按的键」和「主窗口按的键」走同一套区域规则。
 */
export function runBoundKey(key: string, region: FocusRegion): boolean {
  const cmd = resolveBoundCommand(key, region);
  if (!cmd) return false;
  if (keyContext === "drawing" && !DRAWING_ALLOWED.has(cmd.id)) return false;
  runCommand(cmd.id);
  return true;
}

export function installGlobalKeybindings() {
  // 区域归属的四个写入点:都是「用户主动动手」的事件,合成事件(tooltip、
  // 程序 focus)不算。滚动用 passive,滚动是热路径,监听不能拖慢它。
  const claimRegion = (event: Event) => {
    const region = regionFromTarget(event.target);
    if (region) ownerRegion = region;
  };
  window.addEventListener("pointerdown", claimRegion, true);
  window.addEventListener("focusin", claimRegion, true);
  window.addEventListener("wheel", claimRegion, { capture: true, passive: true });
  window.addEventListener("touchmove", claimRegion, { capture: true, passive: true });

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

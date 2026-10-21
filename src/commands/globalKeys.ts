import { allCommands, getCommand, runCommand } from "./registry";
import {
  bindingsForCommand,
  eventToKey,
  fixedPageCommandFor,
  isEditableTarget,
  isPlainFocusOwnedKey,
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

const DRAWING_ALLOWED = new Set(["nav.quick-switcher", "nav.command-palette", "workspace.open-daily"]);

export function setCommandKeyContext(ctx: CommandKeyContext) {
  keyContext = ctx;
}

export function installGlobalKeybindings() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (recordingHotkey || e.defaultPrevented) return;
      const key = eventToKey(e);
      if (!key) return;
      // 裸导航键(翻页/方向键)在编辑器、输入框里有原生含义,必须原样放行;
      // 带修饰键的绑定(如 ⌃J)则在任何焦点下都生效——用户显式按了组合键。
      if (
        isPlainFocusOwnedKey(e) &&
        (isEditableTarget(e.target) || isEditableTarget(document.activeElement))
      ) {
        return;
      }
      for (const cmd of allCommands()) {
        if (bindingsForCommand(cmd.id).includes(key)) {
          // 命令声明「现在不可用」时,这个键必须原样交给页面(方向键、PageUp…
          // 在编辑器/输入框里有它们自己的含义)。
          if (cmd.when && !cmd.when()) continue;
          if (keyContext === "drawing" && !DRAWING_ALLOWED.has(cmd.id)) return;
          e.preventDefault();
          e.stopPropagation();
          recordCommandChord(e);
          runCommand(cmd.id);
          return;
        }
      }

      // 固定翻页键:PageUp/PageDown 永远翻 PDF 页,即使用户把
      // study.pdf-* 改绑到别处。归属规则与可配置绑定相同——走到这里说明
      // 焦点不在编辑器/输入框(上面的裸导航键早退),命令不可用时原样放行。
      if (keyContext === "drawing") return;
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

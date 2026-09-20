import { allCommands, runCommand } from "./registry";
import { bindingsForCommand, eventToKey } from "./keys";
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
 * 也是「一个文件」,Obsidian 式的文件切换要照常可用,所以只放行快速跳转
 * 和命令面板(切走时会先收尾画布,见 actions.openNote / finalizeDrawingSession)。
 */
export type CommandKeyContext = "drawing" | null;

let keyContext: CommandKeyContext = null;

const DRAWING_ALLOWED = new Set(["nav.quick-switcher", "nav.command-palette"]);

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
      for (const cmd of allCommands()) {
        if (bindingsForCommand(cmd.id).includes(key)) {
          if (keyContext === "drawing" && !DRAWING_ALLOWED.has(cmd.id)) return;
          e.preventDefault();
          e.stopPropagation();
          recordCommandChord(e);
          runCommand(cmd.id);
          return;
        }
      }
    },
    true,
  );
}

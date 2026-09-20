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
 * 画布打开时挂起全部命令快捷键:画布内部有一整套自己的键位(1-9 工具、
 * Alt+S 吸附、⌘Z 撤销…),窗口级命令分发必须让路,否则 ⌘D/⌘S 这类重叠键
 * 会在画布上误触发笔记命令。挂起/恢复由 DrawingCanvas 挂载/卸载驱动。
 */
let suspended = false;

export function setCommandKeysSuspended(v: boolean) {
  suspended = v;
}

export function installGlobalKeybindings() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (recordingHotkey || suspended || e.defaultPrevented) return;
      const key = eventToKey(e);
      if (!key) return;
      for (const cmd of allCommands()) {
        if (bindingsForCommand(cmd.id).includes(key)) {
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

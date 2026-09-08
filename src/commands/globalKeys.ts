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

export function installGlobalKeybindings() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (recordingHotkey || e.defaultPrevented) return;
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

import { getCurrentWindow } from "@tauri-apps/api/window";

import { flushCursorSave } from "@/editor/cursorMemory";
import { flushLinksPersist } from "@/daily/links";
import { flushFootprintsPersist } from "@/footprint/store";
import { flushPersistConfig } from "@/state/appStore";

/**
 * Quits the app through the flush-then-destroy path the close button takes.
 *
 * Both entries exist because the debounced writes (cursor save, config,
 * links, footprints) live in JS: the native terminate path would drop whatever
 * the last 300ms held. ⌘Q is `app.quit` in the keybinding layer, and the native
 * menu hands its Quit item here as well (`bnote:menu-quit`).
 */
export function quitApp(): void {
  flushCursorSave();
  flushPersistConfig();
  flushLinksPersist();
  flushFootprintsPersist();
  void getCurrentWindow().destroy();
}

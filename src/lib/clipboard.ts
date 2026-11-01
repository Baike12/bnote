import { invoke } from "@tauri-apps/api/core";

/**
 * System clipboard text read/write.
 *
 * wry's WKWebView claims every ⌘ chord at the view layer and delivers it to the
 * page as an ordinary keydown: AppKit menu roles (copy:/paste:) never see those
 * events, and WebKit does not perform clipboard actions on behalf of keydown;
 * navigator.clipboard.readText is unavailable inside WKWebView. Copy/paste is
 * therefore implemented explicitly in JS (editor keybinding table + a form-element
 * fallback), while the clipboard itself goes through the Tauri clipboard plugin
 * (NSPasteboard on the Rust side; see the clipboard-manager:allow-read/write-text
 * permissions in capabilities/default.json). Environments without Tauri IPC (the
 * browser harness) fall back to navigator.clipboard; tests can inject an in-memory
 * clipboard via setClipboardOverrides to stay deterministic.
 */

let overrides: {
  read: () => Promise<string | null>;
  write: (text: string) => Promise<boolean>;
} | null = null;

export function setClipboardOverrides(o: typeof overrides) {
  overrides = o;
}

export async function readClipboardText(): Promise<string | null> {
  if (overrides) return overrides.read();
  try {
    return await invoke<string>("plugin:clipboard-manager|read_text");
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
}

export async function writeClipboardText(text: string): Promise<boolean> {
  if (overrides) return overrides.write(text);
  try {
    // The plugin's write_text command takes `text` (its official wrapper passes
    // { label, text }), not `contents`.
    await invoke("plugin:clipboard-manager|write_text", { text });
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

import { invoke } from "@tauri-apps/api/core";

/**
 * 系统剪贴板文本读写。
 *
 * wry 的 WKWebView 在视图层认领全部 ⌘ 组合键、作为普通 keydown 送进页面：
 * AppKit 菜单角色（copy:/paste:）永远收不到这些事件，WebKit 也不会对
 * keydown 代行剪贴板动作；navigator.clipboard.readText 在 WKWebView 里
 * 不可用。所以复制/粘贴由 JS 显式实现（编辑器键位表 + 表单元素兜底），
 * 剪贴板本体走 Tauri 剪贴板插件（Rust 侧 NSPasteboard，权限见
 * capabilities/default.json 的 clipboard-manager:allow-read/write-text）。
 * 无 Tauri IPC 的环境（浏览器 harness）回退 navigator.clipboard；测试可用
 * setClipboardOverrides 注入内存剪贴板保证确定性。
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
    // 插件 write_text 命令的参数名是 text（官方封装 { label, text }），不是 contents。
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

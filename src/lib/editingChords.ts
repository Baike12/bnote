import { editorApi } from "@/editor/api";
import { readClipboardText, writeClipboardText } from "./clipboard";

/**
 * ⌘C/⌘X/⌘V/⌘A 的表单元素兜底。
 *
 * wry 的 WKWebView 把 ⌘ 组合键在视图层认领、作为普通 keydown 送进页面：
 * AppKit 菜单角色（copy:/paste:）收不到，WebKit 也不对 keydown 代行剪贴板
 * 动作——纯 <input>/<textarea>（设置面板、搜索框、快速切换器）默认无法
 * 复制粘贴。编辑器内部由 CM 键位表处理（setup.ts，Mod-c/x/v 绑定），这里
 * 只兜文本表单元素，命中后 preventDefault 避免任何双重处理。
 */
export function installEditingChords() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.defaultPrevented) return;
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "x" && key !== "v" && key !== "a") return;

      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
      if (el.disabled || el.readOnly) return;
      const view = editorApi.view;
      if (view && view.contentDOM.contains(el)) return;

      e.preventDefault();
      e.stopPropagation();
      const from = el.selectionStart ?? el.value.length;
      const to = el.selectionEnd ?? el.value.length;

      if (key === "a") {
        el.select();
        return;
      }
      if (key === "c" || key === "x") {
        if (from === to) return;
        void writeClipboardText(el.value.slice(from, to));
        if (key === "x") {
          el.setRangeText("", from, to, "start");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      void readClipboardText().then((text) => {
        if (text === null) return;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.setRangeText(text, start, end, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    true,
  );
}

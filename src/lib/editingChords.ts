import { editorApi } from "@/editor/api";
import { readClipboardText, writeClipboardText } from "./clipboard";

/**
 * Fallback for ⌘C/⌘X/⌘V/⌘A in plain form elements.
 *
 * wry's WKWebView claims ⌘ chords at the view level and delivers them to the
 * page as ordinary keydown events: AppKit menu roles (copy:/paste:) never see
 * them, and WebKit does not perform the clipboard action on behalf of keydown —
 * so plain <input>/<textarea> (settings panel, search box, quick switcher)
 * cannot copy or paste by default. Inside the editor the CM keymap handles it
 * (setup.ts, Mod-c/x/v bindings); this only covers text form elements, and
 * preventDefault keeps anything from being handled twice.
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

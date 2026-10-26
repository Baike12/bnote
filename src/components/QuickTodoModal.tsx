import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { useAppStore } from "@/state/appStore";
import { captureTodoToToday } from "@/daily/capture";
import { imeOnChineseFocus, imeSyncToEditor } from "@/editor/imeSwitch";
import { isImeEnter } from "@/lib/imeEnter";
import { inputGuards } from "@/lib/inputGuards";

/**
 * 快速待办:一个输入框,Enter 落进今日日记待办区最前方。不打开、不切换
 * 当前文件——捕获动作不该打断手头的事。
 */
export function QuickTodoModal() {
  const open = useAppStore((s) => s.modal === "quicktodo");
  const setModal = useAppStore((s) => s.setModal);
  const showToast = useAppStore((s) => s.showToast);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const composingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setText("");
    setBusy(false);
  }, [open]);

  const close = () => setModal(null);

  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await captureTodoToToday(text);
      close();
    } catch (e) {
      showToast(`添加待办失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} width={560}>
      <div className="switcher quick-todo">
        <div className="quick-todo-head">
          <span className="quick-todo-title">快速待办</span>
          <span className="quick-todo-hint">加入今日日记待办区的最前方</span>
        </div>
        <input
          autoFocus
          className="switcher-input"
          placeholder="要做的事…"
          value={text}
          data-ime-chinese="true"
          onFocus={() => imeOnChineseFocus()}
          onBlur={() => imeSyncToEditor()}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            if (isImeEnter(e.nativeEvent, composingRef.current)) return;
            e.preventDefault();
            void submit();
          }}
          {...inputGuards}
        />
        <div className="quick-todo-actions">
          <span className="quick-todo-kbd">Enter 添加 · Esc 取消</span>
          <button
            className="btn primary"
            disabled={!text.trim() || busy}
            onClick={() => void submit()}
          >
            添加
          </button>
        </div>
      </div>
    </Modal>
  );
}

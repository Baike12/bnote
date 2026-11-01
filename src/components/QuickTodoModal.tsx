import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { useAppStore } from "@/state/appStore";
import { captureTodoToToday } from "@/daily/capture";
import { imeBeginTransientChinese, imeEndTransientChinese } from "@/editor/imeSwitch";
import { isImeEnter } from "@/lib/imeEnter";
import { inputGuards } from "@/lib/inputGuards";

/**
 * Quick todo: one input box, Enter drops the entry at the very top of
 * today's daily note todo list. It neither opens nor switches the current
 * file: capturing a todo must not interrupt what the user is doing.
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
    // The modal's lifetime is the Chinese input scope: switch to Chinese on
    // open and remember the input source from before, then restore it as-is
    // when the modal goes away (Enter to add, Escape to cancel, or a click on
    // the backdrop to close) - not on blur, because the input unmounts with
    // the modal and the blur timing is unreliable.
    imeBeginTransientChinese();
    return () => imeEndTransientChinese();
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

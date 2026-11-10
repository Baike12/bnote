import { useEffect, useRef, type Ref } from "react";
import type { SavedSessionMeta } from "@/lib/tauri";
import { formatSessionTime } from "./model";

/**
 * The history drawer: the conversations saved under the current material or
 * project. Picking one restores its family and continues there; the caller
 * still owns what "picking" means (activate an in-memory family or rebuild it
 * from disk).
 *
 * A click anywhere outside closes it (the whole window, not just the agent
 * panel: the point of the drawer is to get out of the way). The header button
 * that opens it carries `data-history-toggle` and is exempt, so pressing it
 * while the drawer is open still means "close" instead of close-then-reopen.
 */
export function AgentHistoryDrawer({
  containerRef,
  scopeLabel,
  savedSessions,
  activeSessionFileId,
  isCode,
  onClose,
  onNew,
  onPick,
}: {
  containerRef: Ref<HTMLDivElement>;
  scopeLabel: { title: string; detail: string } | null;
  savedSessions: SavedSessionMeta[];
  activeSessionFileId: string | null;
  isCode: boolean;
  onClose: () => void;
  onNew: () => void;
  onPick: (id: string) => void;
}) {
  // The close handler is recreated on every panel render (the drawer is mounted
  // from a conditional); the ref keeps the listener bound once instead of
  // re-attaching it on every keystroke in the composer.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".agent-history, [data-history-toggle]")) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    // `pointerdown` in the capture phase, like the header's other popovers: the
    // drawer is gone before the click behind it lands.
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      className="agent-history"
      role="dialog"
      aria-label="历史会话"
      ref={containerRef}
      tabIndex={-1}
    >
      <div className="agent-history-head">
        <div className="agent-history-heading">
          <span className="agent-history-heading-title">历史会话</span>
          <span className="agent-history-heading-sub" title={scopeLabel?.detail}>
            {scopeLabel?.title || "本材料"}
          </span>
        </div>
        <button className="agent-history-close" title="关闭" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>
      <button className="agent-history-new" onClick={onNew}>
        ＋ 新会话
      </button>
      {savedSessions.length === 0 ? (
        <p className="agent-history-empty">
          {isCode ? "这个项目还没有保存过会话" : "这份材料还没有保存过会话"}
        </p>
      ) : (
        <ul className="agent-history-list">
          {savedSessions.map((s) => (
            <li key={s.id}>
              <button
                className={`agent-history-item${s.id === activeSessionFileId ? " is-active" : ""}`}
                title={s.title}
                onClick={() => onPick(s.id)}
              >
                <span className="agent-history-item-title">{s.title}</span>
                <span className="agent-history-item-time">{formatSessionTime(s.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { Ref } from "react";
import type { SavedSessionMeta } from "@/lib/tauri";
import { formatSessionTime } from "./model";

/**
 * The history drawer: the conversations saved under the current material or
 * project. Picking one restores its family and continues there; the caller
 * still owns what "picking" means (activate an in-memory family or rebuild it
 * from disk).
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
                className={`agent-history-item${
                  s.id === activeSessionFileId ? " is-active" : ""
                }`}
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

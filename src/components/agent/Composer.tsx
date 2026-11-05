import { useEffect, useRef, useState } from "react";
import {
  contextLabel,
  formatPercent,
  formatTokenCount,
  occupancyPercent,
  usageTitle,
  type AgentUsage,
} from "@/study/agentUsage";
import { PERMISSION_MODES, ShieldIcon } from "./permissionModes";

export type PermissionMode = (typeof PERMISSION_MODES)[number]["id"];

/**
 * The permission selector of the composer footer: a custom button plus a
 * popover (never a native `<select>`), closed by a click outside it.
 */
export function AgentPermissionMenu({
  permissionMode,
  planActive,
  onChange,
}: {
  permissionMode: PermissionMode;
  planActive: boolean;
  onChange: (mode: PermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = PERMISSION_MODES.find((m) => m.id === permissionMode);
  return (
    <div className="agent-mode" ref={ref}>
      <button
        className="agent-mode-btn"
        onClick={() => setOpen((v) => !v)}
        title={active?.description}
      >
        <ShieldIcon />
        {planActive ? "计划模式" : active?.label}
      </button>
      {open && (
        <div className="agent-mode-pop" role="menu">
          {PERMISSION_MODES.map((mode) => (
            <button
              key={mode.id}
              className={`agent-mode-item${mode.id === permissionMode ? " is-active" : ""}`}
              role="menuitemradio"
              aria-checked={mode.id === permissionMode}
              onClick={() => {
                onChange(mode.id);
                setOpen(false);
              }}
            >
              <span className="agent-mode-item-label">
                {mode.label}
                {mode.id === permissionMode && <span className="agent-mode-check">✓</span>}
              </span>
              <span className="agent-mode-item-desc">{mode.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The session footnote: model, context occupancy and the send/stop button.
 *
 * The model line is the snapshot the session started with; when the setting
 * changed since, it says so and only a new session picks the new model up.
 */
export function AgentMeta({
  usage,
  contextLimit,
  modelName,
  configuredModel,
  busy,
  canSend,
  sendTitle,
  onSend,
  onStop,
}: {
  usage: AgentUsage | null;
  contextLimit: number;
  modelName: string;
  configuredModel: string;
  busy: boolean;
  canSend: boolean;
  sendTitle: string;
  onSend: () => void;
  onStop: () => void;
}) {
  const modelStale = Boolean(modelName && configuredModel && modelName !== configuredModel);
  const usagePct = occupancyPercent(usage, contextLimit);
  return (
    <>
      <span
        className="agent-meta"
        title={
          usageTitle(usage, contextLimit, modelName) +
          (modelStale
            ? `\n本会话按自己的配置继续(设置里现在是 ${configuredModel});点 ⟳ 开始新会话才会用新配置。`
            : "")
        }
      >
        <span className="agent-meta-model">
          {modelName || "未配置模型"}
          {modelStale ? " · 会话配置" : ""}
        </span>
        <span className="agent-meta-ctx">{contextLabel(usage, contextLimit)}</span>
        {usagePct !== null && <span className="agent-meta-pct">{formatPercent(usagePct)}</span>}
        {usage && (
          <span className="agent-meta-io">
            ↑{formatTokenCount(usage.input)} ↓{formatTokenCount(usage.output)}
          </span>
        )}
      </span>
      {busy ? (
        <button className="agent-send stop" onClick={onStop}>
          停止
        </button>
      ) : (
        <button className="agent-send" onClick={onSend} disabled={!canSend} title={sendTitle}>
          发送
        </button>
      )}
    </>
  );
}

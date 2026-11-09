import { useEffect, useRef, useState } from "react";
import { agentApi } from "@/lib/tauri";
import {
  cacheHitRate,
  sessionHitRate,
  contextLabel,
  contextOccupancy,
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
        <svg
          className="agent-mode-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
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

/** Rough per-part context sizes reported by the backend (estimated tokens). */
interface ContextBreakdown {
  system: number;
  tools: number;
  mcpTools: number;
  messages: number;
}

/** The circular progress ring (ZCode's ContextIcon): a track plus an arc that
 *  grows with the occupancy, rotating from 12 o'clock. */
function ContextRing({ pct }: { pct: number | null }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const used = pct == null ? 0 : Math.min(100, pct) / 100;
  return (
    <svg className="agent-ctx-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.8"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - used)}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/**
 * The context indicator + its hover card (ZCode's composer): the ring shows
 * the occupancy at a glance; hovering opens the breakdown — estimated
 * per-part sizes (the real total comes from the provider's usage), a stacked
 * bar and the cache hit rate when the provider reports cache reads.
 */
function AgentContextBadge({
  usage,
  contextLimit,
  sessionId,
}: {
  usage: AgentUsage | null;
  contextLimit: number;
  sessionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const pct = occupancyPercent(usage, contextLimit);

  // The breakdown is estimated over the live session; fetched when the card
  // opens so it is fresh without a fetch per turn. A failure leaves it empty
  // (the card still shows the real total from the usage).
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    void agentApi
      .contextBreakdown(sessionId)
      .then((b) => {
        if (!cancelled) setBreakdown(b);
      })
      .catch(() => {
        if (!cancelled) setBreakdown(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  // The session's token-weighted rate is the headline; the latest request is
  // shown beside it because a cold request is worth seeing on its own.
  const rate = sessionHitRate(usage);
  const latest = cacheHitRate(usage);
  const parts: { label: string; value: number; tone: string }[] = breakdown
    ? [
        { label: "系统提示词", value: breakdown.system, tone: "var(--ctx-tone-4)" },
        { label: "系统工具", value: breakdown.tools, tone: "var(--ctx-tone-3)" },
        { label: "MCP 工具", value: breakdown.mcpTools, tone: "var(--ctx-tone-2)" },
        { label: "消息", value: breakdown.messages, tone: "var(--ctx-tone-1)" },
      ].filter((p) => p.value > 0)
    : [];
  const partsTotal = parts.reduce((sum, p) => sum + p.value, 0);
  // The provider's total once a request reported it; before that (a restored
  // session, a panel that has not sent yet) the breakdown's own sum — the card
  // must never be an empty frame with "—/42万" over a blank bar.
  const occupancy = contextOccupancy(usage, contextLimit, partsTotal > 0 ? partsTotal : null);

  return (
    <div
      className="agent-ctx"
      ref={ref}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        className="agent-ctx-trigger"
        title={
          usage
            ? `上下文 ${formatTokenCount(usage.input + usage.output)} / ${formatTokenCount(contextLimit)}${pct === null ? "" : ` (${formatPercent(pct)})`}`
            : "上下文占用:本轮回复后显示"
        }
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ContextRing pct={pct} />
      </button>
      {open && (
        <div className="agent-ctx-pop" role="dialog" aria-label="上下文容量">
          <div className="agent-ctx-head">
            <span>上下文容量</span>
            <span
              className="agent-ctx-sum"
              title={occupancy?.estimated ? "估算值:本轮回复后由服务端返回的数据校准" : undefined}
            >
              {occupancy
                ? `${occupancy.estimated ? "≈" : ""}${formatTokenCount(occupancy.used)}`
                : "—"}
              /{contextLimit > 0 ? formatTokenCount(contextLimit) : "—"}
              {occupancy?.percent != null ? `(${formatPercent(occupancy.percent)})` : ""}
            </span>
          </div>
          <div className="agent-ctx-bar">
            {occupancy !== null &&
              parts.map((p) => (
                <span
                  key={p.label}
                  className="agent-ctx-seg"
                  style={{
                    // The segments are the composition of what is used; the
                    // whole bar's fill is the occupancy (an estimate when no
                    // request has reported one yet).
                    width: `${(p.value / partsTotal) * Math.min(100, occupancy.percent ?? 100)}%`,
                    background: p.tone,
                  }}
                />
              ))}
          </div>
          {parts.length > 0 && (
            <ul className="agent-ctx-rows">
              {parts.map((p) => (
                <li key={p.label}>
                  <span className="agent-ctx-dot" style={{ background: p.tone }} />
                  <span className="agent-ctx-label">{p.label}</span>
                  <span className="agent-ctx-val">
                    {partsTotal > 0 ? formatPercent((p.value / partsTotal) * 100) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {rate !== null && (
            <div className="agent-ctx-cache">
              <span>缓存命中率</span>
              <span className="agent-ctx-val">
                {formatPercent(rate * 100)}
                {latest !== null && (
                  <span className="agent-ctx-latest">本轮 {formatPercent(latest * 100)}</span>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The session footnote (ZCode's composer layout): on the left the context
 * ring + model, on the right the send/stop circle. The model line is the
 * snapshot the session started with; when the setting changed since, it says
 * so and only a new session picks the new model up.
 */
export function AgentMeta({
  usage,
  contextLimit,
  modelName,
  configuredModel,
  busy,
  sessionId,
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
  sessionId: string | null;
  canSend: boolean;
  sendTitle: string;
  onSend: () => void;
  onStop: () => void;
}) {
  const modelStale = Boolean(modelName && configuredModel && modelName !== configuredModel);
  return (
    <span className="agent-meta">
      {/* Generating replaces the ring with a spinner: the ring would read as
          "idle" while the usage is a turn behind anyway. */}
      {busy ? (
        <span className="agent-meta-spinner" aria-hidden="true" />
      ) : (
        <AgentContextBadge usage={usage} contextLimit={contextLimit} sessionId={sessionId} />
      )}
      <span
        className="agent-meta-model"
        title={
          usageTitle(usage, contextLimit, modelName) +
          (modelStale
            ? `\n本会话按自己的配置继续(设置里现在是 ${configuredModel});点 ⟳ 开始新会话才会用新配置。`
            : "")
        }
      >
        {modelName || "未配置模型"}
        {modelStale ? " · 会话配置" : ""}
      </span>
      <span className="agent-meta-ctx">{contextLabel(usage, contextLimit)}</span>
      {busy ? (
        <button className="agent-send stop" onClick={onStop} title="停止生成">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="7" y="7" width="10" height="10" rx="2" />
          </svg>
        </button>
      ) : (
        <button className="agent-send" onClick={onSend} disabled={!canSend} title={sendTitle}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      )}
    </span>
  );
}

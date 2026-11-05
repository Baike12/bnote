import { useEffect, useRef, useState } from "react";
import { MAX_AGENT_FONT, MIN_AGENT_FONT, formatAgentFont } from "@/study/agentFont";

/**
 * Header of the assistant panel: the session title (clicking it opens the
 * session list), action buttons on the right, and the narrow "fork source /
 * back" bar for auxiliary sessions.
 *
 * Why not a `<select>`: native dropdowns look completely different on every
 * platform (in WKWebView it is the system grey pill in the system font),
 * which is the furthest possible match for bnote's title button and
 * materials dropdown. A title button plus a popover shares the geometry and
 * colors of the middle column's "file name = materials dropdown" (the
 * language of `.content-title-btn` / `.study-history-pop`).
 *
 * Font size: the "Aa" button opens the same -/readout/+ control as the
 * middle column's web zoom (clicking the readout returns to 100%). The
 * assistant column is only a few hundred pixels wide, so keeping three
 * buttons plus the readout on screen would squeeze out the session name;
 * the controls live in the popover, the button itself stays in the header.
 *
 * The header is the window drag region (`data-tauri-drag-region="deep"`), so
 * every row in the popover must be a button: Tauri's drag.js intercepts on
 * clickable elements, a div would be treated as a drag handle and one click
 * would drag the window.
 */
export interface AgentHeaderConv {
  key: string;
  label: string;
  /** Session key this one was forked from; null for the main session. */
  parent: string | null;
  /** Summary of the message the fork is based on (only meaningful for auxiliary sessions). */
  basedOn: string;
}

interface AgentHeaderProps {
  convs: AgentHeaderConv[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  creativeMode: boolean;
  onToggleCreative: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onNewSession: () => void;
  /** Parent session to fall back to when this is an auxiliary session; null for the main session or when there is none. */
  parent: AgentHeaderConv | null;
  onBack: () => void;
  /** Conversation font scale (1 = 100%); the readout is that percentage. */
  fontScale: number;
  onFontStep: (direction: 1 | -1) => void;
  onFontReset: () => void;
}

export function AgentHeader({
  convs,
  activeKey,
  onSelect,
  creativeMode,
  onToggleCreative,
  historyOpen,
  onToggleHistory,
  onNewSession,
  parent,
  onBack,
  fontScale,
  onFontStep,
  onFontReset,
}: AgentHeaderProps) {
  // Only one overlay at a time: the session list or the font scale.
  const [open, setOpen] = useState<null | "conv" | "font">(null);
  const convRef = useRef<HTMLDivElement>(null);
  const fontRef = useRef<HTMLDivElement>(null);
  const active = convs.find((c) => c.key === activeKey) ?? null;
  const switchable = convs.length > 1;

  // Dismiss on outside click or Escape. `pointerdown` (not `click`): the
  // menu must be gone before the click behind it lands (same as the
  // materials dropdown).
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inside = convRef.current?.contains(target) || fontRef.current?.contains(target);
      if (!inside) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Switching materials or reopening the session may leave a single conversation: the menu has nothing left to switch to, so it closes itself.
  useEffect(() => {
    if (!switchable) setOpen((v) => (v === "conv" ? null : v));
  }, [switchable]);

  const title = active?.label ?? "主会话";
  const convOpen = open === "conv";
  const fontOpen = open === "font";

  return (
    <>
      <div className="agent-header" data-tauri-drag-region="deep">
        <div className="agent-conv" ref={convRef}>
          {switchable ? (
            <button
              className={`agent-conv-btn${convOpen ? " open" : ""}`}
              title={`切换会话(⌘⇧Y):${title}`}
              aria-haspopup="menu"
              aria-expanded={convOpen}
              onClick={() => setOpen(convOpen ? null : "conv")}
            >
              <span className="agent-conv-title">{title}</span>
              <span className="agent-conv-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          ) : (
            // With a single conversation there is nothing to switch to: a static title, not a button that does nothing when clicked.
            <span className="agent-conv-static" title={title}>
              {title}
            </span>
          )}
          {convOpen && (
            <div className="agent-conv-pop" role="menu" aria-label="切换会话">
              {convs.map((conv) => {
                const source = conv.parent
                  ? (convs.find((c) => c.key === conv.parent) ?? null)
                  : null;
                return (
                  <button
                    key={conv.key}
                    className={`agent-conv-item${conv.key === activeKey ? " is-active" : ""}`}
                    role="menuitemradio"
                    aria-checked={conv.key === activeKey}
                    title={conv.label}
                    onClick={() => {
                      setOpen(null);
                      onSelect(conv.key);
                    }}
                  >
                    <span className="agent-conv-item-title">{conv.label}</span>
                    <span className="agent-conv-item-sub">
                      {source ? `辅助会话 · 基于「${conv.basedOn}」` : "跟随当前材料"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <span className="spacer" />
        {/* Conversation font: the button stays in the header, the -/readout/+ controls live in the popover (clicking the readout returns to 100%). */}
        <div className="agent-font" ref={fontRef}>
          <button
            className={`icon-btn agent-font-btn${fontOpen ? " is-active" : ""}`}
            title={`对话字号 ${formatAgentFont(fontScale)}(85%–160%)`}
            aria-haspopup="dialog"
            aria-expanded={fontOpen}
            onClick={() => setOpen(fontOpen ? null : "font")}
          >
            <span className="agent-font-glyph" aria-hidden="true">
              Aa
            </span>
          </button>
          {fontOpen && (
            <div className="agent-font-pop" role="dialog" aria-label="对话字号">
              <span className="agent-font-label">对话字号</span>
              <div className="agent-font-row">
                <button
                  className="agent-font-step"
                  title="缩小一档"
                  disabled={fontScale <= MIN_AGENT_FONT + 1e-6}
                  onClick={() => onFontStep(-1)}
                >
                  −
                </button>
                <button className="agent-font-value" title="回到 100%" onClick={onFontReset}>
                  {formatAgentFont(fontScale)}
                </button>
                <button
                  className="agent-font-step"
                  title="放大一档"
                  disabled={fontScale >= MAX_AGENT_FONT - 1e-6}
                  onClick={() => onFontStep(1)}
                >
                  +
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          className={`icon-btn${creativeMode ? " is-active" : ""}`}
          title={
            creativeMode
              ? "创作模式(⌘⇧G):开启中,点这里切回学习问答"
              : "切换到创作模式(⌘⇧G):带工具与技能,生成 HTML 实时预览"
          }
          aria-pressed={creativeMode}
          onClick={onToggleCreative}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19l7-7a2.4 2.4 0 0 0-3.4-3.4l-9.6 9.6L4 22l2.1-.5a10 10 0 0 0 2.4-1L12 19z" />
            <path d="M14.5 6.5l3 3" />
          </svg>
        </button>
        <button
          className={`icon-btn${historyOpen ? " is-active" : ""}`}
          title="历史会话(这份材料保存过的对话)"
          aria-pressed={historyOpen}
          onClick={onToggleHistory}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
            <path d="M12 8v4l3 2" />
          </svg>
        </button>
        <button
          className="icon-btn"
          title="新会话(重读 .bnote/AGENTS.md 与配置)"
          onClick={onNewSession}
        >
          ⟳
        </button>
      </div>
      {parent && (
        <div className="agent-aux-bar">
          <span className="agent-aux-badge">辅助会话</span>
          <span className="agent-aux-based" title={active?.basedOn}>
            基于「{active?.basedOn}」
          </span>
          <button
            className="agent-aux-back"
            title={`返回「${parent.label}」(⌘⇧Y)`}
            onClick={onBack}
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19 12H5" />
              <path d="m11 18-6-6 6-6" />
            </svg>
            返回
          </button>
        </div>
      )}
    </>
  );
}

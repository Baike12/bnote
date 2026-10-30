import { useEffect, useRef, useState } from "react";
import {
  MAX_AGENT_FONT,
  MIN_AGENT_FONT,
  formatAgentFont,
} from "@/study/agentFont";

/**
 * 学习助手面板的头部:会话标题(点开是会话列表)+ 右侧动作按钮,以及辅助
 * 会话的「分叉来源 / 返回」窄条。
 *
 * 为什么不用 `<select>`:原生下拉在各平台长得完全不一样(WKWebView 里是
 * 系统的灰胶囊 + 系统字体),和 bnote 的标题按钮、材料下拉差得最远。这里
 * 换成标题按钮 + popover,与中栏「文件名 = 材料下拉」同一套几何和配色
 * (`.content-title-btn` / `.study-history-pop` 的语言)。
 *
 * 字号:「Aa」按钮展开与中栏网页缩放同一套 −/读数/+ 控件(读数点击回到
 * 100%):助手栏只有几百像素宽,常驻三个按钮 + 读数会把会话名挤没,所以
 * 控件收在 popover 里,按钮本身留在头部。
 *
 * 头部是窗口拖动区(`data-tauri-drag-region="deep"`),所以弹层里的每一行
 * 都必须是 button:Tauri 的 drag.js 在可点元素上截断,div 会被当成拖动
 * 把手,点一下就把窗口拖起来。
 */
export interface AgentHeaderConv {
  key: string;
  label: string;
  /** 分叉来源会话 key;主会话为 null。 */
  parent: string | null;
  /** 分叉所基于的消息摘要(辅助会话才有意义)。 */
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
  /** 当前是辅助会话时退回的父会话;主会话 / 空会话为 null。 */
  parent: AgentHeaderConv | null;
  onBack: () => void;
  /** 对话字号缩放(1 = 100%),读数就是这个百分比。 */
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
  // 一次只开一个弹层:会话列表 / 字号。
  const [open, setOpen] = useState<null | "conv" | "font">(null);
  const convRef = useRef<HTMLDivElement>(null);
  const fontRef = useRef<HTMLDivElement>(null);
  const active = convs.find((c) => c.key === activeKey) ?? null;
  const switchable = convs.length > 1;

  // 点外面 / Esc 收起。pointerdown(不是 click):菜单在下面的点击落下去
  // 之前就已经没了(与材料下拉同一套)。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inside =
        convRef.current?.contains(target) || fontRef.current?.contains(target);
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

  // 换材料 / 重开会话后可能只剩一条:菜单已经没有可选项,自己收起。
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
            // 只有一条会话时没有可切换的东西:静态标题,别做成点了没反应的按钮。
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
        {/* 对话字号:按钮常驻,−/读数/+ 收在 popover 里(读数点击回到 100%)。 */}
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
                <button
                  className="agent-font-value"
                  title="回到 100%"
                  onClick={onFontReset}
                >
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
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

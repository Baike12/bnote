/**
 * 学习助手面板的对话字号缩放。
 *
 * 与中栏网页缩放同一套交互(档位步进 + 读数点击回到 100%),但改的是面板
 * 里的文字:正文基准 15px 乘以缩放,标题 / 代码 / 工具行按同一比例派生
 * (见 global.css 的 `--agent-text`)。头部读数就是这个百分比。
 *
 * 档位:100% 两侧各留三档(85%–160%)。助手栏宽度只有几百像素,再往上
 * 正文就要一行放不下几个字;再往下已经不可读。设置里手改坏的值在这里夹回。
 */

/** 缩放档位(升序)。 */
const AGENT_FONT_STEPS = [0.85, 1, 1.1, 1.25, 1.4, 1.6];

export const MIN_AGENT_FONT = 0.85;
export const MAX_AGENT_FONT = 1.6;
export const DEFAULT_AGENT_FONT = 1;

/** 设置值可能是旧配置(没有这项)/手改 JSON:夹进 [85%, 160%]。 */
export function normalizeAgentFont(value: unknown): number {
  const raw =
    typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_AGENT_FONT;
  return Math.min(MAX_AGENT_FONT, Math.max(MIN_AGENT_FONT, raw));
}

/** 在档位表里走一步;当前值不在档位上时落到相邻档(不按固定倍数累乘)。 */
export function stepAgentFont(current: unknown, direction: 1 | -1): number {
  const value = normalizeAgentFont(current);
  if (direction > 0) {
    for (const step of AGENT_FONT_STEPS) {
      if (step > value + 1e-6) return step;
    }
    return MAX_AGENT_FONT;
  }
  for (let i = AGENT_FONT_STEPS.length - 1; i >= 0; i -= 1) {
    if (AGENT_FONT_STEPS[i] < value - 1e-6) return AGENT_FONT_STEPS[i];
  }
  return MIN_AGENT_FONT;
}

/** 读数,如 "110%"。 */
export function formatAgentFont(value: unknown): string {
  return `${Math.round(normalizeAgentFont(value) * 100)}%`;
}

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_FONT,
  MAX_AGENT_FONT,
  MIN_AGENT_FONT,
  formatAgentFont,
  normalizeAgentFont,
  stepAgentFont,
} from "./agentFont";

describe("助手对话字号缩放", () => {
  it("默认 100%,坏值回落到默认", () => {
    expect(normalizeAgentFont(undefined)).toBe(DEFAULT_AGENT_FONT);
    expect(normalizeAgentFont("1.2")).toBe(DEFAULT_AGENT_FONT);
    expect(normalizeAgentFont(Number.NaN)).toBe(DEFAULT_AGENT_FONT);
  });

  it("夹进 85%–160%", () => {
    expect(normalizeAgentFont(0.2)).toBe(MIN_AGENT_FONT);
    expect(normalizeAgentFont(9)).toBe(MAX_AGENT_FONT);
  });

  it("放大/缩小都在档位上往返,不累乘漂移", () => {
    expect(stepAgentFont(1, 1)).toBe(1.1);
    expect(stepAgentFont(1.1, -1)).toBe(1);
    expect(stepAgentFont(1, -1)).toBe(0.85);
    expect(stepAgentFont(stepAgentFont(1.4, 1), -1)).toBe(1.4);
  });

  it("端点不越界", () => {
    expect(stepAgentFont(MAX_AGENT_FONT, 1)).toBe(MAX_AGENT_FONT);
    expect(stepAgentFont(MIN_AGENT_FONT, -1)).toBe(MIN_AGENT_FONT);
    expect(stepAgentFont(MAX_AGENT_FONT, -1)).toBe(1.4);
  });

  it("手改的非档位值落到相邻档", () => {
    expect(stepAgentFont(1.2, 1)).toBe(1.25);
    expect(stepAgentFont(1.2, -1)).toBe(1.1);
  });

  it("读数按百分比取整", () => {
    expect(formatAgentFont(1)).toBe("100%");
    expect(formatAgentFont(1.25)).toBe("125%");
    expect(formatAgentFont(0.85)).toBe("85%");
  });
});

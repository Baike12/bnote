import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_FONT,
  MAX_AGENT_FONT,
  MIN_AGENT_FONT,
  formatAgentFont,
  normalizeAgentFont,
  stepAgentFont,
} from "./agentFont";

describe("agent chat font size scaling", () => {
  it("defaults to 100%, bad values fall back to the default", () => {
    expect(normalizeAgentFont(undefined)).toBe(DEFAULT_AGENT_FONT);
    expect(normalizeAgentFont("1.2")).toBe(DEFAULT_AGENT_FONT);
    expect(normalizeAgentFont(Number.NaN)).toBe(DEFAULT_AGENT_FONT);
  });

  it("clamps into 85%–160%", () => {
    expect(normalizeAgentFont(0.2)).toBe(MIN_AGENT_FONT);
    expect(normalizeAgentFont(9)).toBe(MAX_AGENT_FONT);
  });

  it("zoom in and out round-trip on the same steps without compounding drift", () => {
    expect(stepAgentFont(1, 1)).toBe(1.1);
    expect(stepAgentFont(1.1, -1)).toBe(1);
    expect(stepAgentFont(1, -1)).toBe(0.85);
    expect(stepAgentFont(stepAgentFont(1.4, 1), -1)).toBe(1.4);
  });

  it("the endpoints do not go out of bounds", () => {
    expect(stepAgentFont(MAX_AGENT_FONT, 1)).toBe(MAX_AGENT_FONT);
    expect(stepAgentFont(MIN_AGENT_FONT, -1)).toBe(MIN_AGENT_FONT);
    expect(stepAgentFont(MAX_AGENT_FONT, -1)).toBe(1.4);
  });

  it("a hand-edited off-step value snaps to the adjacent step", () => {
    expect(stepAgentFont(1.2, 1)).toBe(1.25);
    expect(stepAgentFont(1.2, -1)).toBe(1.1);
  });

  it("the readout is rounded to a whole percentage", () => {
    expect(formatAgentFont(1)).toBe("100%");
    expect(formatAgentFont(1.25)).toBe("125%");
    expect(formatAgentFont(0.85)).toBe("85%");
  });
});

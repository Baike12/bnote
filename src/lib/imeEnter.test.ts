import { describe, expect, it } from "vitest";
import { isImeEnter } from "./imeEnter";

/**
 * Root-cause regression (2026-10-26): the AgentPanel input only checked
 * nativeEvent.isComposing, but WKWebView reports the IME confirmation key
 * (Enter after typing latin letters in Sogou Chinese mode) with
 * isComposing=false and keyCode=229, so confirming a candidate was treated
 * as "send". This gate locks the rule: any single signal being true makes
 * the Enter an IME Enter.
 */
describe("isImeEnter", () => {
  it("普通回车是发送", () => {
    expect(isImeEnter({ isComposing: false, keyCode: 13 }, false)).toBe(false);
  });

  it("标准 isComposing 组词中是输入法回车", () => {
    expect(isImeEnter({ isComposing: true, keyCode: 13 }, false)).toBe(true);
  });

  it("WKWebView 确认候选:isComposing=false 但 keyCode=229", () => {
    expect(isImeEnter({ isComposing: false, keyCode: 229 }, false)).toBe(true);
  });

  it("组件自己记的组词会话(引擎不给 isComposing/229 时兜底)", () => {
    expect(isImeEnter({ isComposing: false, keyCode: 13 }, true)).toBe(true);
  });
});

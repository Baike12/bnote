import { describe, expect, it } from "vitest";
import { isImeEnter } from "./imeEnter";

/**
 * 根因回归(2026-10-26):AgentPanel 输入框只查 nativeEvent.isComposing,
 * 而 WKWebView 在输入法确认键(搜狗中文模式下敲英文字母后回车)上报
 * isComposing=false、keyCode=229,于是确认候选被当成「发送」。这里锁住
 * 判定:任一信号为真都算输入法回车。
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

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
  it("a plain Enter is a send", () => {
    expect(isImeEnter({ isComposing: false, keyCode: 13 }, false)).toBe(false);
  });

  it("a standard isComposing composition makes it an IME Enter", () => {
    expect(isImeEnter({ isComposing: true, keyCode: 13 }, false)).toBe(true);
  });

  it("WKWebView candidate confirmation: isComposing=false but keyCode=229", () => {
    expect(isImeEnter({ isComposing: false, keyCode: 229 }, false)).toBe(true);
  });

  it("the component's own composition session (the fallback when the engine gives no isComposing/229)", () => {
    expect(isImeEnter({ isComposing: false, keyCode: 13 }, true)).toBe(true);
  });
});

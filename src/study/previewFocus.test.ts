import { describe, expect, it } from "vitest";
import type { CommandDef } from "@/commands/registry";
import { needsMainWebviewFocus } from "./previewFocus";

function cmd(patch: Partial<CommandDef> = {}): CommandDef {
  return { id: "test.cmd", title: "t", category: "t", run: () => {}, ...patch };
}

/**
 * Focus rules for forwarded keys from the web page. Once a native child
 * webview has taken the first responder, only the main webview taking it back
 * returns the keyboard — otherwise every later key still goes around in the
 * page and the main window commands (region switch, quick todo) look entirely
 * dead.
 */
describe("网页转发键的主窗口焦点", () => {
  it("普通命令先抢回主窗口键盘", () => {
    expect(needsMainWebviewFocus(cmd())).toBe(true);
    expect(needsMainWebviewFocus(cmd({ keepsPageFocus: false }))).toBe(true);
  });

  it("原地生效的命令保持页面焦点", () => {
    expect(needsMainWebviewFocus(cmd({ keepsPageFocus: true }))).toBe(false);
  });

  it("解析不到命令时不动焦点", () => {
    expect(needsMainWebviewFocus(null)).toBe(false);
  });
});

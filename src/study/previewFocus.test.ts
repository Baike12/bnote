import { describe, expect, it } from "vitest";
import type { CommandDef } from "@/commands/registry";
import { needsMainWebviewFocus } from "./previewFocus";

function cmd(patch: Partial<CommandDef> = {}): CommandDef {
  return { id: "test.cmd", title: "t", category: "t", run: () => {}, ...patch };
}

/**
 * 网页转发键的焦点规则。原生子 webview 抢到第一响应者后,只有让主 webview
 * 自己当第一响应者才能把键盘拿回来——否则每个后续按键都还在网页里转一圈,
 * 主窗口命令(区域切换、快速待办)看起来全部失灵。
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

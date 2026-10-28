import type { CommandDef } from "@/commands/registry";

/**
 * 网页里按下的转发键:执行前要不要先把键盘收回主窗口?
 *
 * 原生子 webview 当上第一响应者后,键盘输入只进网页;主窗口 DOM 里的
 * focus() 不会把第一响应者抢回来,得走 `Webview.setFocus`。所以除了
 * 「原地生效、页面必须保持焦点」的命令(网页缩放、保存,见
 * CommandDef.keepsPageFocus),转发键执行前都要先收回键盘。
 *
 * 解析不到命令时不动焦点:按键本来就不执行任何东西,抢键盘只是副作用。
 */
export function needsMainWebviewFocus(cmd: CommandDef | null): boolean {
  return cmd !== null && cmd.keepsPageFocus !== true;
}

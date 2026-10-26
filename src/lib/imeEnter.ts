/**
 * 这次 Enter 是否属于输入法会话(组词中 / 确认候选字母),而不是「发送」。
 *
 * 三个信号都要看:
 * - composing:组件自己用 compositionstart/end 记的会话状态,不依赖引擎;
 * - isComposing:标准字段,组词期间为 true;
 * - keyCode === 229:WKWebView 在输入法确认键上报 229、isComposing 却是 false
 *   (vim 引擎的 composing 判定同样靠这一对,见 src/editor/vim/vim.ts)。
 *
 * 只看 isComposing 会让「中文模式下敲英文、回车确认」直接触发发送。
 */
export function isImeEnter(
  event: { isComposing?: boolean; keyCode?: number },
  composing: boolean,
): boolean {
  return composing || event.isComposing === true || event.keyCode === 229;
}

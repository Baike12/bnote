// 启动主题引导：在 React/CSS 之前同步设置 data-theme，light 用户启动不闪深色。
// 独立文件而非内联脚本——Tauri CSP 是 script-src 'self' blob:，内联会被静默拦截。
// 持久真相在 config.json（settings.theme），这里只是它的启动镜像（applyTheme 写入）。
try {
  if (localStorage.getItem("bnote.theme") === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch {
  /* localStorage 不可用：按默认 dark 渲染 */
}

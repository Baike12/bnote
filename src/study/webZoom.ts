/**
 * 学习模式网页预览的页面缩放。
 *
 * 原生子 webview 的缩放是浏览器级缩放(WKWebView.pageZoom / WebView2
 * SetZoomFactor):文字重排、图片一起放大,不是把 DOM 整体拉伸。主窗口只
 * 持有缩放值,由 ContentPane 推给 Rust——单一写入者,页面自己不记比例。
 *
 * 步进与 Chrome 一致:用户在 100% / 110% / 125% 之间来回,而不是每次 ±1%
 * 要点几十下;上限 300%、下限 50%,再往外页面版式已经不可读。
 */

/** 缩放档位(升序)。 */
const WEB_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export const MIN_WEB_ZOOM = 0.5;
export const MAX_WEB_ZOOM = 3;
export const DEFAULT_WEB_ZOOM = 1;

/** 设置值可能是旧配置/手改 JSON:夹进 [50%, 300%]。 */
export function normalizeWebZoom(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_WEB_ZOOM;
  return Math.min(MAX_WEB_ZOOM, Math.max(MIN_WEB_ZOOM, raw));
}

/** 在档位表里走一步;当前值不在档位上时落到相邻档(不按固定倍数累乘)。 */
export function stepWebZoom(current: unknown, direction: 1 | -1): number {
  const value = normalizeWebZoom(current);
  if (direction > 0) {
    for (const step of WEB_ZOOM_STEPS) {
      if (step > value + 1e-6) return step;
    }
    return MAX_WEB_ZOOM;
  }
  for (let i = WEB_ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (WEB_ZOOM_STEPS[i] < value - 1e-6) return WEB_ZOOM_STEPS[i];
  }
  return MIN_WEB_ZOOM;
}

/** 工具栏读数,如 "110%"。 */
export function formatWebZoom(value: unknown): string {
  return `${Math.round(normalizeWebZoom(value) * 100)}%`;
}

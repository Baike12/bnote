import type { PointerEvent as ReactPointerEvent } from "react";

export interface SplitDragOptions {
  /** 分栏线上的 pointerdown(取位移起点与手柄元素)。 */
  event: ReactPointerEvent<HTMLElement>;
  /** 布局容器(宽度基准 + CSS 变量落点)。 */
  host: HTMLElement | null;
  /** 本次拖动允许改写的 CSS 变量。 */
  variables: string[];
  /** 抬起时的比较基准(存进设置的偏好值)。 */
  stored: Record<string, number>;
  /** 把「指针相对按下点的位移」换算成这次要写的变量值。 */
  compute: (dx: number) => Record<string, number>;
  /** 指针抬起且值有变化时提交偏好。 */
  commit: (values: Record<string, number>) => void;
  /** 每帧位移后调用(子 webview 之类需要跟着重报矩形的消费方)。 */
  onMove?: () => void;
}

/**
 * 分栏线拖动的公共骨架:学习模式三栏与项目视图三栏共用。
 *
 * 指针移动时只写 CSS 变量、不 setState——面板里有 CodeMirror,60Hz 重渲染
 * 代价太大;指针抬起时一次性提交。拖动按**位移**算:起点是线当前的位置,
 * 握线偏了 4px 也不会跳一下。
 */
export function startSplitDrag({
  event,
  host,
  variables,
  stored,
  compute,
  commit,
  onMove,
}: SplitDragOptions): void {
  if (!host) return;
  const hostRect = host.getBoundingClientRect();
  if (hostRect.width <= 0) return;
  event.preventDefault();

  const handle = event.currentTarget;
  handle.classList.add("dragging");
  // 指针事件挂在 window(不是 8px 的手柄)上,快速移动/移出窗口也不丢。
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // 没有活动指针(合成事件 / 无悬停输入)
  }

  const startX = event.clientX;
  let latest: Record<string, number> | null = null;

  const onPointerMove = (move: PointerEvent) => {
    const values = compute(move.clientX - startX);
    latest = values;
    for (const [name, value] of Object.entries(values)) {
      host.style.setProperty(name, `${value}px`);
    }
    onMove?.();
  };

  const onPointerUp = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    handle.classList.remove("dragging");
    const done = latest;
    if (done && variables.some((name) => done[name] !== stored[name])) commit(done);
    // 显示宽度(窗口窄时被 CSS 夹过)不能当成新偏好写回变量:还原成存值。
    for (const name of variables) {
      host.style.setProperty(name, `${latest?.[name] ?? stored[name]}px`);
    }
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

import { getCurrentWindow } from "@tauri-apps/api/window";
import { getConfigSnapshot, persistConfig, type WindowState } from "@/state/appStore";
import { useFocusStore } from "@/focus/store";

/**
 * 主窗口的大小/位置记忆。
 *
 * 写入走 `persistConfig` 这一条唯一通道(和设置、上次文件同一个 config.json
 * 快照),不另开第二个写入者,避免两边读改写互相覆盖。恢复在 Rust 侧
 * (`config.rs::restore_window_bounds`)于窗口首次绘制前完成,启动时不会看到
 * 窗口先按默认尺寸出现再跳一下。
 *
 * 最大化时窗口报告的是全屏尺寸,不能当成「用户想要的普通尺寸」存下来:
 * 这种情况只把 maximized 置 true,尺寸保留上一次的普通窗口大小。
 */
export const MIN_WINDOW_W = 216;
export const MIN_WINDOW_H = 480;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 磁盘上的值可能是旧版/手改的:坏值整条丢弃,尺寸夹进合法范围。 */
export function normalizeWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const width = num(r.width);
  const height = num(r.height);
  const x = num(r.x);
  const y = num(r.y);
  if (width === null || height === null || x === null || y === null) return null;
  return {
    width: Math.max(MIN_WINDOW_W, Math.round(width)),
    height: Math.max(MIN_WINDOW_H, Math.round(height)),
    x: Math.round(x),
    y: Math.round(y),
    maximized: r.maximized === true,
  };
}

/** 最大化的窗口:只记 maximized,普通尺寸沿用上一次(没有就记当前值)。 */
export function mergeWindowState(
  prev: WindowState | null,
  bounds: WindowBounds,
  maximized: boolean,
): WindowState {
  const base = maximized && prev ? prev : bounds;
  const merged = normalizeWindowState({ ...base, maximized });
  // normalize 只在字段非法时返回 null;这里传入的都是有限数,兜底给默认值。
  return merged ?? { ...bounds, maximized };
}

function readState(win: ReturnType<typeof getCurrentWindow>): Promise<WindowState | null> {
  return (async () => {
    if (await win.isMinimized()) return null;
    const maximized = await win.isMaximized();
    if (await win.isFullscreen()) return null;
    const scale = await win.scaleFactor();
    const size = (await win.innerSize()).toLogical(scale);
    const pos = (await win.outerPosition()).toLogical(scale);
    return mergeWindowState(
      normalizeWindowState(getConfigSnapshot().window),
      { x: pos.x, y: pos.y, width: size.width, height: size.height },
      maximized,
    );
  })();
}

/**
 * 监听移动/缩放并落盘,返回取消函数。非 Tauri 环境(浏览器 harness)直接
 * 返回空函数:窗口 API 在那儿不存在。
 */
export function trackWindowState(): () => void {
  let win: ReturnType<typeof getCurrentWindow>;
  try {
    win = getCurrentWindow();
  } catch {
    return () => {};
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const save = () => {
    timer = null;
    void readState(win)
      .then((state) => {
        // 读盘/查询期间窗口可能已经关了:放弃这次写入。
        if (disposed || !state) return;
        // 独占锁期间窗口是铺满屏幕的,那不是用户想要的窗口大小,存下去下次
        // 启动就变成全屏窗口了。锁退掉后会有一次正常的 resize,那时再存。
        if (useFocusStore.getState().locked) return;
        persistConfig({ ...getConfigSnapshot(), window: state });
      })
      .catch(() => {});
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 150);
  };
  const offs: Array<() => void> = [];
  void win.onResized(schedule).then((off) => {
    if (disposed) off();
    else offs.push(off);
  });
  void win.onMoved(schedule).then((off) => {
    if (disposed) off();
    else offs.push(off);
  });
  // 首次启动(还没有 window 字段)也记一次:之后不再需要用户先动一下窗口
  // 才有可恢复的几何。
  if (!getConfigSnapshot().window) schedule();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const off of offs) off();
  };
}

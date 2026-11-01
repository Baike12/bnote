import { getCurrentWindow } from "@tauri-apps/api/window";
import { getConfigSnapshot, persistConfig, type WindowState } from "@/state/appStore";
import { useFocusStore } from "@/focus/store";

/**
 * Size/position memory for the main window.
 *
 * Writes go through `persistConfig`, the single channel shared with settings
 * and the last-opened file (the same config.json snapshot), so there is no
 * second writer whose read-modify-write could clobber the other. Restoration
 * happens on the Rust side (`config.rs::restore_window_bounds`) before the
 * window is first painted, so startup never shows the window at its default
 * size and then jump.
 *
 * A maximized window reports the full-screen size, which must not be stored as
 * the "normal size the user wants": in that case only `maximized` is set and
 * the size keeps the last normal window size.
 */
export const MIN_WINDOW_W = 216;
export const MIN_WINDOW_H = 480;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The value on disk may be from an older version or hand-edited: a bad record is dropped whole, and the size is clamped into the legal range. */
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

/** Maximized window: only `maximized` is recorded, the normal size carries over from the previous value (or the current one if there is none). */
export function mergeWindowState(
  prev: WindowState | null,
  bounds: WindowBounds,
  maximized: boolean,
): WindowState {
  const base = maximized && prev ? prev : bounds;
  const merged = normalizeWindowState({ ...base, maximized });
  // normalize only returns null when a field is invalid; everything passed here
  // is finite, so this is just a fallback to the raw bounds.
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
 * Watch for moves/resizes and persist them; returns a cancel function. In a
 * non-Tauri environment (the browser harness) it returns a no-op: the window
 * API does not exist there.
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
        // The window may have been closed while the state was being read:
        // drop this write.
        if (disposed || !state) return;
        // While the exclusive lock is held the window fills the screen, which
        // is not the window size the user wants; storing it would make the
        // next launch open full-screen. Releasing the lock produces a normal
        // resize, and the size is stored then.
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
  // Record once on first launch too (there is no `window` field yet), so the
  // user no longer has to move the window once before there is geometry to
  // restore.
  if (!getConfigSnapshot().window) schedule();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const off of offs) off();
  };
}

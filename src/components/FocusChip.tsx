import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useFocusStore } from "@/focus/store";
import { formatClock, isActive, remainingMs } from "@/focus/timer";

/**
 * Focus chip at the left end of the status bar.
 *
 * It does exactly one thing: **one click starts a focus session**. Once
 * started, the chip becomes a pure status display and is disabled: there is
 * no pause, no early end, no way out of the screen lock (the only path that
 * releases the lock is letting the timer run out). The lock configuration is
 * not here either: the length lives in the settings page, both locks are
 * always fully on.
 */
export function FocusChip() {
  const timer = useFocusStore((s) => s.timer);
  const now = useFocusStore((s) => s.now);
  const locked = useFocusStore((s) => s.locked);
  const error = useFocusStore((s) => s.error);
  const start = useFocusStore((s) => s.start);

  const active = isActive(timer);
  const clock = active
    ? formatClock(remainingMs(timer, now))
    : formatClock(timer.config.focusMinutes * 60_000);

  // The window title follows the countdown: the title bar is overlay +
  // hiddenTitle and invisible most of the time, but the scheduler center and
  // the window menu read NSWindow.title, so during a focus session the
  // remaining time is visible at a glance. It doubles as an external
  // observation point: whether the countdown is really running, without
  // guessing from the status bar.
  useEffect(() => {
    const title = active ? `bnote · 专注 ${clock}` : "bnote";
    try {
      void getCurrentWindow().setTitle(title).catch(() => {});
    } catch {
      // The browser harness has no Tauri window.
    }
  }, [active, clock]);

  return (
    <div className="focus-chip-wrap">
      <button
        type="button"
        className={`focus-chip${active ? " running" : ""}${locked ? " locked" : ""}`}
        disabled={active}
        title={
          active
            ? "专注进行中:这一段走完才会解锁"
            : error
              ? `上一次没有开始:${error}`
              : "点一下开始专注:独占屏幕 + 硬锁,开始后不能中途退出"
        }
        onClick={() => void start()}
      >
        {active && <span className="focus-lock" aria-hidden="true">🔒</span>}
        <span className="focus-label">{active ? "专注中" : "番茄钟"}</span>
        <span className="focus-time">{clock}</span>
      </button>
    </div>
  );
}

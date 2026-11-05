import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useFocusStore } from "@/focus/store";
import { formatClock, isActive, remainingMs } from "@/focus/timer";

/**
 * Focus chips at the left end of the status bar.
 *
 * One chip per configured duration, each showing nothing but that length: a
 * click starts a stretch of exactly that length. Once started the chips are
 * replaced by one pure status chip and every button is disabled: there is no
 * pause, no early end, no way out of the screen lock (the only path that
 * releases the lock is letting the timer run out). The durations themselves
 * live in the settings page, both locks are always fully on.
 */
export function FocusChip() {
  const timer = useFocusStore((s) => s.timer);
  const now = useFocusStore((s) => s.now);
  const locked = useFocusStore((s) => s.locked);
  const error = useFocusStore((s) => s.error);
  const start = useFocusStore((s) => s.start);

  const active = isActive(timer);
  const clock = active ? formatClock(remainingMs(timer, now)) : "";

  // The window title follows the countdown: the title bar is overlay +
  // hiddenTitle and invisible most of the time, but the scheduler center and
  // the window menu read NSWindow.title, so during a focus session the
  // remaining time is visible at a glance. It doubles as an external
  // observation point: whether the countdown is really running, without
  // guessing from the status bar.
  useEffect(() => {
    const title = active ? `bnote · 专注 ${clock}` : "bnote";
    try {
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => {});
    } catch {
      // The browser harness has no Tauri window.
    }
  }, [active, clock]);

  return (
    <div className="focus-chip-wrap">
      {active ? (
        <button
          type="button"
          className={`focus-chip running${locked ? " locked" : ""}`}
          disabled
          title="专注进行中:这一段走完才会解锁"
        >
          <span className="focus-lock" aria-hidden="true">
            🔒
          </span>
          <span className="focus-label">专注中</span>
          <span className="focus-time">{clock}</span>
        </button>
      ) : (
        timer.config.focusDurations.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className={`focus-chip${locked ? " locked" : ""}`}
            title={
              error
                ? `上一次没有开始:${error}`
                : `开始 ${minutes} 分钟专注:独占屏幕 + 硬锁,开始后不能中途退出`
            }
            onClick={() => void start(minutes)}
          >
            <span className="focus-time">{formatClock(minutes * 60_000)}</span>
          </button>
        ))
      )}
    </div>
  );
}

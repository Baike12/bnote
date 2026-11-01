import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useFocusStore } from "@/focus/store";
import { formatClock, isActive, remainingMs } from "@/focus/timer";

/**
 * 状态栏左端的专注芯片。
 *
 * 只有一件事:**点一下开始一段专注**。开始后芯片就变成纯状态显示并禁用
 * ——这一段没有暂停、没有提前结束、没有退出独占的入口(唯一释放锁的路径
 * 是计时走完)。锁的配置也不在这里:长度在设置页,两把锁固定全开。
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

  // 窗口标题跟着倒计时走:标题栏是 overlay + hiddenTitle,平时看不见,但调度
  // 中心、窗口菜单读的是 NSWindow.title——专注时一眼能看见剩多久。顺带它也是
  // 一个外部可观测点:倒计时到底在不在走,不用盯着状态栏猜。
  useEffect(() => {
    const title = active ? `bnote · 专注 ${clock}` : "bnote";
    try {
      void getCurrentWindow().setTitle(title).catch(() => {});
    } catch {
      // 浏览器 harness 里没有 Tauri 窗口。
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

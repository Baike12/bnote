import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MinutesInput } from "./MinutesInput";
import { openAccessibilitySettings, useFocusStore } from "@/focus/store";
import { formatClock, isActive, isPaused, isRunning, remainingMs } from "@/focus/timer";

/**
 * 状态栏左端的专注芯片:番茄钟 + 独占锁的入口。
 *
 * 只显示「还剩多少」和一个能点开的收起面板——状态栏只有 26px 高,放不下
 * 一整套控制。真正的控制在面板里。
 *
 * 芯片是专注锁唯一的常驻出口:进锁后原生装饰(红绿灯)被摘掉,窗口铺满屏幕,
 * 状态栏是屏幕上唯一能点的东西,所以「退出独占」必须一直在这儿。
 */
export function FocusChip() {
  const timer = useFocusStore((s) => s.timer);
  const now = useFocusStore((s) => s.now);
  const locked = useFocusStore((s) => s.locked);
  const hardLock = useFocusStore((s) => s.hardLock);
  const hardActive = useFocusStore((s) => s.hardActive);
  const pendingHardLock = useFocusStore((s) => s.pendingHardLock);
  const trusted = useFocusStore((s) => s.trusted);
  const swallowed = useFocusStore((s) => s.swallowed);
  const error = useFocusStore((s) => s.error);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const running = isRunning(timer);
  const paused = isPaused(timer);
  const active = isActive(timer);
  const label = active ? "专注" : "番茄钟";
  const clock =
    running || paused
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

  // 点外面 / Esc 收起面板(捕获阶段,面板先消失,点击落到下面的元素上)。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const start = useFocusStore((s) => s.start);
  const pause = useFocusStore((s) => s.pause);
  const stop = useFocusStore((s) => s.stop);
  const setDurations = useFocusStore((s) => s.setDurations);
  const toggleLock = useFocusStore((s) => s.toggleLock);
  const setHardLock = useFocusStore((s) => s.setHardLock);

  return (
    <div className="focus-chip-wrap" ref={rootRef}>
      <button
        className={`focus-chip${locked ? " locked" : ""}${running ? " running" : ""}`}
        title={
          locked
            ? "专注模式:屏幕上只有 bnote,切不到别的应用(点开可退出)"
            : running
              ? "番茄钟在走(点开可暂停)"
              : "番茄钟:点开开始一段专注"
        }
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {locked && <span className="focus-lock" aria-hidden="true">🔒</span>}
        <span className="focus-label">{label}</span>
        <span className="focus-time">{clock}</span>
        {paused && <span className="focus-paused">已暂停</span>}
      </button>

      {open && (
        <div className="focus-pop" role="dialog" aria-label="专注计时">
          <div className="focus-pop-head">
            <span>{active ? "本次专注" : "番茄钟"}</span>
            <span className="focus-pop-clock">{clock}</span>
          </div>

          <div className="focus-pop-row">
            {running ? (
              <button className="btn" onClick={pause}>暂停</button>
            ) : (
              <button className="btn" onClick={start}>{paused ? "继续" : "开始专注"}</button>
            )}
            {active && <button className="btn" onClick={stop}>结束</button>}
          </div>

          <div className="focus-pop-row focus-durations">
            <label>
              时长
              <MinutesInput
                value={timer.config.focusMinutes}
                onChange={(n) => setDurations({ focusMinutes: n })}
              />
              分
            </label>
            <span className="focus-pop-note">改时长只影响下一段</span>
          </div>

          <div className="focus-pop-row">
            <button className={`btn${locked ? " on" : ""}`} onClick={() => void toggleLock()}>
              {locked ? "退出独占" : "独占屏幕"}
            </button>
            {/* 一段专注进行中,锁的配置就封存了:中途换掉这一段的承诺没有意义,
                也会让人一边计时一边惦记着调开关。界面上禁用,store 里再拦一道。
                不禁用权限缺失的情况:那要能弹出系统授权提示。 */}
            <button
              className={`btn${hardLock || pendingHardLock ? " on" : ""}`}
              disabled={active}
              title={
                active
                  ? "本次专注进行中:锁的配置结束后才能调整"
                  : pendingHardLock
                    ? "已请求辅助功能权限:在系统设置里允许后自动打开"
                    : trusted
                      ? hardLock
                        ? "硬锁已武装:下一次专注期间吞掉 ⌘Tab / ⌘Space,不专注时照常可切"
                        : "硬锁:只在一段专注跑着的时候吞掉 ⌘Tab / ⌘Space"
                      : "硬锁需要辅助功能权限:点一下会弹出系统的授权提示"
              }
              onClick={() => void setHardLock(!(hardLock || pendingHardLock))}
            >
              硬锁{pendingHardLock ? "…" : hardActive ? "·拦截中" : hardLock ? "·待命" : "关"}
              {hardActive && <span className="focus-pop-count">已拦 {swallowed}</span>}
            </button>
          </div>

          {active && (
            <div className="focus-pop-seal">
              🔒 锁已封存 · 本次专注结束后才能调整
              {hardActive && " · ⌘Tab 已被拦"}
            </div>
          )}

          {pendingHardLock && (
            <div className="focus-pop-hint">
              已请求辅助功能权限:在系统设置里允许后自动打开:
              <button className="link-btn" onClick={() => void openAccessibilitySettings()}>
                去授权
              </button>
            </div>
          )}

          {!trusted && !pendingHardLock && !active && (
            <div className="focus-pop-hint">
              硬锁要辅助功能权限(系统会弹授权框,允许后自动打开):
              <button className="link-btn" onClick={() => void openAccessibilitySettings()}>
                去授权
              </button>
            </div>
          )}

          {error && !pendingHardLock && <div className="focus-pop-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

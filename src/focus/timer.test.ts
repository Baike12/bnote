import { describe, expect, it } from "vitest";
import {
  createTimerState,
  formatClock,
  isActive,
  isExpired,
  isRunning,
  normalizeConfig,
  remainingMs,
  startTimer,
  stopTimer,
} from "./timer";

/**
 * One pomodoro = one continuous stretch of focus: no break phase, no automatic
 * continuation into the next stretch. These cases lock exactly that model - anyone
 * who brings a "break" back later gets a red test.
 */
const T0 = 1_700_000_000_000;

function session(focusMinutes = 25) {
  return createTimerState({ focusMinutes });
}

describe("番茄钟:一段连续的专注", () => {
  it("开始后进入专注,结束时间是 now + 时长", () => {
    const s = startTimer(session(25), T0);
    expect(s.phase).toBe("focus");
    expect(s.endsAt).toBe(T0 + 25 * 60_000);
    expect(isRunning(s)).toBe(true);
    expect(isActive(s)).toBe(true);
  });

  it("重复开始是空操作,不会把进度重置成满格", () => {
    const once = startTimer(session(), T0);
    const twice = startTimer(once, T0 + 60_000);
    expect(twice.endsAt).toBe(once.endsAt);
  });

  it("到点即结束:回到空闲,没有休息段、没有下一段", () => {
    const started = startTimer(session(25), T0);
    const end = started.endsAt!;
    expect(isExpired(started, end - 1)).toBe(false);
    expect(isExpired(started, end)).toBe(true);
    const stopped = stopTimer(started);
    expect(stopped.phase).toBe("idle");
    expect(stopped.endsAt).toBeNull();
    expect(isRunning(stopped)).toBe(false);
  });

  it("没有暂停:计时一旦开始,endAt 就不会被改掉", () => {
    const started = startTimer(session(25), T0);
    // Calling start again is an idempotent no-op - there is no path that freezes
    // the remaining time and resumes it later.
    expect(startTimer(started, T0 + 5 * 60_000)).toBe(started);
    expect(started.endsAt).toBe(T0 + 25 * 60_000);
  });

  it("收尾回到空闲(没有「跳去休息段」这种事)", () => {
    const started = startTimer(session(), T0);
    const stopped = stopTimer(started);
    expect(stopped.phase).toBe("idle");
    expect(remainingMs(stopped, T0)).toBe(0);
  });

  it("剩余时间由 endsAt - now 现算,不攒 tick 误差", () => {
    const started = startTimer(session(25), T0);
    expect(remainingMs(started, T0)).toBe(25 * 60_000);
    expect(remainingMs(started, T0 + 90_500)).toBe(25 * 60_000 - 90_500);
    // Look again after an hour of suspension: what is left is what is left, it
    // does not drift because of "how many ticks were missed".
    expect(remainingMs(started, T0 + 3_600_000)).toBe(0);
  });
});

describe("时长配置", () => {
  it("取整并夹到至少 1 分钟", () => {
    expect(normalizeConfig({ focusMinutes: 25.9 }).focusMinutes).toBe(25);
    expect(normalizeConfig({ focusMinutes: 0 }).focusMinutes).toBe(1);
    expect(normalizeConfig({ focusMinutes: -5 }).focusMinutes).toBe(1);
    expect(normalizeConfig({ focusMinutes: Number.NaN }).focusMinutes).toBe(25);
  });

  it("旧配置里的 breakMinutes / cycle 不会把时长清掉", () => {
    const legacy = { focusMinutes: 40, breakMinutes: 5, cycle: 3 } as unknown as {
      focusMinutes: number;
    };
    expect(normalizeConfig(legacy).focusMinutes).toBe(40);
  });

  it("没有配置时用默认 25 分钟", () => {
    expect(createTimerState().config.focusMinutes).toBe(25);
    expect(createTimerState().phase).toBe("idle");
  });

  it("空闲时剩余时间是 0", () => {
    expect(remainingMs(session(), T0)).toBe(0);
  });
});

describe("时钟格式", () => {
  it("mm:ss,超过一小时带小时", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65_000)).toBe("01:05");
    expect(formatClock(25 * 60_000)).toBe("25:00");
    expect(formatClock(-1000)).toBe("00:00");
    expect(formatClock(3_600_000 + 61_000)).toBe("1:01:01");
  });
});

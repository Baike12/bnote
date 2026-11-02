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

describe("pomodoro: one continuous stretch of focus", () => {
  it("after the start it enters focus, the end time is now + duration", () => {
    const s = startTimer(session(25), T0);
    expect(s.phase).toBe("focus");
    expect(s.endsAt).toBe(T0 + 25 * 60_000);
    expect(isRunning(s)).toBe(true);
    expect(isActive(s)).toBe(true);
  });

  it("starting again is a no-op, it does not reset the progress to full", () => {
    const once = startTimer(session(), T0);
    const twice = startTimer(once, T0 + 60_000);
    expect(twice.endsAt).toBe(once.endsAt);
  });

  it("it ends at the deadline: back to idle, no break phase, no next stretch", () => {
    const started = startTimer(session(25), T0);
    const end = started.endsAt!;
    expect(isExpired(started, end - 1)).toBe(false);
    expect(isExpired(started, end)).toBe(true);
    const stopped = stopTimer(started);
    expect(stopped.phase).toBe("idle");
    expect(stopped.endsAt).toBeNull();
    expect(isRunning(stopped)).toBe(false);
  });

  it("no pause: once the timer starts, endAt is never changed", () => {
    const started = startTimer(session(25), T0);
    // Calling start again is an idempotent no-op - there is no path that freezes
    // the remaining time and resumes it later.
    expect(startTimer(started, T0 + 5 * 60_000)).toBe(started);
    expect(started.endsAt).toBe(T0 + 25 * 60_000);
  });

  it("finishing returns to idle (there is no such thing as jumping to a rest segment)", () => {
    const started = startTimer(session(), T0);
    const stopped = stopTimer(started);
    expect(stopped.phase).toBe("idle");
    expect(remainingMs(stopped, T0)).toBe(0);
  });

  it("the remaining time is computed from endsAt - now, it accumulates no tick drift", () => {
    const started = startTimer(session(25), T0);
    expect(remainingMs(started, T0)).toBe(25 * 60_000);
    expect(remainingMs(started, T0 + 90_500)).toBe(25 * 60_000 - 90_500);
    // Look again after an hour of suspension: what is left is what is left, it
    // does not drift because of "how many ticks were missed".
    expect(remainingMs(started, T0 + 3_600_000)).toBe(0);
  });
});

describe("duration configuration", () => {
  it("rounded and clamped to at least 1 minute", () => {
    expect(normalizeConfig({ focusMinutes: 25.9 }).focusMinutes).toBe(25);
    expect(normalizeConfig({ focusMinutes: 0 }).focusMinutes).toBe(1);
    expect(normalizeConfig({ focusMinutes: -5 }).focusMinutes).toBe(1);
    expect(normalizeConfig({ focusMinutes: Number.NaN }).focusMinutes).toBe(25);
  });

  it("breakMinutes / cycle in the old config do not clear the duration", () => {
    const legacy = { focusMinutes: 40, breakMinutes: 5, cycle: 3 } as unknown as {
      focusMinutes: number;
    };
    expect(normalizeConfig(legacy).focusMinutes).toBe(40);
  });

  it("without a config the default is 25 minutes", () => {
    expect(createTimerState().config.focusMinutes).toBe(25);
    expect(createTimerState().phase).toBe("idle");
  });

  it("the remaining time is 0 while idle", () => {
    expect(remainingMs(session(), T0)).toBe(0);
  });
});

describe("clock format", () => {
  it("mm:ss, with hours once past one hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65_000)).toBe("01:05");
    expect(formatClock(25 * 60_000)).toBe("25:00");
    expect(formatClock(-1000)).toBe("00:00");
    expect(formatClock(3_600_000 + 61_000)).toBe("1:01:01");
  });
});

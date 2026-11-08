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
  startTimerUntil,
  stopTimer,
} from "./timer";

/**
 * One pomodoro = one continuous stretch of focus: no break phase, no automatic
 * continuation into the next stretch. These cases lock exactly that model - anyone
 * who brings a "break" back later gets a red test.
 */
const T0 = 1_700_000_000_000;

function session(focusMinutes = 25) {
  return createTimerState({ focusDurations: [focusMinutes] });
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
  it("each entry is rounded and clamped to at least 1 minute", () => {
    expect(normalizeConfig({ focusDurations: [25.9] }).focusDurations).toEqual([25]);
    expect(normalizeConfig({ focusDurations: [0, -5] }).focusDurations).toEqual([1]);
    expect(normalizeConfig({ focusDurations: [Number.NaN] }).focusDurations).toEqual([25]);
  });

  it("the list keeps the user's order, drops duplicates and caps at three", () => {
    expect(normalizeConfig({ focusDurations: [50, 25] }).focusDurations).toEqual([50, 25]);
    expect(normalizeConfig({ focusDurations: [25, 25, 50] }).focusDurations).toEqual([25, 50]);
    expect(normalizeConfig({ focusDurations: [10, 20, 30, 40] }).focusDurations).toEqual([
      10, 20, 30,
    ]);
  });

  it("a config from before the list keeps its single duration", () => {
    expect(normalizeConfig({ focusMinutes: 40 }).focusDurations).toEqual([40]);
    // breakMinutes / cycle of a much older config do not clear the duration
    const legacy = { focusMinutes: 40, breakMinutes: 5, cycle: 3 } as unknown as {
      focusMinutes?: unknown;
    };
    expect(normalizeConfig(legacy).focusDurations).toEqual([40]);
  });

  it("an empty or unreadable list falls back on 25 minutes", () => {
    expect(createTimerState().config.focusDurations).toEqual([25]);
    expect(normalizeConfig({ focusDurations: [] }).focusDurations).toEqual([25]);
    expect(normalizeConfig(null).focusDurations).toEqual([25]);
    expect(createTimerState().phase).toBe("idle");
  });

  it("the remaining time is 0 while idle", () => {
    expect(remainingMs(session(), T0)).toBe(0);
  });
});

describe("the length of the stretch comes from the clicked duration", () => {
  it("without an explicit duration the first configured one is used", () => {
    const state = createTimerState({ focusDurations: [50, 25] });
    expect(startTimer(state, T0).endsAt).toBe(T0 + 50 * 60_000);
  });

  it("a duration passed to start wins over the list", () => {
    const state = createTimerState({ focusDurations: [50, 90] });
    expect(startTimer(state, T0, 90).endsAt).toBe(T0 + 90 * 60_000);
    // The list itself is untouched: it only describes what the chips offer.
    expect(startTimer(state, T0, 90).config.focusDurations).toEqual([50, 90]);
  });

  it("editing the list does not move a running stretch", () => {
    const running = startTimer(createTimerState({ focusDurations: [25] }), T0);
    const renamed = normalizeConfig({ focusDurations: [90, 45] });
    expect(running.endsAt).toBe(T0 + 25 * 60_000);
    expect(remainingMs(running, T0 + 60_000)).toBe(24 * 60_000);
    expect(renamed.focusDurations).toEqual([90, 45]);
  });
});

describe("a scheduled stretch ends on its own deadline", () => {
  const deadline = T0 + 50 * 60_000;

  it("takes the absolute end instead of now + a duration", () => {
    const state = startTimerUntil(session(), T0 + 7 * 60_000, deadline);
    expect(state.phase).toBe("focus");
    expect(state.endsAt).toBe(deadline);
    expect(remainingMs(state, T0 + 7 * 60_000)).toBe(43 * 60_000);
  });

  it("does not start a window that is already over, and never resets a running one", () => {
    expect(startTimerUntil(session(), deadline, deadline)).toEqual(session());
    expect(startTimerUntil(session(), deadline + 1, deadline).endsAt).toBeNull();
    const running = startTimer(session(25), T0);
    expect(startTimerUntil(running, T0, deadline)).toBe(running);
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

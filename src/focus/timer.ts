/**
 * Pure logic of the pomodoro timer: state machine plus time computation.
 *
 * One pomodoro = **one continuous stretch of focus**: there is no break phase, it
 * stops when the time is up and never continues into the next stretch by itself.
 * There is **no pause** either: once it started, the stretch has to run to the end -
 * pausing would split the lock from the timing, and the lock is part of that promise
 * (see focus/store.ts). So there are only two states, idle and focus.
 *
 * The time is a **timestamp**, not a "minus one every second" accumulator: the
 * remaining time is always computed as `endsAt - now`. An accumulator piles up the
 * error of every tick (busy system, throttled tab, wake from sleep) and the
 * displayed time no longer matches the real time; it also cannot prove itself
 * after the system clock was changed. Here we only store "when this stretch ends",
 * and the display, the timeout check and the restore across a restart are all
 * derived from it.
 *
 * Pure functions, no Date.now hidden inside - `now` is always passed in by the
 * caller, so tests can pin the time (see timer.test.ts).
 */

export type TimerPhase = "idle" | "focus";

export interface TimerConfig {
  /** How long one focus stretch lasts (minutes). */
  focusMinutes: number;
}

export interface TimerState {
  phase: TimerPhase;
  /** End timestamp of this stretch (epoch ms); null while idle. */
  endsAt: number | null;
  config: TimerConfig;
}

export const DEFAULT_TIMER_CONFIG: TimerConfig = { focusMinutes: 25 };

/** Lower bound of the duration: 0 minutes would end the stretch instantly, the timer would only flash once. */
const MIN_MINUTES = 1;

export function createTimerState(config?: Partial<TimerConfig> | null): TimerState {
  return {
    phase: "idle",
    endsAt: null,
    config: normalizeConfig(config),
  };
}

/**
 * Round the duration and clamp it into the legal range (0, a negative number and
 * NaN all count as 1 minute).
 *
 * A missing field is allowed: older configs still carry `breakMinutes` and
 * `cycle`, the extra keys are simply ignored when they are read back, and the
 * duration of the user must not be zeroed because the fields changed.
 */
export function normalizeConfig(config?: Partial<TimerConfig> | null): TimerConfig {
  const raw = config?.focusMinutes;
  // Missing field or NaN (the input box was cleared): use the default, do not
  // zero out the setting of the user.
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { focusMinutes: DEFAULT_TIMER_CONFIG.focusMinutes };
  }
  // A small value the user entered on purpose (0, a negative number) is clamped to
  // 1 minute: at least the timing is visibly running.
  return { focusMinutes: Math.max(MIN_MINUTES, Math.floor(raw)) };
}

/** Length of one focus stretch (milliseconds). */
export function focusDurationMs(state: TimerState): number {
  return state.config.focusMinutes * 60_000;
}

export function isRunning(state: TimerState): boolean {
  return state.endsAt !== null;
}

/** Whether a focus stretch is running. */
export function isActive(state: TimerState): boolean {
  return state.phase === "focus";
}

/**
 * Start the timer. Starting while it already runs is a no-op (idempotent): pressing
 * start again does not reset the elapsed progress to full.
 */
export function startTimer(state: TimerState, now: number): TimerState {
  if (state.endsAt !== null) return state;
  return {
    ...state,
    phase: "focus",
    endsAt: now + focusDurationMs(state),
  };
}

/** Stop and reset: back to idle. A pomodoro has only one ending, "it ran out". */
export function stopTimer(state: TimerState): TimerState {
  return { ...state, phase: "idle", endsAt: null };
}

/** Remaining milliseconds; 0 while idle. */
export function remainingMs(state: TimerState, now: number): number {
  if (state.endsAt === null) return 0;
  return Math.max(0, state.endsAt - now);
}

/** Whether this stretch has reached its end. */
export function isExpired(state: TimerState, now: number): boolean {
  return state.endsAt !== null && now >= state.endsAt;
}

/** mm:ss (h:mm:ss beyond one hour). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

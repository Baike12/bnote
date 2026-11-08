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
  /**
   * The durations the status bar offers, in minutes: one to three entries, in
   * the user's order. A running stretch fixed its own length when it started
   * (`endsAt`), so editing this list never touches it.
   */
  focusDurations: number[];
}

/** How many durations the status bar can offer. */
export const MAX_FOCUS_DURATIONS = 3;

const DEFAULT_MINUTES = 25;

export interface TimerState {
  phase: TimerPhase;
  /** End timestamp of this stretch (epoch ms); null while idle. */
  endsAt: number | null;
  config: TimerConfig;
}

/** Lower bound of the duration: 0 minutes would end the stretch instantly, the timer would only flash once. */
const MIN_MINUTES = 1;

export function createTimerState(config?: Partial<TimerConfig> | null): TimerState {
  return {
    phase: "idle",
    endsAt: null,
    config: normalizeConfig(config),
  };
}

/** One legal duration, or null when the value cannot be read as minutes. */
function parseMinutes(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  // A small value the user entered on purpose (0, a negative number) is clamped to
  // 1 minute: at least the timing is visibly running.
  return Math.max(MIN_MINUTES, Math.floor(raw));
}

/**
 * Normalize the duration list: unreadable entries and duplicates are dropped,
 * the user's order is kept, the list is capped at [`MAX_FOCUS_DURATIONS`], and a
 * config from before the list existed keeps its single `focusMinutes`
 * (`breakMinutes` / `cycle` of a much older config are simply ignored).
 */
export function normalizeConfig(
  config?: { focusDurations?: unknown; focusMinutes?: unknown } | null,
): TimerConfig {
  const list: number[] = [];
  const raw = config?.focusDurations;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const minutes = parseMinutes(entry);
      if (minutes === null || list.includes(minutes)) continue;
      list.push(minutes);
      if (list.length === MAX_FOCUS_DURATIONS) break;
    }
  }
  // An empty list would leave the status bar without any way to start a stretch.
  if (list.length > 0) return { focusDurations: list };
  return { focusDurations: [parseMinutes(config?.focusMinutes) ?? DEFAULT_MINUTES] };
}

export function isRunning(state: TimerState): boolean {
  return state.endsAt !== null;
}

/** Whether a focus stretch is running. */
export function isActive(state: TimerState): boolean {
  return state.phase === "focus";
}

/**
 * Start the timer at one of the configured durations; without an explicit
 * duration the first one is used (that is the keyboard command's path). Starting
 * while it already runs is a no-op (idempotent): pressing start again does not
 * reset the elapsed progress to full.
 */
export function startTimer(state: TimerState, now: number, minutes?: number): TimerState {
  if (state.endsAt !== null) return state;
  const chosen = parseMinutes(minutes) ?? state.config.focusDurations[0] ?? DEFAULT_MINUTES;
  return {
    ...state,
    phase: "focus",
    endsAt: now + chosen * 60_000,
  };
}

/** Stop and reset: back to idle. A pomodoro has only one ending, "it ran out". */
export function stopTimer(state: TimerState): TimerState {
  return { ...state, phase: "idle", endsAt: null };
}

/**
 * Start a stretch that must end at an absolute timestamp. The scheduled blocks
 * use it so a start that was observed a few seconds late still ends at :50
 * instead of pushing the whole block; a window that is already over starts
 * nothing (the idle state comes back unchanged).
 */
export function startTimerUntil(state: TimerState, now: number, endsAt: number): TimerState {
  if (state.endsAt !== null) return state;
  if (!Number.isFinite(endsAt) || endsAt <= now) return state;
  return { ...state, phase: "focus", endsAt };
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

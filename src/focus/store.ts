/**
 * State store of the focus mode: pomodoro timer plus pseudo fullscreen lock plus
 * hard lock.
 *
 * **Single writer**: only this module changes the timer state. The command
 * palette, the key bindings, the chip in the status bar and the settings page all
 * call the actions here instead of writing on their own - two writers would fight
 * each other and the last write would win.
 *
 * One pomodoro is **one continuous stretch of focus**: no break phase, it ends
 * when the time is up and never continues into the next stretch by itself. Time
 * and display are always computed from `endsAt` (see timer.ts), never by "minus one
 * every second".
 *
 * **Starting is a promise**: pressing start takes effect as "own the screen + hard
 * lock + timing" all at once, and there is no way out in between - no pause, no
 * early end, no unlock command. The only path that releases the locks is the
 * stretch running out (the expired branch of `applyTimer`). The hard lock has to
 * be armed successfully before the stretch starts: a stretch that started but
 * cannot block ⌘Tab would be a lie to oneself. Without the accessibility
 * permission the stretch does not start and the user is pointed at the system
 * settings.
 *
 * It also survives a restart: the timer state (endsAt) is persisted and on
 * restart `restore` picks the stretch and both locks back up - quitting the app
 * does not end the stretch.
 */

import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { focusApi } from "@/lib/tauri";
import { getConfigSnapshot, persistConfig, useAppStore } from "@/state/appStore";
import {
  createTimerState,
  isActive,
  isExpired,
  isRunning,
  normalizeConfig,
  startTimer,
  stopTimer,
  type TimerConfig,
  type TimerState,
} from "./timer";

export interface FocusStore {
  timer: TimerState;
  /** Moment of the last tick - the display uses it to show the remaining time instead of taking Date.now itself. */
  now: number;
  /** Whether the pseudo fullscreen lock is on (the native side is the truth here). */
  locked: boolean;
  /** Whether the hard lock is armed (the tap is in place and will really intercept during the focus stretch). */
  hardLock: boolean;
  /** Whether the hard lock is **actually intercepting**: only true while a pomodoro is running. */
  hardActive: boolean;
  /** The hard lock was requested but the accessibility permission is missing. */
  pendingHardLock: boolean;
  /** Whether the accessibility permission was granted (the precondition of the hard lock). */
  trusted: boolean;
  /** Number of key events the tap of the hard lock has seen - only a value above 0 proves that the tap is alive. */
  seen: number;
  /** Number of key events the hard lock swallowed. */
  swallowed: number;
  /** Error of the most recent native call, shown as a hint on the settings page. */
  error: string | null;

  /**
   * Start a focus stretch: arm the hard lock first, then start the timer, then
   * take the screen lock. Without the permission or when the screen lock fails the
   * stretch does not start, so there is never a half state where the timer runs
   * but the lock is not on.
   */
  start: () => Promise<void>;
  setDurations: (patch: Partial<TimerConfig>) => void;
  /** Reconcile the clock after the window came back to the foreground or the system woke up: finish the stretch when it is due, otherwise pull the display up to the present. */
  syncNow: () => void;
  /** Re-read the native lock state and reconcile it with the current timer (on startup, when the settings page opens, when the window returns to the foreground). */
  refreshStatus: () => Promise<void>;
  /** Restore the timer state from the config on startup; when it is still running, reconnect both locks. */
  restore: (timer: TimerState | undefined) => Promise<void>;
}

/** Deep link into the system settings page for the accessibility permission (the hard lock needs it). */
export const ACCESSIBILITY_PANEL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/** Open the accessibility page of the system settings. */
export async function openAccessibilitySettings(): Promise<void> {
  try {
    await openUrl(ACCESSIBILITY_PANEL);
  } catch {
    useAppStore
      .getState()
      .showToast("打不开系统设置,请手动前往「系统设置 → 隐私与安全性 → 辅助功能」");
  }
}

/** Interval of the tick. Half a second, so the second in which the time is up does not read as a whole stuck second. */
const TICK_MS = 500;

let tickHandle: ReturnType<typeof setTimeout> | null = null;

/** start is arming and locking: two quick presses must not open the native lock twice concurrently. */
let starting = false;

/**
 * Bumped on every timer transition. Async reconciliations capture it before
 * awaiting and drop their snapshot when it moved: a status read that started
 * before a start/end must not write the old lock flags back.
 */
let revision = 0;

function stopTicking() {
  if (tickHandle === null) return;
  clearTimeout(tickHandle);
  tickHandle = null;
}

/**
 * The next tick.
 *
 * A **self-rescheduling setTimeout chain** instead of setInterval: after the window
 * was occluded, the system slept or the WebView was throttled, a compensating
 * burst only crowds a series of stale ticks together; the chain schedules the next
 * tick from "now" every time and computes with `Date.now()` on every tick - no
 * matter how long it was suspended in between, the displayed time stays correct
 * and never drifts slower and slower.
 */
function tickOnce() {
  tickHandle = null;
  const state = useFocusStore.getState();
  const now = Date.now();
  if (isExpired(state.timer, now)) {
    // Time is up: the stretch ends (it does not continue into the next one), the
    // coupling logic releases both locks.
    void applyTimer(stopTimer(state.timer));
    return;
  }
  useFocusStore.setState({ now });
  ensureTicking();
}

function ensureTicking() {
  if (tickHandle !== null) return;
  tickHandle = setTimeout(tickOnce, TICK_MS);
}

/** Persist the timer state: it keeps running across a restart (endsAt is an absolute time, so it is still judged expired after the restart). */
function persistTimer(timer: TimerState) {
  persistConfig({ ...getConfigSnapshot(), focusTimer: timer });
}

/** Arm the hard lock. Without the permission it records "waiting for the grant" and shows a hint, and the stretch does not start. */
async function armHardLock(): Promise<boolean> {
  try {
    const status = await focusApi.setHardLock(true);
    useFocusStore.setState({
      hardLock: status.hard_lock,
      pendingHardLock: false,
      trusted: status.trusted,
      seen: status.seen,
      swallowed: status.swallowed,
      error: null,
    });
    return status.hard_lock;
  } catch (e) {
    const message = String(e);
    const needsAccess = message.includes("NEEDS_ACCESSIBILITY");
    useFocusStore.setState({
      hardLock: false,
      pendingHardLock: needsAccess,
      trusted: needsAccess ? false : useFocusStore.getState().trusted,
      error: message,
    });
    useAppStore
      .getState()
      .showToast(
        needsAccess
          ? "硬锁需要辅助功能权限:允许后才能开始专注(设置 → 专注里有授权入口)"
          : message,
      );
    return false;
  }
}

/** Take the exclusive screen lock. Returns false on failure and the caller decides not to start the stretch. */
async function lockNow(): Promise<boolean> {
  try {
    const status = await focusApi.lock();
    useFocusStore.setState({ locked: status.locked, error: null });
    return status.locked;
  } catch (e) {
    const message = String(e);
    useFocusStore.setState({ error: message });
    useAppStore.getState().showToast(`进不了独占屏幕:${message}`);
    return false;
  }
}

/**
 * Release the exclusive screen lock.
 *
 * Unconditional and idempotent: the native window is the truth, and the
 * `locked` flag here can be stale (a reconciliation may have cleared it). A
 * skipped native call would leave the window above every other app forever.
 */
async function unlockNow(): Promise<void> {
  try {
    const status = await focusApi.unlock();
    useFocusStore.setState({ locked: status.locked, error: null });
  } catch (e) {
    useFocusStore.setState({ error: String(e) });
  }
}

/**
 * Switch the real interception by the session state: it only intercepts while
 * **a focus stretch is running**.
 *
 * When the time is up the hard lock is withdrawn first and the screen lock is
 * released afterwards: while the hard lock intercepts there is no user action
 * called "unlock", and the other order would leave a window between the two
 * native calls that nobody is responsible for.
 */
async function syncHardActive(active: boolean): Promise<boolean> {
  const state = useFocusStore.getState();
  const want = active && state.hardLock;
  if (want === state.hardActive) return true;
  try {
    const status = await focusApi.setHardLockActive(want);
    useFocusStore.setState({
      hardActive: status.hard_active,
      seen: status.seen,
      swallowed: status.swallowed,
    });
    return status.hard_active === want;
  } catch {
    useFocusStore.setState({ hardActive: false });
    return !want;
  }
}

/**
 * Replace the timer state and handle the coupling with the locks.
 *
 * A stretch starts -> the hard lock starts intercepting; the stretch ends (it ran
 * out) -> stop intercepting first, then release the screen lock. The locks have no
 * "manual" source: they belong to the session alone, so there is no ownership
 * bookkeeping.
 */
async function applyTimer(next: TimerState): Promise<void> {
  const prev = useFocusStore.getState().timer;
  revision += 1;
  useFocusStore.setState({ timer: next, now: Date.now() });
  persistTimer(next);
  if (isRunning(next)) ensureTicking();
  else stopTicking();

  if (isActive(next)) {
    await syncHardActive(true);
  } else if (isActive(prev)) {
    await syncHardActive(false);
    await unlockNow();
  }
}

/**
 * Start a focus stretch. The hard lock comes first, then the timer, then the
 * screen lock; when taking the screen lock fails the stretch is taken back
 * immediately (this is the cleanup of a failed start, not an exit the user can
 * press).
 */
async function startFocus(): Promise<void> {
  const state = useFocusStore.getState();
  if (isActive(state.timer) || starting) return;
  starting = true;
  try {
    if (!(await armHardLock())) return;
    await applyTimer(startTimer(useFocusStore.getState().timer, Date.now()));
    // Armed successfully does not mean it really intercepts (creating the tap can
    // fail too): without interception the stretch does not start.
    if (!useFocusStore.getState().hardActive) {
      await applyTimer(stopTimer(useFocusStore.getState().timer));
      useAppStore
        .getState()
        .showToast("硬锁没有真正生效:本次专注没有开始(检查辅助功能权限)");
      return;
    }
    if (!(await lockNow())) {
      await applyTimer(stopTimer(useFocusStore.getState().timer));
    }
  } finally {
    starting = false;
  }
}

/** Fold the persisted old state into the current model: there is no pause and no break phase, a focus stretch without endsAt is void. */
function sanitize(timer: TimerState | undefined): TimerState {
  if (!timer) return createTimerState();
  const endsAt = timer.phase === "focus" && typeof timer.endsAt === "number" ? timer.endsAt : null;
  return {
    phase: endsAt !== null ? "focus" : "idle",
    endsAt,
    config: normalizeConfig(timer.config),
  };
}

export const useFocusStore = create<FocusStore>((set, get) => ({
  timer: createTimerState(),
  now: Date.now(),
  locked: false,
  hardLock: false,
  hardActive: false,
  pendingHardLock: false,
  trusted: false,
  seen: 0,
  swallowed: 0,
  error: null,

  start: () => startFocus(),

  setDurations: (patch) => {
    const timer = get().timer;
    const next = { ...timer, config: normalizeConfig({ ...timer.config, ...patch }) };
    // The running stretch is not affected: endsAt is already fixed, a new duration
    // only applies to the next stretch.
    revision += 1;
    set({ timer: next, now: Date.now() });
    persistTimer(next);
  },

  syncNow: () => {
    const timer = get().timer;
    if (timer.phase !== "focus") return;
    const now = Date.now();
    if (isExpired(timer, now)) {
      void applyTimer(stopTimer(timer));
      return;
    }
    set({ now });
    if (isRunning(timer)) ensureTicking();
  },

  refreshStatus: async () => {
    const rev = revision;
    try {
      const status = await focusApi.status();
      // The timer moved while the status was in flight: this snapshot describes
      // an older world and must not overwrite the current lock flags.
      if (rev !== revision) return;
      set({
        locked: status.locked,
        hardLock: status.hard_lock,
        hardActive: status.hard_active,
        trusted: status.trusted,
        seen: status.seen,
        swallowed: status.swallowed,
      });
      const timer = get().timer;
      const active = isActive(timer) && isRunning(timer);
      if (!isActive(timer)) {
        // Idle means the window must be unlocked. Always ask the native side:
        // `focus_unlock` is idempotent, and `locked` here can be stale (this is
        // exactly how the window could stay above every other app).
        await unlockNow();
        await syncHardActive(false);
        return;
      }
      if (!status.locked) {
        // A session is running but there is no lock: add it (early startup, the
        // native side lost its state).
        await lockNow();
      }
      if (!status.hard_lock) await armHardLock();
      await syncHardActive(active);
    } catch {
      // The browser harness has no native side: when the state cannot be read,
      // treat it as unlocked.
      set({ locked: false });
    }
  },

  restore: async (saved) => {
    const next = sanitize(saved);
    revision += 1;
    set({ timer: next, now: Date.now() });
    if (!isActive(next)) {
      await unlockNow();
      return;
    }
    if (!isRunning(next) || isExpired(next, Date.now())) {
      await applyTimer(stopTimer(next));
      return;
    }
    // The stretch was still running before the restart: the timing is picked up
    // and so are the locks (quitting the app does not end the promise).
    ensureTicking();
    if (!(await armHardLock())) {
      useAppStore.getState().showToast("硬锁未授权:本次专注只剩独占屏幕");
    }
    await lockNow();
    await syncHardActive(true);
  },
}));

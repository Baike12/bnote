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
 * **Scheduled blocks** (schedule.ts) enter through `startScheduled`, and the
 * scheduler is the only caller. A scheduled stretch names its absolute end, so a
 * tick that arrives a few seconds late still ends at :50 instead of shifting the
 * block.
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
  startTimerUntil,
  stopTimer,
  type TimerConfig,
  type TimerState,
} from "./timer";
import {
  addBlocks,
  emptySchedule,
  normalizeSchedule,
  type FocusSchedule,
  type GridCell,
} from "./schedule";

export interface FocusStore {
  timer: TimerState;
  /** The scheduled focus week: append-only, see schedule.ts. */
  schedule: FocusSchedule;
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
   *
   * `minutes` is the duration the user clicked in the status bar; omitting it
   * takes the first configured one (the keyboard command).
   */
  start: (minutes?: number) => Promise<void>;
  /** Start a stretch that ends at an absolute timestamp (a saved schedule block); the scheduler is the only caller. */
  startScheduled: (endsAt: number) => Promise<void>;
  /** Append the drafted blocks to the schedule and persist them; returns how many were new. There is no removal counterpart. */
  saveSchedule: (cells: readonly GridCell[]) => number;
  setDurations: (patch: Partial<TimerConfig>) => void;
  /** Reconcile the clock after the window came back to the foreground or the system woke up: finish the stretch when it is due, otherwise pull the display up to the present. */
  syncNow: () => void;
  /** Re-read the native lock state and reconcile it with the current timer (on startup, when the settings page opens, when the window returns to the foreground). */
  refreshStatus: () => Promise<void>;
  /** Restore the timer (and the append-only schedule) from the config on startup; when the timer is still running, reconnect both locks. */
  restore: (timer: TimerState | undefined, schedule?: unknown) => Promise<void>;
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

/**
 * A native unlock failed: the window may still be in the locked state (or hold
 * a half-restored geometry). Kept so the next status reconciliation retries
 * the release instead of trusting "not locked" and leaving the window there.
 */
let unlockPending = false;

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
        needsAccess ? "硬锁需要辅助功能权限:允许后才能开始专注(设置 → 专注里有授权入口)" : message,
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
    unlockPending = false;
    // The release must not touch `error`: a failed start rolls the timer back
    // and releases the lock right after lockNow failed - that release wiping
    // the error would erase the only evidence of why the start did not happen.
    useFocusStore.setState({ locked: status.locked });
  } catch (e) {
    unlockPending = true;
    // A release that failed leaves the window at level 25 above every other app
    // until it is retried, so it must reach the user instead of only sitting in
    // the store.
    const message = String(e);
    useFocusStore.setState({ error: message });
    useAppStore.getState().showToast(`独占屏幕没有解锁:${message}`);
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
    if (want && status.hard_active !== want) {
      useFocusStore.setState({ error: "硬锁拦截没有开启(状态与请求不符)" });
    }
    return status.hard_active === want;
  } catch (e) {
    useFocusStore.setState({ hardActive: false });
    // A failed start must leave its reason behind: the toast lives 2.6s, the
    // chip tooltip keeps `error` until the next attempt.
    if (want) useFocusStore.setState({ error: String(e) });
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
 *
 * `choose` decides the stretch (now + a duration, or an absolute end for a
 * scheduled block). A choice that yields no running timer means "there is
 * nothing to start" - the locks are not armed for it.
 */
async function startFocus(choose: (timer: TimerState, now: number) => TimerState): Promise<void> {
  const state = useFocusStore.getState();
  if (isActive(state.timer) || starting) return;
  if (!isActive(choose(state.timer, Date.now()))) return;
  starting = true;
  try {
    if (!(await armHardLock())) return;
    const next = choose(useFocusStore.getState().timer, Date.now());
    if (!isActive(next)) return;
    await applyTimer(next);
    // The window may have run out while the locks were being armed (a scheduled
    // block whose last seconds went by): nothing was taken, so nothing to undo.
    if (!isActive(useFocusStore.getState().timer)) return;
    // Armed successfully does not mean it really intercepts (creating the tap can
    // fail too): without interception the stretch does not start.
    if (!useFocusStore.getState().hardActive) {
      await applyTimer(stopTimer(useFocusStore.getState().timer));
      // The native reason wins; the fallback covers the "IPC answered but the
      // flag disagrees" case where the catch above did not run.
      const reason = useFocusStore.getState().error ?? "硬锁没有真正生效(检查辅助功能权限)";
      useFocusStore.setState({ error: reason });
      useAppStore.getState().showToast(`本次专注没有开始:${reason}`);
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
  schedule: emptySchedule(),
  now: Date.now(),
  locked: false,
  hardLock: false,
  hardActive: false,
  pendingHardLock: false,
  trusted: false,
  seen: 0,
  swallowed: 0,
  error: null,

  start: (minutes) => startFocus((timer, now) => startTimer(timer, now, minutes)),

  startScheduled: (endsAt) => startFocus((timer, now) => startTimerUntil(timer, now, endsAt)),

  saveSchedule: (cells) => {
    const { schedule, added } = addBlocks(get().schedule, cells);
    if (added === 0) return 0;
    set({ schedule });
    persistConfig({ ...getConfigSnapshot(), focusSchedule: schedule });
    return added;
  },

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
        // Idle means the window must be unlocked — but only when the native
        // window really is locked (a fresh read; the flag in this store can be
        // stale) or an earlier release failed. Asking again unconditionally
        // would re-run the whole restore (level + collection behavior +
        // responder) right after the session end already restored the window,
        // in the middle of the user's work: the end of a stretch must be
        // silent.
        if (status.locked || unlockPending) await unlockNow();
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

  restore: async (saved, savedSchedule) => {
    const next = sanitize(saved);
    revision += 1;
    set({ timer: next, now: Date.now(), schedule: normalizeSchedule(savedSchedule) });
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

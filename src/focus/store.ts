/**
 * 专注模式的状态仓库:番茄钟 + 伪全屏锁 + 硬锁。
 *
 * **单一写入者**:计时状态只有这里改。命令面板、快捷键、状态栏上的芯片、
 * 设置页全都调这里的动作,不各写各的——否则"暂停"和"重置"两路写者会打架,
 * 谁后写谁生效。
 *
 * 一次番茄钟是**一段连续的专注**:没有休息段,到点即结束,不自动接下一段。
 * 时间和显示都从 `endsAt` 现算(见 timer.ts),不做"每秒减一"。
 *
 * 锁有归属(`lockOwner`):计时器自动加的锁只由计时器自己解,用户手动加的锁
 * 用户自己解。反过来不成立——用户显式退出锁,一定放得开(哪怕计时器正持有
 * 这把锁)。
 */

import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { focusApi } from "@/lib/tauri";
import { getConfigSnapshot, persistConfig, useAppStore } from "@/state/appStore";
import {
  createTimerState,
  isExpired,
  isRunning,
  normalizeConfig,
  pauseTimer,
  startTimer,
  stopTimer,
  type TimerConfig,
  type TimerState,
} from "./timer";

/** 谁持有这把锁。计时器只解自己加的锁,用户手动解一切。 */
type LockOwner = "manual" | "timer" | null;

export interface FocusStore {
  timer: TimerState;
  /** 上一次 tick 的时刻——显示剩余时间用它,不用自己取 Date.now。 */
  now: number;
  /** 伪全屏锁是否开着(以原生侧状态为准)。 */
  locked: boolean;
  /** 硬锁是否武装(用户打开了开关,表示"专注期间吞系统级快捷键")。 */
  hardLock: boolean;
  /**
   * 硬锁是否**正在拦截**。只有一段番茄钟在跑的时候才为真——武装了但没在专注,
   * ⌘Tab 必须照常可用,否则打开硬锁就等于把自己锁在应用里。
   */
  hardActive: boolean;
  /**
   * 用户点了「开硬锁」但辅助功能权限还没给:等系统授权一到位就自动开。
   * 有了它,用户只需要在系统设置里点一次「允许」,不用再回来点第二次开关。
   */
  pendingHardLock: boolean;
  /** 辅助功能权限是否已授予(硬锁的前提)。 */
  trusted: boolean;
  /** 硬锁的 tap 见过的按键事件数——>0 才说明 tap 真的活着。 */
  seen: number;
  /** 硬锁吞掉的按键事件数。 */
  swallowed: number;
  /** 最近一次原生调用的错误,给设置页提示用。 */
  error: string | null;

  start: () => void;
  pause: () => void;
  stop: () => void;
  setDurations: (patch: Partial<TimerConfig>) => void;
  /** 窗口回到前台/系统唤醒后对一次表:到点就收尾,没到点就把显示拉到当下。 */
  syncNow: () => void;

  enterLock: () => Promise<void>;
  exitLock: () => Promise<void>;
  toggleLock: () => Promise<void>;
  setHardLock: (enabled: boolean) => Promise<void>;
  refreshStatus: () => Promise<void>;

  /** 启动时从配置里恢复计时状态(专注段可能还在跑)。 */
  restore: (timer: TimerState | undefined) => void;
}

/** 辅助功能权限页的系统设置深链(硬锁要它)。 */
export const ACCESSIBILITY_PANEL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/** 打开系统的辅助功能设置页。 */
export async function openAccessibilitySettings(): Promise<void> {
  try {
    await openUrl(ACCESSIBILITY_PANEL);
  } catch {
    useAppStore
      .getState()
      .showToast("打不开系统设置,请手动前往「系统设置 → 隐私与安全性 → 辅助功能」");
  }
}

/** tick 的间隔。半秒:到点的那一秒不至于显示成"卡住"的一整秒。 */
const TICK_MS = 500;

let tickHandle: ReturnType<typeof setTimeout> | null = null;
/** 锁的归属者(模块级:它是原生锁的伴生状态,不该进 React 树)。 */
let lockOwner: LockOwner = null;

function stopTicking() {
  if (tickHandle === null) return;
  clearTimeout(tickHandle);
  tickHandle = null;
}

/**
 * 下一拍。
 *
 * 用**自续的 setTimeout 链**而不是 setInterval:窗口被遮挡、系统睡眠、
 * WebView 节流之后,补偿性的连发只会把一串过期的拍子挤在一起;链式每次
 * 从"现在"重新排下一拍,并且在每一拍里用 `Date.now()` 现算——不管中间被
 * 挂起多久,显示的时间都不会错,也不会越走越慢。
 */
function tickOnce() {
  tickHandle = null;
  const state = useFocusStore.getState();
  const now = Date.now();
  if (isExpired(state.timer, now)) {
    // 到点:这一段结束(不自动接下一段),联动逻辑会把计时器加的锁退掉。
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

/** 计时状态落盘:跨重启还在跑(endsAt 是绝对时间,重启后照样判超时)。 */
function persistTimer(timer: TimerState) {
  persistConfig({ ...getConfigSnapshot(), focusTimer: timer });
}

/** 加锁。幂等:已经在锁里就不重复调原生。 */
async function lockNow(owner: Exclude<LockOwner, null>): Promise<void> {
  const state = useFocusStore.getState();
  if (state.locked) {
    // 已经在锁里。归属只往「手动」方向升:手动加的锁不能被计时器接管——
    // 否则离开专注段时,计时器会以为这把锁是自己的,把它解了。
    if (owner === "manual") lockOwner = "manual";
    return;
  }
  try {
    const status = await focusApi.lock();
    lockOwner = owner;
    useFocusStore.setState({ locked: status.locked, error: null });
  } catch (e) {
    useFocusStore.setState({ error: String(e) });
  }
}

/**
 * 解锁。
 *
 * `owner === "manual"` 是用户的显式退出:一定放得开,哪怕计时器正持有这把锁。
 * `owner === "timer"` 只在计时器自己加的锁上生效——不解除用户手动加的锁。
 */
async function unlockNow(owner: Exclude<LockOwner, null>): Promise<void> {
  const state = useFocusStore.getState();
  if (!state.locked) return;
  if (owner === "timer" && lockOwner !== "timer") return;
  try {
    const status = await focusApi.unlock();
    lockOwner = null;
    useFocusStore.setState({ locked: status.locked, error: null });
    // 用户显式退出独占 = 他要走了:硬锁的拦截同时撤掉,不能让人出不去。
    if (owner === "manual") await setHardActive(false);
  } catch (e) {
    useFocusStore.setState({ error: String(e) });
  }
}

/**
 * 换计时状态,并处理与锁的联动。
 *
 * 一段专注开始 → 自动进锁(设置里开着才自动);这一段结束(走完或提前结束)
 * → 自动退锁。联动的开关是 `settings.focusAutoLock`,关掉时锁完全归用户手动管。
 *
 * 硬锁同理:只有这一段在跑的时候才真正拦截(见 syncHardActive)。
 */
async function applyTimer(next: TimerState): Promise<void> {
  const prev = useFocusStore.getState().timer;
  useFocusStore.setState({ timer: next, now: Date.now() });
  persistTimer(next);
  if (isRunning(next)) ensureTicking();
  else stopTicking();

  const auto = useAppStore.getState().settings.focusAutoLock;
  if (auto) {
    if (prev.phase !== "focus" && next.phase === "focus") {
      await lockNow("timer");
    } else if (prev.phase === "focus" && next.phase !== "focus") {
      await unlockNow("timer");
    }
  }
  await syncHardActive(next);
}

/**
 * 按计时状态同步"真正拦截":只有**武装了 + 这一段正在跑**才拦。
 *
 * 暂停、结束、手动退出独占都立刻放开——否则人被锁在应用里出不去。
 */
async function syncHardActive(timer: TimerState): Promise<void> {
  const state = useFocusStore.getState();
  await setHardActive(state.hardLock && isRunning(timer));
}

/** 直接设定拦截开关。没权限时就是不拦,不当成错误打扰用户。 */
async function setHardActive(active: boolean): Promise<void> {
  if (active === useFocusStore.getState().hardActive) return;
  try {
    const status = await focusApi.setHardLockActive(active);
    useFocusStore.setState({
      hardActive: status.hard_active,
      seen: status.seen,
      swallowed: status.swallowed,
    });
  } catch {
    useFocusStore.setState({ hardActive: false });
  }
}

/** 把落盘的旧状态收敛成当前模型:"break" 是已删除的阶段,当空闲处理。 */
function sanitize(timer: TimerState): TimerState {
  const phase = timer.phase === "focus" ? "focus" : "idle";
  const endsAt = typeof timer.endsAt === "number" ? timer.endsAt : null;
  const pausedRemaining = typeof timer.pausedRemaining === "number" ? timer.pausedRemaining : null;
  return {
    phase,
    endsAt: phase === "focus" ? endsAt : null,
    pausedRemaining: phase === "focus" ? pausedRemaining : null,
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

  start: () => {
    void applyTimer(startTimer(get().timer, Date.now()));
  },
  pause: () => {
    void applyTimer(pauseTimer(get().timer, Date.now()));
  },
  stop: () => {
    void applyTimer(stopTimer(get().timer));
  },
  setDurations: (patch) => {
    const timer = get().timer;
    const config = normalizeConfig({ ...timer.config, ...patch });
    void applyTimer({ ...timer, config });
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

  enterLock: async () => {
    await lockNow("manual");
  },
  exitLock: async () => {
    await unlockNow("manual");
  },
  toggleLock: async () => {
    if (get().locked) await unlockNow("manual");
    else await lockNow("manual");
  },
  setHardLock: async (enabled) => {
    const state = get();
    // 一段专注进行中,锁的配置就封存了:改它等于中途换掉这一段的承诺。
    // 界面上开关也是禁用的,这里再拦一道——命令面板/快捷键绕不过去。
    if (state.timer.phase === "focus" && enabled !== state.hardLock) {
      useAppStore.getState().showToast("本次专注进行中:锁的配置在结束后才能调整");
      return;
    }
    if (!enabled) {
      set({ pendingHardLock: false });
      try {
        const status = await focusApi.setHardLock(false);
        set({
          hardLock: status.hard_lock,
          hardActive: status.hard_active,
          trusted: status.trusted,
          seen: status.seen,
          swallowed: status.swallowed,
          error: null,
        });
        useAppStore.getState().patchSettings({ focusHardLock: status.hard_lock });
      } catch (e) {
        set({ error: String(e) });
      }
      return;
    }
    try {
      const status = await focusApi.setHardLock(true);
      set({
        hardLock: status.hard_lock,
        pendingHardLock: false,
        trusted: status.trusted,
        seen: status.seen,
        swallowed: status.swallowed,
        error: null,
      });
      // 武装是一种偏好:重启后 App 会按它重新武装(见 App.tsx 的启动恢复)。
      useAppStore.getState().patchSettings({ focusHardLock: status.hard_lock });
      // 武装只是意向:如果这一段正好在跑,立刻把拦截打开。
      await syncHardActive(get().timer);
    } catch (e) {
      const message = String(e);
      const needsAccess = message.includes("NEEDS_ACCESSIBILITY");
      // 缺权限不是失败,是「等授权」:记下意图,权限一到 refreshStatus 会
      // 自动把它打开。用户只需要在系统设置里允许一次。
      set({ error: message, hardLock: false, pendingHardLock: needsAccess });
      useAppStore
        .getState()
        .showToast(
          needsAccess
            ? "硬锁需要辅助功能权限:已弹出系统授权提示,允许后自动打开"
            : message,
        );
    }
  },
  refreshStatus: async () => {
    try {
      const status = await focusApi.status();
      set({
        locked: status.locked,
        hardLock: status.hard_lock,
        hardActive: status.hard_active,
        trusted: status.trusted,
        seen: status.seen,
        swallowed: status.swallowed,
      });
      if (!status.locked) lockOwner = null;
      // 用户在系统设置里刚允许:把之前点了的硬锁自动打开(不用再点一次)。
      if (status.trusted && status.hard_lock === false && get().pendingHardLock) {
        await get().setHardLock(true);
      }
      // 原生在拦但这一段已经不在跑(重启/外部改状态):放开,别把人锁在外面。
      await syncHardActive(get().timer);
    } catch {
      // 浏览器 harness 里没有原生侧:状态读不到就当作没锁。
      set({ locked: false });
    }
  },

  restore: (timer) => {
    if (!timer) {
      set({ timer: createTimerState(), now: Date.now() });
      return;
    }
    const next = sanitize(timer);
    set({ timer: next, now: Date.now() });
    if (!isRunning(next)) return;
    // 还在跑:先按 endsAt 判一次到点(重启可能已经跨过这一段),再决定要不要 tick。
    if (isExpired(next, Date.now())) {
      void applyTimer(stopTimer(next));
      return;
    }
    ensureTicking();
    // 重启前这一段还在跑:武装过的话,拦截要接上。
    void syncHardActive(next);
  },
}));

/** 当前锁的归属(给 UI 显示"这把锁是计时器加的"用)。 */
export function focusLockOwner(): LockOwner {
  return lockOwner;
}

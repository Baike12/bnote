/**
 * 专注模式的状态仓库:番茄钟 + 伪全屏锁 + 硬锁。
 *
 * **单一写入者**:计时状态只有这里改。命令面板、快捷键、状态栏上的芯片、
 * 设置页全都调这里的动作,不各写各的——否则两路写者会打架,谁后写谁生效。
 *
 * 一次番茄钟是**一段连续的专注**:没有休息段,到点即结束,不自动接下一段。
 * 时间和显示都从 `endsAt` 现算(见 timer.ts),不做"每秒减一"。
 *
 * **开始即承诺**:点开始就是「独占屏幕 + 硬锁 + 计时」三件事一起生效,并且
 * 中途没有出口——没有暂停、没有提前结束、没有退锁命令。唯一释放锁的路径是
 * 这一段走完(`applyTimer` 的到点分支)。硬锁要先武装成功才开始:开始了却
 * 挡不住 ⌘Tab,等于骗自己。硬锁没权限时不开始,提示去系统设置授权。
 *
 * 跨重启也接得上:计时状态(endsAt)落盘,重启时 `restore` 会把这一段和
 * 两把锁一起接回来——退出应用不等于结束这一段。
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
  /** 上一次 tick 的时刻——显示剩余时间用它,不用自己取 Date.now。 */
  now: number;
  /** 伪全屏锁是否开着(以原生侧状态为准)。 */
  locked: boolean;
  /** 硬锁是否武装(tap 已建好,专注期间会真正拦截)。 */
  hardLock: boolean;
  /** 硬锁是否**正在拦截**:只有一段番茄钟在跑的时候才为真。 */
  hardActive: boolean;
  /** 请求过硬锁但辅助功能权限还没给。 */
  pendingHardLock: boolean;
  /** 辅助功能权限是否已授予(硬锁的前提)。 */
  trusted: boolean;
  /** 硬锁的 tap 见过的按键事件数——>0 才说明 tap 真的活着。 */
  seen: number;
  /** 硬锁吞掉的按键事件数。 */
  swallowed: number;
  /** 最近一次原生调用的错误,给设置页提示用。 */
  error: string | null;

  /**
   * 开始一段专注:先武装硬锁、再起表、再进锁。硬锁没权限或进锁失败就
   * 不开始(不会出现"计时在走但锁没上"的半截状态)。
   */
  start: () => Promise<void>;
  setDurations: (patch: Partial<TimerConfig>) => void;
  /** 窗口回到前台/系统唤醒后对一次表:到点就收尾,没到点就把显示拉到当下。 */
  syncNow: () => void;
  /** 重读原生锁状态并和当前计时对账(启动、打开设置页、窗口回到前台时)。 */
  refreshStatus: () => Promise<void>;
  /** 启动时从配置里恢复计时状态;还在跑就把两把锁重新接上。 */
  restore: (timer: TimerState | undefined) => Promise<void>;
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

/** start 正在武装+进锁:连点两下不能并发开两次原生锁。 */
let starting = false;

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
    // 到点:这一段结束(不自动接下一段),联动逻辑会把两把锁一起退掉。
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

/** 武装硬锁。没权限时记下"等待授权"并提示,不开始这一段。 */
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

/** 进独占锁。失败返回 false,由调用方决定不开始这一段。 */
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

/** 退独占锁。**只**在 session 结束时由 applyTimer 调,没有任何用户入口。 */
async function unlockNow(): Promise<void> {
  if (!useFocusStore.getState().locked) return;
  try {
    const status = await focusApi.unlock();
    useFocusStore.setState({ locked: status.locked, error: null });
  } catch (e) {
    useFocusStore.setState({ error: String(e) });
  }
}

/**
 * 按会话状态切换"真正拦截":只有**一段专注在跑**才拦。
 *
 * 到点结束时先撤硬锁、再退屏幕锁:硬锁拦着的时候不存在"解锁"这个用户动作,
 * 顺序反过来会在两个原生调用之间留下一个没人负责的窗口。
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
 * 换计时状态,并处理与锁的联动。
 *
 * 一段开始 → 硬锁开始拦截;这一段结束(走完) → 先停止拦截,再退出屏幕锁。
 * 锁没有"手动"来源:它们只属于会话,所以不需要归属记账。
 */
async function applyTimer(next: TimerState): Promise<void> {
  const prev = useFocusStore.getState().timer;
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
 * 开始一段专注。硬锁先到位,再起表,再进锁;进锁失败就立刻收回这一段
 * (这是"开始失败"的收尾,不是用户可以点的退出)。
 */
async function startFocus(): Promise<void> {
  const state = useFocusStore.getState();
  if (isActive(state.timer) || starting) return;
  starting = true;
  try {
    if (!(await armHardLock())) return;
    await applyTimer(startTimer(useFocusStore.getState().timer, Date.now()));
    // 武装成功不等于真的在拦(建 tap 也可能失败):没拦上就不开始这一段。
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

/** 把落盘的旧状态收敛成当前模型:没有暂停/休息段,缺 endsAt 的专注段作废。 */
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
    // 正在跑的段不受影响:endsAt 已经定死,新时长只作用于下一段。
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
      const timer = get().timer;
      const active = isActive(timer) && isRunning(timer);
      if (!isActive(timer)) {
        // 空闲却还锁着(上次被杀/崩了留下的):把窗口放出来,硬锁也回到待命。
        if (status.locked) await unlockNow();
        await syncHardActive(false);
        return;
      }
      if (!status.locked) {
        // 有会话在跑却没有锁:补上(启动早期/原生侧状态丢失)。
        await lockNow();
      }
      if (!status.hard_lock) await armHardLock();
      await syncHardActive(active);
    } catch {
      // 浏览器 harness 里没有原生侧:状态读不到就当作没锁。
      set({ locked: false });
    }
  },

  restore: async (saved) => {
    const next = sanitize(saved);
    set({ timer: next, now: Date.now() });
    if (!isActive(next)) {
      if (get().locked) await unlockNow();
      return;
    }
    if (!isRunning(next) || isExpired(next, Date.now())) {
      await applyTimer(stopTimer(next));
      return;
    }
    // 重启前这一段还在跑:计时接上,锁也接上(退出应用不等于结束承诺)。
    ensureTicking();
    if (!(await armHardLock())) {
      useAppStore.getState().showToast("硬锁未授权:本次专注只剩独占屏幕");
    }
    await lockNow();
    await syncHardActive(true);
  },
}));

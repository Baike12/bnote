/**
 * 番茄钟的纯逻辑:状态机 + 时间计算。
 *
 * 一次番茄钟 = **一段连续的专注**:没有休息段,到点就停,不会自动接下一段
 * (要不要再来一轮由人决定)。所以状态只有 idle / focus 两个。
 *
 * 时间是**时间戳**,不是"每秒减一"的累加器:剩余时间一律由
 * `endsAt - now` 现算。累加器会把每次 tick 的误差攒起来(系统繁忙、标签页
 * 被节流、休眠唤醒),攒到最后显示的时间和真实时间对不上;而且改系统时钟
 * 之后没法自证。这里只存"这一段到几点结束",显示、判超时、跨重启恢复
 * 都从它推。
 *
 * 纯函数,没有 Date.now 藏在里面——`now` 一律由调用方传进来,测试才能钉住
 * 时间(见 timer.test.ts)。
 */

export type TimerPhase = "idle" | "focus";

export interface TimerConfig {
  /** 一次专注有多长(分钟)。 */
  focusMinutes: number;
}

export interface TimerState {
  phase: TimerPhase;
  /** 这一段的结束时间戳(epoch ms)。暂停时为 null。 */
  endsAt: number | null;
  /** 暂停时冻结的剩余毫秒数;恢复时按它重新算 endsAt。 */
  pausedRemaining: number | null;
  config: TimerConfig;
}

export const DEFAULT_TIMER_CONFIG: TimerConfig = { focusMinutes: 25 };

/** 时长下限:0 分钟会让这一段瞬间结束,计时器变成闪一下就没。 */
const MIN_MINUTES = 1;

export function createTimerState(config?: Partial<TimerConfig> | null): TimerState {
  return {
    phase: "idle",
    endsAt: null,
    pausedRemaining: null,
    config: normalizeConfig(config),
  };
}

/**
 * 时长取整并夹进合法范围(0 / 负数 / NaN 一律当 1 分钟)。
 *
 * 入参允许缺字段:旧版本配置里还有 `breakMinutes`、`cycle`,读回来时多出来的
 * 键直接忽略,不能因为字段变了就把人家的时长清零。
 */
export function normalizeConfig(config?: Partial<TimerConfig> | null): TimerConfig {
  const raw = config?.focusMinutes;
  // 缺字段/NaN(比如输入框被清空):用默认值,别把用户的设置清零。
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { focusMinutes: DEFAULT_TIMER_CONFIG.focusMinutes };
  }
  // 明确输入的小值(0、负数)夹到 1 分钟:至少能看出计时在走。
  return { focusMinutes: Math.max(MIN_MINUTES, Math.floor(raw)) };
}

/** 一段专注的长度(毫秒)。 */
export function focusDurationMs(state: TimerState): number {
  return state.config.focusMinutes * 60_000;
}

export function isRunning(state: TimerState): boolean {
  return state.endsAt !== null;
}

/** 有没有一段专注正在进行(跑着或暂停着都算)。 */
export function isActive(state: TimerState): boolean {
  return state.phase === "focus";
}

export function isPaused(state: TimerState): boolean {
  return state.phase === "focus" && state.endsAt === null && state.pausedRemaining !== null;
}

/**
 * 开始计时。
 *
 * 已经在跑就是空操作(幂等):重复按开始不会把已走的进度重置成满格。
 * 从 idle 起则开一段专注;暂停中则接着走剩下的。
 */
export function startTimer(state: TimerState, now: number): TimerState {
  if (state.endsAt !== null) return state;
  if (state.phase === "idle") {
    return { ...state, phase: "focus", endsAt: now + focusDurationMs(state), pausedRemaining: null };
  }
  const remaining = state.pausedRemaining ?? focusDurationMs(state);
  return { ...state, endsAt: now + remaining, pausedRemaining: null };
}

/** 暂停:冻结剩余时间,阶段不变。 */
export function pauseTimer(state: TimerState, now: number): TimerState {
  if (state.endsAt === null) return state;
  return { ...state, endsAt: null, pausedRemaining: Math.max(0, state.endsAt - now) };
}

/** 结束/重置:回到 idle。一段番茄钟只有"走完"和"提前结束"两种收尾。 */
export function stopTimer(state: TimerState): TimerState {
  return { ...state, phase: "idle", endsAt: null, pausedRemaining: null };
}

/** 剩余毫秒;空闲时是 0。 */
export function remainingMs(state: TimerState, now: number): number {
  if (state.endsAt !== null) return Math.max(0, state.endsAt - now);
  if (state.pausedRemaining !== null) return Math.max(0, state.pausedRemaining);
  return 0;
}

/** 这一段是否已经到点。 */
export function isExpired(state: TimerState, now: number): boolean {
  return state.endsAt !== null && now >= state.endsAt;
}

/** mm:ss(超过一小时按 h:mm:ss)。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

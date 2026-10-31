import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { createTimerState, remainingMs } from "./timer";

/**
 * 原生侧(窗口铺屏 / 层级 / 事件 tap)在这里是假实现:这一层要锁的是
 * **联动规则**——专注段开始自动进锁、这一段结束自动退锁、用户手动加的锁不被
 * 计时器解除。真窗口行为只能在真应用里验。
 */
const focusMock = vi.hoisted(() => ({
  status: vi.fn(async () => ({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
  })),
  lock: vi.fn(async () => ({ locked: true, hard_lock: false, hard_active: false, trusted: true })),
  unlock: vi.fn(async () => ({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
  })),
  setHardLock: vi.fn(async (enabled: boolean) => ({
    locked: false,
    hard_lock: enabled,
    hard_active: false,
    trusted: true,
  })),
  setHardLockActive: vi.fn(async (active: boolean) => ({
    locked: false,
    hard_lock: true,
    hard_active: active,
    trusted: true,
  })),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    // 落盘在 node 环境里没有 IPC:换成空实现,免得刷一屏 warn。
    api: { ...actual.api, saveAppConfig: async () => {} },
    focusApi: focusMock,
  };
});

const { useFocusStore } = await import("./store");

const T0 = 1_700_000_000_000;

function setAutoLock(on: boolean) {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, focusAutoLock: on },
  });
}

describe("专注模式的锁联动", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    focusMock.lock.mockClear();
    focusMock.unlock.mockClear();
    focusMock.setHardLock.mockClear();
    focusMock.setHardLockActive.mockClear();
    focusMock.status.mockClear();
    setAutoLock(true);
    useFocusStore.setState({
      timer: createTimerState(),
      now: T0,
      locked: false,
      hardLock: false,
      pendingHardLock: false,
      trusted: true,
      error: null,
    });
  });

  afterEach(async () => {
    // 复位:计时器停下来(store 里的 tick 句柄要清掉,否则下一个用例会复用
    // 一个属于上一条假时钟的定时器,永远不触发)。
    useFocusStore.getState().stop();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("开始专注 → 自动进锁", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().timer.phase).toBe("focus");
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().locked).toBe(true);
  });

  it("提前结束 → 自动退锁", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    useFocusStore.getState().stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.unlock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().locked).toBe(false);
  });

  it("到点即收尾:退锁 + 回到空闲,不自动开始下一段", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25 * 60_000 + 1000);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    expect(focusMock.unlock).toHaveBeenCalledTimes(1);
    // 只开过这一次(没有接下一段)
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
  });

  it("关掉自动锁后,计时器不碰锁", async () => {
    setAutoLock(false);
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().timer.phase).toBe("focus");
    expect(focusMock.lock).not.toHaveBeenCalled();
  });

  it("用户手动加的锁,计时器不解除它", async () => {
    await useFocusStore.getState().enterLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().locked).toBe(true);

    // 计时器开始:它自己加锁是幂等的,不重复调原生
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);

    // 这一段结束:这把锁是用户手动加的,计时器没有资格解除
    useFocusStore.getState().stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(focusMock.unlock).not.toHaveBeenCalled();
    expect(useFocusStore.getState().locked).toBe(true);
  });

  it("用户显式退锁一定放得开(哪怕锁是计时器加的)", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().locked).toBe(true);
    await useFocusStore.getState().exitLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(focusMock.unlock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().locked).toBe(false);
  });

  it("恢复上次的计时状态:还在跑就接着跑", () => {
    const saved = {
      ...createTimerState({ focusMinutes: 25 }),
      phase: "focus" as const,
      endsAt: T0 + 10 * 60_000,
      pausedRemaining: null,
    };
    useFocusStore.getState().restore(saved);
    expect(useFocusStore.getState().timer.endsAt).toBe(T0 + 10 * 60_000);
    expect(useFocusStore.getState().timer.phase).toBe("focus");
  });

  it("恢复时发现这一段已经到点:立刻收尾,不重开", async () => {
    const saved = {
      ...createTimerState(),
      phase: "focus" as const,
      endsAt: T0 - 1000,
      pausedRemaining: null,
    };
    useFocusStore.getState().restore(saved);
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.lock).not.toHaveBeenCalled();
  });

  it("旧版本存下的休息段状态读回来当空闲(没有休息段这个概念了)", () => {
    const legacy = {
      phase: "break",
      endsAt: T0 + 5 * 60_000,
      pausedRemaining: null,
      cycle: 3,
      config: { focusMinutes: 30, breakMinutes: 5 },
    } as unknown as ReturnType<typeof createTimerState>;
    useFocusStore.getState().restore(legacy);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    // 时长别被旧字段带偏
    expect(useFocusStore.getState().timer.config.focusMinutes).toBe(30);
  });
});

/**
 * 倒计时必须真的在走:这里锁的是"时间在推进"这件事本身。
 * 真机上冻结过一次,所以它必须有测试盯着。
 */
describe("倒计时在走", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    focusMock.lock.mockClear();
    setAutoLock(false);
    useFocusStore.setState({
      timer: createTimerState({ focusMinutes: 25 }),
      now: T0,
      locked: false,
      hardLock: false,
      pendingHardLock: false,
      trusted: true,
      error: null,
    });
  });

  afterEach(async () => {
    useFocusStore.getState().stop();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("过了 3 秒:now 前进、剩余时间少 3 秒", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    const before = remainingMs(useFocusStore.getState().timer, useFocusStore.getState().now);
    expect(before).toBe(25 * 60_000);

    await vi.advanceTimersByTimeAsync(3000);
    const after = remainingMs(useFocusStore.getState().timer, useFocusStore.getState().now);
    expect(useFocusStore.getState().now).toBe(T0 + 3000);
    expect(before - after).toBe(3000);
  });

  it("窗口挂起很久再回来(对表):时间按真实时钟走,不按 tick 次数", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    // 模拟被节流:不跑 tick,直接把系统时钟推到 10 分钟后,再对一次表
    vi.setSystemTime(T0 + 10 * 60_000);
    useFocusStore.getState().syncNow();
    const { timer, now } = useFocusStore.getState();
    expect(now).toBe(T0 + 10 * 60_000);
    expect(remainingMs(timer, now)).toBe(15 * 60_000);
  });

  it("对表时发现已经过点:直接收尾", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(T0 + 30 * 60_000);
    useFocusStore.getState().syncNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
  });
});

/**
 * 硬锁的两层语义:**武装**(用户打开开关,表示"专注期间不许切走")与
 * **拦截**(真正吞键)。拦截只在一段番茄钟跑着的时候发生——没在专注时
 * ⌘Tab 必须照常可用,否则打开硬锁等于把自己锁在应用里。
 */
describe("硬锁:武装 ≠ 拦截", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    focusMock.lock.mockClear();
    focusMock.unlock.mockClear();
    focusMock.setHardLock.mockClear();
    focusMock.setHardLockActive.mockClear();
    // 自动锁打开:退出独占总得有锁可退(手动逃生口那一条用例要用到)。
    setAutoLock(true);
    useFocusStore.setState({
      timer: createTimerState(),
      now: T0,
      locked: false,
      hardLock: true,
      hardActive: false,
      pendingHardLock: false,
      trusted: true,
      error: null,
    });
  });

  afterEach(async () => {
    useFocusStore.getState().stop();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("只武装不拦截:开开关时 ⌘Tab 照常可用", async () => {
    await useFocusStore.getState().setHardLock(false);
    await useFocusStore.getState().setHardLock(true);
    expect(focusMock.setHardLockActive).not.toHaveBeenCalled();
    expect(useFocusStore.getState().hardActive).toBe(false);
  });

  it("开始一段专注 → 开始拦截", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(focusMock.setHardLockActive).toHaveBeenCalledWith(true);
    expect(useFocusStore.getState().hardActive).toBe(true);
  });

  it("这一段结束 → 停止拦截(开关仍是开着的待命态)", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    useFocusStore.getState().stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(focusMock.setHardLockActive).toHaveBeenLastCalledWith(false);
    expect(useFocusStore.getState().hardActive).toBe(false);
    expect(useFocusStore.getState().hardLock).toBe(true);
  });

  it("暂停就放开,继续再拦上", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    useFocusStore.getState().pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().hardActive).toBe(false);

    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().hardActive).toBe(true);
  });

  it("用户显式退出独占 → 立刻停止拦截(哪怕计时还在跑)", async () => {
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    await useFocusStore.getState().exitLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().hardActive).toBe(false);
    expect(focusMock.setHardLockActive).toHaveBeenLastCalledWith(false);
  });

  it("没武装时开始专注:不拦截", async () => {
    useFocusStore.setState({ hardLock: false });
    useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(focusMock.setHardLockActive).not.toHaveBeenCalled();
    expect(useFocusStore.getState().hardActive).toBe(false);
  });
});

/**
 * 辅助功能授权的交互契约:用户只做一次动作(在系统设置里允许),
 * 应用自己把硬锁打开——不允许再要求"回来点第二次开关"。
 */
describe("硬锁的授权等待", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    focusMock.setHardLock.mockClear();
    focusMock.status.mockClear();
    setAutoLock(false);
    useFocusStore.setState({
      timer: createTimerState(),
      now: T0,
      locked: false,
      hardLock: false,
      pendingHardLock: false,
      trusted: false,
      error: null,
    });
  });

  afterEach(() => {
    useFocusStore.getState().stop();
    vi.useRealTimers();
  });

  it("缺权限时进入等待,而不是失败", async () => {
    focusMock.setHardLock.mockRejectedValueOnce(
      new Error("NEEDS_ACCESSIBILITY: 硬锁需要辅助功能权限"),
    );
    await useFocusStore.getState().setHardLock(true);
    expect(useFocusStore.getState().pendingHardLock).toBe(true);
    expect(useFocusStore.getState().hardLock).toBe(false);
  });

  it("授权到位后自动打开(不用再点一次开关)", async () => {
    focusMock.setHardLock.mockRejectedValueOnce(
      new Error("NEEDS_ACCESSIBILITY: 硬锁需要辅助功能权限"),
    );
    await useFocusStore.getState().setHardLock(true);

    // 用户在系统设置里允许了,回到窗口触发一次状态刷新
    focusMock.status.mockResolvedValueOnce({
      locked: false,
      hard_lock: false,
      hard_active: false,
      trusted: true,
    });
    await useFocusStore.getState().refreshStatus();

    expect(focusMock.setHardLock).toHaveBeenCalledTimes(2);
    expect(useFocusStore.getState().hardLock).toBe(true);
    expect(useFocusStore.getState().pendingHardLock).toBe(false);
  });

  it("还没授权时不反复尝试(不反复弹系统授权框)", async () => {
    focusMock.setHardLock.mockRejectedValueOnce(
      new Error("NEEDS_ACCESSIBILITY: 硬锁需要辅助功能权限"),
    );
    await useFocusStore.getState().setHardLock(true);

    focusMock.status.mockResolvedValueOnce({
      locked: false,
      hard_lock: false,
      hard_active: false,
      trusted: false,
    });
    await useFocusStore.getState().refreshStatus();

    expect(focusMock.setHardLock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().pendingHardLock).toBe(true);
  });

  it("等待期间点关闭:撤销意图,授权到位也不会自己打开", async () => {
    focusMock.setHardLock.mockRejectedValueOnce(
      new Error("NEEDS_ACCESSIBILITY: 硬锁需要辅助功能权限"),
    );
    await useFocusStore.getState().setHardLock(true);
    focusMock.setHardLock.mockResolvedValueOnce({
      locked: false,
      hard_lock: false,
      hard_active: false,
      trusted: false,
    });
    await useFocusStore.getState().setHardLock(false);
    expect(useFocusStore.getState().pendingHardLock).toBe(false);

    focusMock.status.mockResolvedValueOnce({
      locked: false,
      hard_lock: false,
      hard_active: false,
      trusted: true,
    });
    await useFocusStore.getState().refreshStatus();
    expect(useFocusStore.getState().hardLock).toBe(false);
  });

  it("一段专注进行中:硬锁配置改不了(这一段的承诺不能中途换)", async () => {
    useFocusStore.setState({
      timer: { ...createTimerState(), phase: "focus", endsAt: T0 + 60_000 },
    });
    await useFocusStore.getState().setHardLock(true);
    expect(focusMock.setHardLock).not.toHaveBeenCalled();
    expect(useFocusStore.getState().hardLock).toBe(false);

    // 结束后就能改
    useFocusStore.getState().stop();
    await vi.advanceTimersByTimeAsync(0);
    await useFocusStore.getState().setHardLock(true);
    expect(focusMock.setHardLock).toHaveBeenCalledTimes(1);
  });
});

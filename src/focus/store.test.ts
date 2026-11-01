import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimerState, remainingMs } from "./timer";

/**
 * 原生侧(窗口铺屏 / 层级 / 事件 tap)在这里是假实现:这一层要锁的是
 * **承诺规则**——点开始 = 硬锁武装 + 独占锁 + 计时一起生效;这一段只有
 * 走完才释放;开始失败不会留下"计时在走但锁没上"的半截状态。真窗口行为
 * 只能在真应用里验。
 */
const focusMock = vi.hoisted(() => ({
  status: vi.fn(async () => ({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
  lock: vi.fn(async () => ({
    locked: true,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
  unlock: vi.fn(async () => ({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
  setHardLock: vi.fn(async (enabled: boolean) => ({
    locked: false,
    hard_lock: enabled,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
  setHardLockActive: vi.fn(async (active: boolean) => ({
    locked: false,
    hard_lock: true,
    hard_active: active,
    trusted: true,
    seen: 0,
    swallowed: 0,
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

function resetMocks() {
  focusMock.status.mockReset();
  focusMock.lock.mockReset();
  focusMock.unlock.mockReset();
  focusMock.setHardLock.mockReset();
  focusMock.setHardLockActive.mockReset();

  focusMock.status.mockResolvedValue({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  });
  focusMock.lock.mockResolvedValue({
    locked: true,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  });
  focusMock.unlock.mockResolvedValue({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  });
  focusMock.setHardLock.mockImplementation(async (enabled: boolean) => ({
    locked: false,
    hard_lock: enabled,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  }));
  focusMock.setHardLockActive.mockImplementation(async (active: boolean) => ({
    locked: false,
    hard_lock: true,
    hard_active: active,
    trusted: true,
    seen: 0,
    swallowed: 0,
  }));
}

function resetStore() {
  useFocusStore.setState({
    timer: createTimerState(),
    now: T0,
    locked: false,
    hardLock: false,
    hardActive: false,
    pendingHardLock: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
    error: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetMocks();
  resetStore();
});

afterEach(async () => {
  // 让可能还在跑的段走完:applyTimer(stop) 会清掉内部 tick 句柄,否则下一个
  // 用例会拿到一个属于上一条假时钟的定时器,永远不触发。
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  await vi.advanceTimersByTimeAsync(2_000);
  vi.useRealTimers();
});

describe("开始就是承诺:硬锁 + 独占锁 + 计时一起生效", () => {
  it("点开始会先武装硬锁,再起表并进锁", async () => {
    await useFocusStore.getState().start();

    expect(focusMock.setHardLock).toHaveBeenCalledWith(true);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().timer.phase).toBe("focus");
    expect(useFocusStore.getState().timer.endsAt).toBe(T0 + 25 * 60_000);
    expect(useFocusStore.getState().locked).toBe(true);
    expect(useFocusStore.getState().hardActive).toBe(true);

    // 顺序:先有硬锁,才起表/进锁(不能出现"计时在走但挡不住 ⌘Tab")。
    const arm = focusMock.setHardLock.mock.invocationCallOrder[0];
    const lock = focusMock.lock.mock.invocationCallOrder[0];
    expect(arm).toBeLessThan(lock);
  });

  it("重复开始是空操作:不会重开,也不会再调一次原生锁", async () => {
    await useFocusStore.getState().start();
    const endsAt = useFocusStore.getState().timer.endsAt;
    await useFocusStore.getState().start();
    expect(useFocusStore.getState().timer.endsAt).toBe(endsAt);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(focusMock.setHardLock).toHaveBeenCalledTimes(1);
  });

  it("硬锁没权限:这一段根本不开始(不骗自己)", async () => {
    focusMock.setHardLock.mockRejectedValueOnce(
      new Error("NEEDS_ACCESSIBILITY: 硬锁需要辅助功能权限"),
    );
    await useFocusStore.getState().start();

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    expect(focusMock.lock).not.toHaveBeenCalled();
    expect(useFocusStore.getState().pendingHardLock).toBe(true);
    expect(useFocusStore.getState().hardActive).toBe(false);
  });

  it("硬锁武装了但 tap 没起来:这一段也不开始", async () => {
    focusMock.setHardLockActive.mockResolvedValueOnce({
      locked: false,
      hard_lock: true,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    });
    await useFocusStore.getState().start();

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().hardActive).toBe(false);
    expect(focusMock.lock).not.toHaveBeenCalled();
  });

  it("进锁失败:收回这一段,硬锁也停手", async () => {
    focusMock.lock.mockRejectedValueOnce(new Error("LOCK_FAILED: 进不了锁"));
    await useFocusStore.getState().start();

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    expect(useFocusStore.getState().locked).toBe(false);
    expect(useFocusStore.getState().hardActive).toBe(false);
    expect(focusMock.setHardLockActive).toHaveBeenLastCalledWith(false);
  });

  it("没有任何中途出口:暂停/结束/退锁的动作都不存在了", () => {
    const api = useFocusStore.getState() as unknown as Record<string, unknown>;
    for (const gone of ["pause", "stop", "enterLock", "exitLock", "toggleLock", "setHardLock"]) {
      expect(api[gone], gone).toBeUndefined();
    }
  });

  it("改时长只影响下一段:正在跑的 endsAt 不动", async () => {
    await useFocusStore.getState().start();
    const endsAt = useFocusStore.getState().timer.endsAt;
    useFocusStore.getState().setDurations({ focusMinutes: 40 });
    expect(useFocusStore.getState().timer.endsAt).toBe(endsAt);
    expect(useFocusStore.getState().timer.config.focusMinutes).toBe(40);
  });
});

describe("到点收尾:先撤硬锁,再退锁", () => {
  it("走完 25 分钟 → 空闲 + 解锁 + 停止拦截", async () => {
    await useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(25 * 60_000 + 1000);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    expect(useFocusStore.getState().locked).toBe(false);
    expect(useFocusStore.getState().hardActive).toBe(false);
    expect(focusMock.unlock).toHaveBeenCalledTimes(1);
    expect(focusMock.setHardLockActive).toHaveBeenLastCalledWith(false);

    // 先停止拦截,再退屏幕锁(反向顺序会在两个原生调用之间留下窗口)。
    const order = focusMock.setHardLockActive.mock.invocationCallOrder;
    const disarm = order[order.length - 1];
    const unlock = focusMock.unlock.mock.invocationCallOrder[0];
    expect(disarm).toBeLessThan(unlock);
  });

  it("不自动接下一段", async () => {
    await useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(25 * 60_000 + 1000);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
  });
});

describe("倒计时在走", () => {
  it("过了 3 秒:now 前进、剩余时间少 3 秒", async () => {
    await useFocusStore.getState().start();
    const before = remainingMs(useFocusStore.getState().timer, useFocusStore.getState().now);
    expect(before).toBe(25 * 60_000);

    await vi.advanceTimersByTimeAsync(3000);
    const after = remainingMs(useFocusStore.getState().timer, useFocusStore.getState().now);
    expect(useFocusStore.getState().now).toBe(T0 + 3000);
    expect(before - after).toBe(3000);
  });

  it("窗口挂起很久再回来(对表):按真实时钟走,不按 tick 次数", async () => {
    await useFocusStore.getState().start();
    vi.setSystemTime(T0 + 10 * 60_000);
    useFocusStore.getState().syncNow();
    const { timer, now } = useFocusStore.getState();
    expect(now).toBe(T0 + 10 * 60_000);
    expect(remainingMs(timer, now)).toBe(15 * 60_000);
  });

  it("对表时发现已经过点:直接收尾", async () => {
    await useFocusStore.getState().start();
    vi.setSystemTime(T0 + 30 * 60_000);
    useFocusStore.getState().syncNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().locked).toBe(false);
  });
});

describe("跨重启:退出应用不等于结束这一段", () => {
  it("恢复还在跑的段:计时接着走,两把锁重新接上", async () => {
    const saved = { ...createTimerState(), phase: "focus" as const, endsAt: T0 + 10 * 60_000 };
    await useFocusStore.getState().restore(saved);

    expect(useFocusStore.getState().timer.endsAt).toBe(T0 + 10 * 60_000);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(focusMock.setHardLock).toHaveBeenCalledWith(true);
    expect(useFocusStore.getState().locked).toBe(true);
    expect(useFocusStore.getState().hardActive).toBe(true);
  });

  it("恢复时发现这一段已经到点:立刻收尾,不重开", async () => {
    const saved = { ...createTimerState(), phase: "focus" as const, endsAt: T0 - 1000 };
    await useFocusStore.getState().restore(saved);
    await vi.advanceTimersByTimeAsync(0);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.lock).not.toHaveBeenCalled();
  });

  it("旧版本的休息段状态读回来当空闲(没有休息段这个概念了)", async () => {
    const legacy = {
      phase: "break",
      endsAt: T0 + 5 * 60_000,
      cycle: 3,
      config: { focusMinutes: 30, breakMinutes: 5 },
    } as unknown as ReturnType<typeof createTimerState>;
    await useFocusStore.getState().restore(legacy);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    // 时长别被旧字段带偏
    expect(useFocusStore.getState().timer.config.focusMinutes).toBe(30);
  });

  it("旧版本的暂停段(没有 endsAt)当空闲:暂停已经没有意义", async () => {
    const legacy = {
      phase: "focus",
      endsAt: null,
      pausedRemaining: 10 * 60_000,
      config: { focusMinutes: 25 },
    } as unknown as ReturnType<typeof createTimerState>;
    await useFocusStore.getState().restore(legacy);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.lock).not.toHaveBeenCalled();
  });
});

describe("原生状态对账(崩溃残留)", () => {
  it("空闲却还锁着:refreshStatus 把窗口放出来", async () => {
    useFocusStore.setState({ locked: true });
    focusMock.status.mockResolvedValueOnce({
      locked: true,
      hard_lock: false,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    });
    await useFocusStore.getState().refreshStatus();
    expect(focusMock.unlock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().locked).toBe(false);
  });

  it("有会话却掉了锁/硬锁:refreshStatus 补上", async () => {
    useFocusStore.setState({
      timer: { ...createTimerState(), phase: "focus", endsAt: T0 + 60_000 },
      locked: false,
      hardLock: false,
    });
    await useFocusStore.getState().refreshStatus();
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(focusMock.setHardLock).toHaveBeenCalledWith(true);
    expect(useFocusStore.getState().hardActive).toBe(true);
  });
});

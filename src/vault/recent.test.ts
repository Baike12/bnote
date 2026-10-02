import { describe, expect, it } from "vitest";
import { RECENT_VAULTS_CAP, recentVaultTarget, touchRecentVault } from "./recent";

describe("touchRecentVault", () => {
  it("新路径插到队首", () => {
    expect(touchRecentVault(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("重复路径去重并提到队首(打开即 MRU)", () => {
    expect(touchRecentVault(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });

  it("超出上限丢最旧的(队尾)", () => {
    const full = Array.from({ length: RECENT_VAULTS_CAP }, (_, i) => `/v${i}`);
    const next = touchRecentVault(full, "/new");
    expect(next).toHaveLength(RECENT_VAULTS_CAP);
    expect(next[0]).toBe("/new");
    expect(next).not.toContain("/v9");
    expect(next).toContain("/v0");
  });

  it("空路径不进列表", () => {
    expect(touchRecentVault(["/a"], "")).toEqual(["/a"]);
  });

  it("纯函数:不改入参", () => {
    const list = ["/a", "/b"];
    touchRecentVault(list, "/a");
    expect(list).toEqual(["/a", "/b"]);
  });
});

describe("recentVaultTarget", () => {
  it("返回第一个非当前仓", () => {
    expect(recentVaultTarget(["/a", "/b"], "/x")).toBe("/a");
  });

  it("当前仓在队首时跳过它(两仓 toggle 的落点就是另一仓)", () => {
    expect(recentVaultTarget(["/a", "/b"], "/a")).toBe("/b");
    expect(recentVaultTarget(["/b", "/a"], "/a")).toBe("/b");
  });

  it("列表里只有当前仓时返回 null", () => {
    expect(recentVaultTarget(["/a"], "/a")).toBeNull();
  });

  it("空列表返回 null", () => {
    expect(recentVaultTarget([], "/a")).toBeNull();
    expect(recentVaultTarget([], null)).toBeNull();
  });

  it("未开仓(欢迎页)时返回最近一个", () => {
    expect(recentVaultTarget(["/a", "/b"], null)).toBe("/a");
  });
});

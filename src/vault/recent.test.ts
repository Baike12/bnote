import { describe, expect, it } from "vitest";
import { RECENT_VAULTS_CAP, recentVaultTarget, touchRecentVault } from "./recent";

describe("touchRecentVault", () => {
  it("a new path is inserted at the head", () => {
    expect(touchRecentVault(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("a duplicate path is deduplicated and moved to the head (opening means MRU)", () => {
    expect(touchRecentVault(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });

  it("beyond the cap the oldest is dropped (the tail)", () => {
    const full = Array.from({ length: RECENT_VAULTS_CAP }, (_, i) => `/v${i}`);
    const next = touchRecentVault(full, "/new");
    expect(next).toHaveLength(RECENT_VAULTS_CAP);
    expect(next[0]).toBe("/new");
    expect(next).not.toContain("/v9");
    expect(next).toContain("/v0");
  });

  it("an empty path does not enter the list", () => {
    expect(touchRecentVault(["/a"], "")).toEqual(["/a"]);
  });

  it("a pure function: the argument is not mutated", () => {
    const list = ["/a", "/b"];
    touchRecentVault(list, "/a");
    expect(list).toEqual(["/a", "/b"]);
  });
});

describe("recentVaultTarget", () => {
  it("returns the first vault that is not the current one", () => {
    expect(recentVaultTarget(["/a", "/b"], "/x")).toBe("/a");
  });

  it("the current vault at the head is skipped (the target of a two-vault toggle is the other vault)", () => {
    expect(recentVaultTarget(["/a", "/b"], "/a")).toBe("/b");
    expect(recentVaultTarget(["/b", "/a"], "/a")).toBe("/b");
  });

  it("returns null when the list holds only the current vault", () => {
    expect(recentVaultTarget(["/a"], "/a")).toBeNull();
  });

  it("an empty list returns null", () => {
    expect(recentVaultTarget([], "/a")).toBeNull();
    expect(recentVaultTarget([], null)).toBeNull();
  });

  it("without an open vault (welcome page) it returns the most recent one", () => {
    expect(recentVaultTarget(["/a", "/b"], null)).toBe("/a");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readVimrc: vi.fn(),
  readVaultFile: vi.fn(),
  applyNativeMappings: vi.fn(),
  setVimClipboardUnnamed: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  api: { readVimrc: mocks.readVimrc, readVaultFile: mocks.readVaultFile },
}));
vi.mock("./vim", () => ({
  applyNativeMappings: mocks.applyNativeMappings,
  setVimClipboardUnnamed: mocks.setVimClipboardUnnamed,
}));

import { useAppStore } from "@/state/appStore";
import { loadVimrc, onVimMappingsChanged, vimMappings } from "./loader";

/**
 * vimrc is a two-level configuration: the app-wide file, then the vault's
 * `.bnote/vimrc` (vault wins by being parsed second). The loader is the only
 * writer of the engine's native mappings, so a lost level or a wrongly
 * swallowed parse error silently changes every user's key behavior.
 */

beforeEach(() => {
  mocks.readVimrc.mockReset();
  mocks.readVaultFile.mockReset();
  mocks.applyNativeMappings.mockReset();
  mocks.setVimClipboardUnnamed.mockReset();
  useAppStore.setState({ vaultPath: null });
});

describe("loadVimrc", () => {
  it("merges the global file and then the vault file", async () => {
    useAppStore.setState({ vaultPath: "/vault" });
    mocks.readVimrc.mockResolvedValue("imap jj <Esc>");
    mocks.readVaultFile.mockResolvedValue("set clipboard=unnamed\nimap kk <Esc>");

    const merged = await loadVimrc();

    expect(mocks.readVaultFile).toHaveBeenCalledWith("vimrc");
    expect(merged.map((m) => m.lhs)).toEqual(["jj", "kk"]);
    expect(mocks.applyNativeMappings).toHaveBeenCalledWith(merged);
    expect(mocks.setVimClipboardUnnamed).toHaveBeenCalledWith(true);
  });

  it("without an open vault only the global file is read", async () => {
    mocks.readVimrc.mockResolvedValue("imap jj <Esc>");
    const merged = await loadVimrc();
    expect(mocks.readVaultFile).not.toHaveBeenCalled();
    expect(merged).toHaveLength(1);
    expect(mocks.setVimClipboardUnnamed).toHaveBeenCalledWith(false);
  });

  it("an unreadable file is treated as absent, not as a fatal error", async () => {
    useAppStore.setState({ vaultPath: "/vault" });
    mocks.readVimrc.mockRejectedValue(new Error("READ_FAILED"));
    mocks.readVaultFile.mockResolvedValue("imap kk <Esc>");
    const merged = await loadVimrc();
    expect(merged.map((m) => m.lhs)).toEqual(["kk"]);
  });

  it("warns about bad lines but still applies the valid ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.readVimrc.mockResolvedValue("unknown-command\nimap jj <Esc>");
    mocks.readVaultFile.mockResolvedValue(null);

    const merged = await loadVimrc();

    expect(merged.map((m) => m.lhs)).toEqual(["jj"]);
    expect(warn).toHaveBeenCalledWith(
      "[bnote] vimrc warnings:",
      expect.arrayContaining([expect.stringContaining("unsupported vimrc command")]),
    );
    warn.mockRestore();
  });

  it("an empty configuration applies an empty mapping list and clears clipboard-unnamed", async () => {
    mocks.readVimrc.mockResolvedValue(null);
    mocks.readVaultFile.mockResolvedValue(null);
    await expect(loadVimrc()).resolves.toEqual([]);
    expect(mocks.applyNativeMappings).toHaveBeenCalledWith([]);
    expect(mocks.setVimClipboardUnnamed).toHaveBeenCalledWith(false);
  });
});

describe("the one copy every vim surface reconfigures from", () => {
  it("a load publishes the merged mappings and vimMappings() reads them back", async () => {
    mocks.readVimrc.mockResolvedValue("imap jj <Esc>");
    mocks.readVaultFile.mockResolvedValue(null);
    const seen: string[][] = [];
    const off = onVimMappingsChanged((m) => seen.push(m.map((x) => x.lhs)));
    const merged = await loadVimrc();
    off();

    expect(seen).toEqual([["jj"]]);
    expect(vimMappings()).toEqual(merged);
  });

  it("an unsubscribed listener stops hearing about loads", async () => {
    mocks.readVimrc.mockResolvedValue("imap kk <Esc>");
    mocks.readVaultFile.mockResolvedValue(null);
    const seen: number[] = [];
    const off = onVimMappingsChanged(() => seen.push(1));
    off();
    await loadVimrc();
    expect(seen).toEqual([]);
  });
});

describe("ensureVimrcLoaded", () => {
  it("loads once per module lifetime: a surface mounting after the notes editor reuses the copy", async () => {
    vi.resetModules();
    const fresh = await import("./loader");
    mocks.readVimrc.mockResolvedValue("imap jj <Esc>");
    mocks.readVaultFile.mockResolvedValue(null);

    const first = await fresh.ensureVimrcLoaded();
    mocks.readVimrc.mockClear();
    const second = await fresh.ensureVimrcLoaded();

    expect(first.map((m) => m.lhs)).toEqual(["jj"]);
    expect(second).toBe(first);
    // A second read would mean a second owner of the engine's mappings.
    expect(mocks.readVimrc).not.toHaveBeenCalled();
    // An explicit reload still reloads (the vimrc file edited on disk).
    await fresh.loadVimrc();
    expect(mocks.readVimrc).toHaveBeenCalledTimes(1);
  });
});

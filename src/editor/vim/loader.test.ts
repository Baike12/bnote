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
import { loadVimrc } from "./loader";

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

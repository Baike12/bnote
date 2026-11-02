import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readVaultFile: vi.fn(),
  writeVaultFile: vi.fn(),
  loadKeybindings: vi.fn(),
  saveKeybindings: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ api: mocks }));

import {
  getKeymapRevision,
  getOverrides,
  loadKeymap,
  resetAllOverrides,
  setOverride,
  subscribeKeymap,
} from "./keybindingOverrides";
import { applyOverrides, bindingsForCommand, regionOfCommand } from "./keys";

const VAULT = "/vaults/test";

beforeEach(() => {
  vi.clearAllMocks();
  applyOverrides({});
  mocks.writeVaultFile.mockResolvedValue(undefined);
  mocks.saveKeybindings.mockResolvedValue(undefined);
  mocks.loadKeybindings.mockResolvedValue(null);
});

describe("keybinding config storage", () => {
  it("when the vault has a config file it is read directly, the legacy app config is left alone", async () => {
    mocks.readVaultFile.mockResolvedValue(
      JSON.stringify({ reading: { "study.pdf-next-page": "Ctrl-j" } }),
    );
    await loadKeymap(VAULT);
    expect(mocks.readVaultFile).toHaveBeenCalledWith("keybindings.json");
    expect(mocks.loadKeybindings).not.toHaveBeenCalled();
    expect(bindingsForCommand("study.pdf-next-page")).toEqual(["Ctrl-j"]);
    expect(regionOfCommand("study.pdf-next-page")).toBe("reading");
  });

  it("when the vault has no config yet the legacy flat table is migrated into regions and the old file is cleared", async () => {
    mocks.readVaultFile.mockResolvedValue(null);
    mocks.loadKeybindings.mockResolvedValue({
      "study.pdf-next-page": "Ctrl-j",
      "edit.toggle-bold": "Mod-b",
      "nav.command-palette": "Mod-p",
    });
    await loadKeymap(VAULT);
    expect(mocks.writeVaultFile).toHaveBeenCalledTimes(1);
    const [name, text] = mocks.writeVaultFile.mock.calls[0] as [string, string];
    expect(name).toBe("keybindings.json");
    expect(text).toContain('"reading"');
    expect(text).toContain("Ctrl-j");
    expect(text).toContain("Mod-b");
    expect(text).toContain("Mod-p");
    // The legacy table is cleared once the migration succeeded: from now on
    // the vault file is the only source.
    expect(mocks.saveKeybindings).toHaveBeenCalledWith({});
    expect(bindingsForCommand("study.pdf-next-page")).toEqual(["Ctrl-j"]);
    expect(bindingsForCommand("edit.toggle-bold")).toEqual(["Mod-b"]);
  });

  it("an empty legacy table creates no config file", async () => {
    mocks.readVaultFile.mockResolvedValue(null);
    mocks.loadKeybindings.mockResolvedValue({});
    await loadKeymap(VAULT);
    expect(mocks.writeVaultFile).not.toHaveBeenCalled();
    expect(mocks.saveKeybindings).not.toHaveBeenCalled();
  });

  it("a rebind is written back to the vault file and the subscribers are notified to re-render", async () => {
    mocks.readVaultFile.mockResolvedValue(JSON.stringify({}));
    await loadKeymap(VAULT);
    let calls = 0;
    const off = subscribeKeymap(() => {
      calls += 1;
    });
    const before = getKeymapRevision();
    await setOverride("edit.toggle-bold", "Mod-Shift-b", "notes");
    off();
    expect(calls).toBe(1);
    expect(getKeymapRevision()).toBe(before + 1);
    expect(bindingsForCommand("edit.toggle-bold")).toEqual(["Mod-Shift-b"]);
    const writes = mocks.writeVaultFile.mock.calls;
    const [name, text] = writes[writes.length - 1] as [string, string];
    expect(name).toBe("keybindings.json");
    expect(text).toContain("Mod-Shift-b");
    expect(getOverrides().notes?.["edit.toggle-bold"]).toBe("Mod-Shift-b");
  });

  it("an unbinding is written as null, a reset clears all overrides", async () => {
    mocks.readVaultFile.mockResolvedValue(JSON.stringify({}));
    await loadKeymap(VAULT);
    await setOverride("edit.toggle-italic", null, "notes");
    expect(getOverrides().notes?.["edit.toggle-italic"]).toBeNull();
    expect(bindingsForCommand("edit.toggle-italic")).toEqual([]);
    await resetAllOverrides();
    expect(getOverrides()).toEqual({});
    expect(bindingsForCommand("edit.toggle-italic")).toEqual(["Mod-Shift-i"]);
  });
});

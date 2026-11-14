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
  keybindingsFilePath,
  loadKeymap,
  reloadKeymap,
  resetAllOverrides,
  setOverride,
  clearOverride,
  subscribeKeymap,
} from "./keybindingOverrides";
import {
  applyOverrides,
  bindingsForCommand,
  flattenOverrides,
  regionOfCommand,
  serializeOverrides,
} from "./keys";
import { useAppStore } from "@/state/appStore";

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

describe("failure paths", () => {
  it("a corrupt config file falls back to defaults and tells the user, instead of half-applying it", async () => {
    mocks.readVaultFile.mockResolvedValue("{ this is not json");
    await loadKeymap(VAULT);

    expect(getOverrides()).toEqual({});
    expect(bindingsForCommand("edit.toggle-bold")).toEqual(["Mod-b"]);
    expect(useAppStore.getState().toast).toContain("快捷键配置解析失败");
  });

  it("an unreadable config file is treated like a missing one: defaults apply", async () => {
    mocks.readVaultFile.mockRejectedValue(new Error("IO"));
    mocks.loadKeybindings.mockResolvedValue(null);

    await loadKeymap(VAULT);

    expect(getOverrides()).toEqual({});
    expect(bindingsForCommand("edit.toggle-bold")).toEqual(["Mod-b"]);
  });

  it("a failed write is reported and the in-memory binding still takes effect", async () => {
    mocks.readVaultFile.mockResolvedValue(JSON.stringify({}));
    await loadKeymap(VAULT);
    mocks.writeVaultFile.mockRejectedValueOnce(new Error("EACCES"));

    await setOverride("edit.toggle-bold", "Mod-Shift-b", "notes");

    // The keystroke that was just captured must work now; only persistence
    // failed, so the user gets a toast instead of a silent revert.
    expect(bindingsForCommand("edit.toggle-bold", "notes")).toEqual(["Mod-Shift-b"]);
    expect(useAppStore.getState().toast).toContain("保存快捷键失败");
  });

  it("a failed migration leaves the legacy table alone, so the next startup can try again", async () => {
    mocks.readVaultFile.mockResolvedValue(null);
    mocks.loadKeybindings.mockResolvedValue({ "edit.toggle-bold": "Mod-b" });
    mocks.writeVaultFile.mockRejectedValue(new Error("read-only vault"));

    await loadKeymap(VAULT);

    expect(mocks.saveKeybindings).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toContain("迁移快捷键配置失败");
  });
});

describe("the override table", () => {
  it("a value equal to the default is not written as an override", async () => {
    mocks.readVaultFile.mockResolvedValue(JSON.stringify({}));
    await loadKeymap(VAULT);

    await setOverride("edit.toggle-bold", "Mod-b", "notes");

    // Writing the default back would make the settings page claim a change
    // that is not there, and would pin the key if the default later moves.
    expect(getOverrides()).toEqual({});
    expect(bindingsForCommand("edit.toggle-bold")).toEqual(["Mod-b"]);
  });

  it("rebinding the same command in another region leaves the first region untouched", async () => {
    mocks.readVaultFile.mockResolvedValue(JSON.stringify({}));
    await loadKeymap(VAULT);

    await setOverride("study.pdf-next-page", "Ctrl-j", "reading");
    await setOverride("study.pdf-next-page", "Ctrl-k", "agent");

    expect(bindingsForCommand("study.pdf-next-page", "reading")).toEqual(["Ctrl-j"]);
    expect(bindingsForCommand("study.pdf-next-page", "agent")).toEqual(["Ctrl-k"]);
  });

  it("clearing one region removes the override there and keeps the other regions' overrides", async () => {
    mocks.readVaultFile.mockResolvedValue(JSON.stringify({}));
    await loadKeymap(VAULT);
    await setOverride("study.pdf-next-page", "Ctrl-j", "reading");
    await setOverride("study.pdf-next-page", "Ctrl-k", "agent");

    await clearOverride("study.pdf-next-page", "agent");

    // The agent region was only a copy of this command: dropping its override
    // leaves no binding there at all instead of inventing the reading default.
    expect(bindingsForCommand("study.pdf-next-page", "agent")).toEqual([]);
    expect(bindingsForCommand("study.pdf-next-page", "reading")).toEqual(["Ctrl-j"]);
  });

  it("clearing without a region drops the command from every region", async () => {
    mocks.readVaultFile.mockResolvedValue(JSON.stringify({}));
    await loadKeymap(VAULT);
    await setOverride("study.pdf-next-page", "Ctrl-j", "reading");
    await setOverride("study.pdf-next-page", "Ctrl-k", "agent");

    await clearOverride("study.pdf-next-page");

    // Every region's entry is gone, so only the reading region's built-in
    // defaults remain. An emptied region may stay as an empty map in memory;
    // serialization drops it, so the file never accumulates empty sections.
    expect(bindingsForCommand("study.pdf-next-page")).toEqual(["PageDown", "ArrowRight"]);
    expect(flattenOverrides(getOverrides())).toEqual({});
    const written = JSON.parse(serializeOverrides(getOverrides())) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["_hint"]);
  });

  it("a reload re-reads the file: an external edit takes effect without a restart", async () => {
    mocks.readVaultFile.mockResolvedValue(JSON.stringify({}));
    await loadKeymap(VAULT);
    expect(bindingsForCommand("edit.toggle-bold")).toEqual(["Mod-b"]);

    mocks.readVaultFile.mockResolvedValue(
      JSON.stringify({ notes: { "edit.toggle-bold": "Mod-Shift-b" } }),
    );
    await reloadKeymap();

    expect(bindingsForCommand("edit.toggle-bold")).toEqual(["Mod-Shift-b"]);
  });

  it("without a vault the legacy app config is the only source, and rebinds are written there", async () => {
    mocks.loadKeybindings.mockResolvedValue({ "edit.toggle-bold": "Mod-Shift-b" });
    await loadKeymap(null);

    expect(mocks.readVaultFile).not.toHaveBeenCalled();
    expect(bindingsForCommand("edit.toggle-bold")).toEqual(["Mod-Shift-b"]);

    await setOverride("edit.toggle-italic", "Mod-Shift-i-extra", "notes");

    expect(mocks.writeVaultFile).not.toHaveBeenCalled();
    expect(mocks.saveKeybindings).toHaveBeenCalled();
    const calls = mocks.saveKeybindings.mock.calls;
    expect(calls[calls.length - 1]?.[0]).toMatchObject({
      "edit.toggle-italic": "Mod-Shift-i-extra",
    });
  });

  it("the config file path follows the vault, and there is none without one", () => {
    expect(keybindingsFilePath("/vaults/a")).toBe("/vaults/a/.bnote/keybindings.json");
    expect(keybindingsFilePath(null)).toBeNull();
  });
});

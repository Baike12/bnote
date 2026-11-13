import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { readClipboardText, setClipboardOverrides, writeClipboardText } from "./clipboard";

/**
 * Clipboard access has three layers: an injected test override, the Tauri
 * clipboard plugin, and `navigator.clipboard` for the browser harness. The
 * fallback order is the contract; a failure in one layer must not surface as a
 * rejected promise in the editor.
 */

beforeEach(() => {
  invokeMock.mockReset();
  setClipboardOverrides(null);
});

afterEach(() => {
  setClipboardOverrides(null);
  vi.unstubAllGlobals();
});

describe("test overrides", () => {
  it("read and write go through the injected functions", async () => {
    const read = vi.fn(async () => "override");
    const write = vi.fn(async () => true);
    setClipboardOverrides({ read, write });

    await expect(readClipboardText()).resolves.toBe("override");
    await expect(writeClipboardText("text")).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("text");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("the Tauri plugin path", () => {
  it("reads text through the plugin command", async () => {
    invokeMock.mockResolvedValue("hello");
    await expect(readClipboardText()).resolves.toBe("hello");
    expect(invokeMock).toHaveBeenCalledWith("plugin:clipboard-manager|read_text");
  });

  it("writes text through the plugin command with the `text` field", async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(writeClipboardText("hello")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("plugin:clipboard-manager|write_text", {
      text: "hello",
    });
  });
});

describe("the navigator fallback (browser harness / no Tauri IPC)", () => {
  it("reads when the plugin is unavailable", async () => {
    invokeMock.mockRejectedValue(new Error("no tauri"));
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn(async () => "from navigator") },
    });
    await expect(readClipboardText()).resolves.toBe("from navigator");
  });

  it("writes when the plugin is unavailable", async () => {
    invokeMock.mockRejectedValue(new Error("no tauri"));
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(writeClipboardText("out")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("out");
  });

  it("returns null / false when both layers fail", async () => {
    invokeMock.mockRejectedValue(new Error("no tauri"));
    vi.stubGlobal("navigator", {
      clipboard: {
        readText: vi.fn(async () => {
          throw new Error("denied");
        }),
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    await expect(readClipboardText()).resolves.toBeNull();
    await expect(writeClipboardText("out")).resolves.toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  readFile: vi.fn(async (path: string) => `content:${path}`),
  writeFile: vi.fn(async () => {}),
  readDir: vi.fn(async () => [] as Array<{ name: string; kind: string }>),
}));
const store = vi.hoisted(() => ({
  state: {
    vaultPath: "/vault",
    settings: { daily: { template: "" as string } },
    showToast: vi.fn(),
  },
}));

vi.mock("@/lib/tauri", () => ({ api }));
vi.mock("@/state/appStore", () => ({ useAppStore: { getState: () => store.state } }));

import { dailyTemplatePath, runtimeDeps, tauriIO } from "./runtime";

/**
 * The daily engine is pure; this module is its only IO edge. A missing file
 * is a normal first run (null), not an error, and the runtime reads settings
 * live so a template change applies to the next daily note without a restart.
 */

describe("tauriIO", () => {
  it("reads/writes through the vault commands", async () => {
    await expect(tauriIO.readFile("/vault/Daily/2026-11-13.md")).resolves.toBe(
      "content:/vault/Daily/2026-11-13.md",
    );
    await tauriIO.writeFile("/vault/Daily/2026-11-13.md", "x");
    expect(api.writeFile).toHaveBeenCalledWith("/vault/Daily/2026-11-13.md", "x");
  });

  it("folds a failed read into null (no previous note)", async () => {
    api.readFile.mockRejectedValueOnce("No such file");
    await expect(tauriIO.readFile("/vault/Daily/none.md")).resolves.toBeNull();
  });

  it("lists only files of the Daily directory", async () => {
    api.readDir.mockResolvedValueOnce([
      { name: "2026-11-12.md", kind: "file" },
      { name: "sub", kind: "dir" },
      { name: "2026-11-11.md", kind: "file" },
    ]);
    await expect(tauriIO.readDir("Daily")).resolves.toEqual(["2026-11-12.md", "2026-11-11.md"]);
    expect(api.readDir).toHaveBeenCalledWith("Daily");
  });

  it("folds a missing directory into null", async () => {
    api.readDir.mockRejectedValueOnce("No such directory");
    await expect(tauriIO.readDir("Daily")).resolves.toBeNull();
  });
});

describe("dailyTemplatePath", () => {
  it("normalizes the configured template path", () => {
    store.state.settings.daily.template = "Templates//Daily/";
    expect(dailyTemplatePath()).toBe("Templates/Daily");
  });

  it("is null when unset or when the path escapes the vault", () => {
    store.state.settings.daily.template = "";
    expect(dailyTemplatePath()).toBeNull();
    store.state.settings.daily.template = "../outside";
    expect(dailyTemplatePath()).toBeNull();
  });
});

describe("runtimeDeps", () => {
  it("reads the vault, the clock, the toast and the template live", () => {
    store.state.vaultPath = "/vault";
    store.state.settings.daily.template = "Templates";
    const deps = runtimeDeps();

    expect(deps.io).toBe(tauriIO);
    expect(deps.vaultRoot()).toBe("/vault");
    expect(deps.templatePath()).toBe("Templates");
    expect(deps.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    store.state.vaultPath = "/other";
    expect(deps.vaultRoot()).toBe("/other");

    deps.toast("saved");
    expect(store.state.showToast).toHaveBeenCalledWith("saved");
  });
});

import { describe, expect, it, vi } from "vitest";

const order: string[] = [];
const destroy = vi.hoisted(() =>
  vi.fn(async () => {
    order.push("destroy");
  }),
);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy }),
}));
vi.mock("@/editor/cursorMemory", () => ({
  flushCursorSave: () => order.push("cursor"),
}));
vi.mock("@/daily/links", () => ({
  flushLinksPersist: () => order.push("links"),
}));
vi.mock("@/footprint/store", () => ({
  flushFootprintsPersist: () => order.push("footprints"),
}));
vi.mock("@/state/appStore", () => ({
  flushPersistConfig: () => order.push("config"),
}));

import { quitApp } from "./quit";

/**
 * The native terminate path would drop the debounced writes held in JS, so
 * quitting must flush all four stores before the window is destroyed. The
 * order matters: `destroy` triggers the process exit the moment it resolves.
 */

describe("quitApp", () => {
  it("flushes every debounced store before destroying the window", () => {
    order.length = 0;
    destroy.mockClear();

    quitApp();

    expect(order).toEqual(["cursor", "config", "links", "footprints", "destroy"]);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

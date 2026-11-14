import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `openNoteByPath` is the seam that lets a leaf module (the footprint
 * extension) navigate without importing the app layer, which would make
 * `footprint → app/actions → editor/setup → footprint` circular. The
 * "nobody registered" state is part of the contract: a bare editor in a test
 * shell calls the signal, and that must be a silent no-op.
 */

type Navigation = typeof import("./navigation");

async function freshNavigation(): Promise<Navigation> {
  vi.resetModules();
  return import("./navigation");
}

beforeEach(() => {
  vi.resetModules();
});

describe("navigation signal", () => {
  it("does nothing when no opener is registered", async () => {
    const navigation = await freshNavigation();
    expect(() => navigation.openNoteByPath("/v/a.md")).not.toThrow();
  });

  it("routes a click to the registered opener with the line number", async () => {
    const navigation = await freshNavigation();
    const calls: [string, number | undefined][] = [];
    navigation.registerNoteOpener((path, line) => calls.push([path, line]));

    navigation.openNoteByPath("/v/a.md", 12);
    navigation.openNoteByPath("/v/b.md");

    expect(calls).toEqual([
      ["/v/a.md", 12],
      ["/v/b.md", undefined],
    ]);
  });

  it("registering again replaces the opener (the app registers once)", async () => {
    const navigation = await freshNavigation();
    const first = vi.fn();
    const second = vi.fn();
    navigation.registerNoteOpener(first);
    navigation.registerNoteOpener(second);

    navigation.openNoteByPath("/v/a.md");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("/v/a.md", undefined);
  });
});

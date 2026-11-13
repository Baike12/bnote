import { afterEach, beforeEach, vi } from "vitest";
import { fakeVault } from "./fakeVault";

/**
 * Setup for the integration project.
 *
 * The mocked boundary is the same one production uses: `@/lib/tauri`. Modules
 * therefore keep their real imports and their real control flow; only the
 * bytes on the other side of IPC are in memory.
 */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  // The fake implements the observable API surface, not every generic helper;
  // the cast is confined to this test seam.
  return { ...actual, api: fakeVault.api as unknown as typeof actual.api };
});

/** jsdom has no layout engine; the geometry APIs used by the runtime are harmless no-ops. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub });
}

if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (typeof document.elementFromPoint !== "function") {
  Object.defineProperty(document, "elementFromPoint", {
    value: () => document.body,
  });
}

if (typeof window.scrollTo !== "function") {
  Object.defineProperty(window, "scrollTo", { value: () => {} });
}

beforeEach(() => {
  fakeVault.reset();
  localStorage.clear();
  document.body.replaceChildren();
  document.title = "";
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

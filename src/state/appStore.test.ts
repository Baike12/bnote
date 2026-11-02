import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({ api: {} }));

import { useAppStore } from "./appStore";

/**
 * Request semantics of "focus sidebar" (⌘I): a one-shot ticket, not a history
 * counter.
 *
 * A counter (tick++) would be read as "a freshly arrived request" whenever the
 * sidebar remounts — collapsing with ⌘\ and expanding again would steal the
 * editor's focus. A ticket resets to zero once consumed, so a remounted
 * sidebar only ever sees "no request".
 */

const request = () => useAppStore.getState().sidebarFocusRequest;

beforeEach(() => {
  useAppStore.setState({ sidebarOpen: false, sidebarFocusRequest: null });
});

describe("settings defaults", () => {
  it("select-to-translate is disabled by default", () => {
    expect(useAppStore.getState().settings.studyTranslate.enabled).toBe(false);
  });
});

describe("focusSidebar request", () => {
  it("on press it opens the sidebar and leaves a ticket to be consumed", () => {
    useAppStore.getState().focusSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(request()).not.toBe(null);
  });

  it("consuming resets it to zero: a remounted sidebar sees no historic request", () => {
    useAppStore.getState().focusSidebar();
    useAppStore.getState().clearSidebarFocus();
    expect(request()).toBe(null);
  });

  it("pressing again after a consume still yields a fresh ticket", () => {
    useAppStore.getState().focusSidebar();
    useAppStore.getState().clearSidebarFocus();
    useAppStore.getState().focusSidebar();
    expect(request()).not.toBe(null);
    // The ticket only carries "is there a pending request"; the number itself
    // takes no part in the decision
    expect(typeof request()).toBe("number");
  });

  it("pressing again without a consume does not lose the request", () => {
    useAppStore.getState().focusSidebar();
    const first = request();
    useAppStore.getState().focusSidebar();
    expect(request()).not.toBe(null);
    expect(request()).not.toBe(first);
  });

  it("consuming without a request is a no-op (no extra state write)", () => {
    let writes = 0;
    const unsub = useAppStore.subscribe(() => {
      writes++;
    });
    useAppStore.getState().clearSidebarFocus();
    expect(writes).toBe(0);
    unsub();
  });
});

describe("toggleSidebar (the mouse path of the top bar button)", () => {
  it("collapse→expand only opens and closes, it produces no focus ticket", () => {
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(request()).toBe(null);
  });

  it("expand→collapse does not touch the ticket either; an unconsumed ticket is not lost because of it", () => {
    useAppStore.getState().focusSidebar();
    const first = request();
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(false);
    expect(request()).toBe(first);
  });
});

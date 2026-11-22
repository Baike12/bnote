import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sidebar store's view state. The fold map is the one piece the user edits
 * directly, and it has one writer (this store) so the row's `aria-expanded`,
 * the section's toggle-all and the persisted copy cannot disagree.
 */

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

const { useProjectSidebarStore } = await import("./projectSidebarStore");

const COLLAPSED_KEY = "bnote-codeProjectsCollapsed";

beforeEach(() => {
  storage.clear();
  useProjectSidebarStore.setState({ collapsed: {}, sectionCollapsed: false });
});

describe("expandGroup", () => {
  it("reveals one folded group and keeps the rest folded", () => {
    useProjectSidebarStore.setState({ collapsed: { "/a": true, "/b": true } });
    useProjectSidebarStore.getState().expandGroup("/a");
    expect(useProjectSidebarStore.getState().collapsed).toEqual({ "/b": true });
    expect(JSON.parse(storage.get(COLLAPSED_KEY) ?? "{}")).toEqual({ "/b": true });
  });

  it("an already expanded group is not a write", () => {
    const collapsed = { "/a": true };
    useProjectSidebarStore.setState({ collapsed });
    useProjectSidebarStore.getState().expandGroup("/c");
    expect(useProjectSidebarStore.getState().collapsed).toBe(collapsed);
    expect(storage.has(COLLAPSED_KEY)).toBe(false);
  });

  it("expanding the last folded group clears the persisted map", () => {
    useProjectSidebarStore.setState({ collapsed: { "/a": true } });
    useProjectSidebarStore.getState().expandGroup("/a");
    expect(useProjectSidebarStore.getState().collapsed).toEqual({});
    expect(storage.has(COLLAPSED_KEY)).toBe(false);
  });
});

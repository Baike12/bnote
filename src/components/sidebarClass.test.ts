import { describe, expect, it } from "vitest";
import { readAllCss } from "@/styles/cssSource";
import { readFileSync } from "node:fs";

/**
 * The top level class of the sidebar must not be called .sidebar.
 *
 * The CSS of Excalidraw (DrawingCanvas) contains an unscoped
 * `.sidebar{padding:0; position:absolute; top:0; ...}`; after the canvas has
 * been opened once that CSS stays in the page and overrides this one, the
 * sidebar ends up on top of the macOS traffic lights (observed). This gate
 * locks in "the component uses its own class name + the stylesheet does not
 * define a bare .sidebar anymore + the sidebar renders on the right, where no
 * traffic-light clearance rule is needed for it".
 */
const css = readAllCss().replace(/\/\*[\s\S]*?\*\//g, "");
const sidebarTsx = readFileSync("src/components/Sidebar.tsx", "utf8");
const appTsx = readFileSync("src/App.tsx", "utf8");

describe("sidebar class name isolated from third-party CSS", () => {
  it("the component uses its own class name app-sidebar", () => {
    expect(sidebarTsx).toMatch(/className="app-sidebar"/);
  });

  it("the stylesheet does not define a bare .sidebar (it would be overridden by Excalidraw)", () => {
    expect(css).not.toMatch(/(^|\n)\s*\.sidebar\s*\{/);
    // The app's own rule must still exist (Excalidraw's .sidebar is absolute
    // at the window's top-left).
    expect(css).toMatch(/\.app-sidebar\s*\{[^}]*display:\s*flex/);
  });

  it("the sidebar renders right of the main area", () => {
    // `{main}` must come first: the tree is the notes' right-hand column now,
    // so the traffic-light clearance rules keyed on the sidebar being leftmost
    // are gone with it.
    const mainAt = appTsx.indexOf("{main}");
    const sidebarAt = appTsx.indexOf("sidebarOpen && vaultPath && <Sidebar />");
    expect(mainAt).toBeGreaterThan(-1);
    expect(sidebarAt).toBeGreaterThan(mainAt);
    expect(css).not.toContain(".app:has(> .app-sidebar)");
  });
});

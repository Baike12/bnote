import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * The top level class of the sidebar must not be called .sidebar.
 *
 * The CSS of Excalidraw (DrawingCanvas) contains an unscoped
 * `.sidebar{padding:0; position:absolute; top:0; ...}`; after the canvas has
 * been opened once that CSS stays in the page and overrides this one, the
 * sidebar ends up on top of the macOS traffic lights (observed). This gate
 * locks in "the component uses its own class name + global.css does not
 * define a bare .sidebar anymore + the :has selector follows".
 */
const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const sidebarTsx = readFileSync("src/components/Sidebar.tsx", "utf8");

describe("侧栏类名与第三方 CSS 隔离", () => {
  it("组件用专属类名 app-sidebar", () => {
    expect(sidebarTsx).toMatch(/className="app-sidebar"/);
  });

  it("global.css 不定义裸 .sidebar(会被 Excalidraw 覆盖)", () => {
    expect(css).not.toMatch(/(^|\n)\s*\.sidebar\s*\{/);
    expect(css).toMatch(/\.app-sidebar\s*\{[^}]*padding-top:\s*30px/);
  });

  it(":has 选择器跟随新类名", () => {
    expect(css).toContain(".app:has(> .app-sidebar)");
  });
});

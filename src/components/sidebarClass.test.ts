import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * 侧栏顶层类名不能叫 .sidebar。
 *
 * Excalidraw(DrawingCanvas)的 CSS 里有一条未加作用域的
 * `.sidebar{padding:0; position:absolute; top:0; ...}`;打开过画布之后那份 CSS
 * 常驻页面并覆盖这里,侧栏会顶到 macOS 红绿灯上(实测现象)。这条门禁锁住
 * 「组件用专属类名 + global.css 不再定义裸 .sidebar + :has 选择器跟随」。
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

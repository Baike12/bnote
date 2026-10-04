import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * 主题体系门禁：bnote 的颜色唯一来源是 global.css 的 CSS 变量（:root = dark，
 * [data-theme="light"] 整套覆盖）。这里锁四件事：
 *
 * 1. light 必须覆盖 dark 的每一个主题变量——新增颜色只给 dark 一套会挂；
 * 2. 规则体内不许出现裸 hex/rgba——颜色字面量只许活在变量定义里，否则
 *    light 模式下那一处永远停在 dark 配色（回归过：搜索高亮、行内代码）；
 * 3. HighlightStyle（markdown.ts）的每个 color 都走 var()——语法高亮跟随主题
 *    靠它，写死 hex 会静默退回单主题；
 * 4. 应用接线：applySettingsToEditor 是 data-theme 的唯一写入者并镜像
 *    localStorage（theme-boot.js 启动防闪读同一个 key）。
 */

const readSrc = (rel: string): string => readFileSync(rel, "utf8");

const globalCss = readSrc("src/styles/global.css");
const markdownTs = readSrc("src/editor/markdown.ts");
const actionsTs = readSrc("src/app/actions.ts");
const indexHtml = readSrc("index.html");
const themeBootJs = readSrc("public/theme-boot.js");

/** 纯几何/字体变量，两主题共享，light 无需覆盖。 */
const GEOMETRIC_VARS = new Set([
  "--font-ui",
  "--font-text",
  "--font-mono",
  "--editor-font-size",
  "--content-line-width",
  "--content-pad-x",
  "--li-base",
  "--li-step",
  "--li-gap",
]);

/** 剥掉块注释再解析——注释文本里提到变量名/颜色不该影响判断。 */
const css = globalCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出选择器全部块的完整花括号体（文件里有多个 :root 块；CSS 无嵌套，数括号即可）。 */
function blockBodies(cssText: string, header: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = cssText.indexOf(header, from);
    if (start < 0) break;
    from = start + header.length;
    const open = cssText.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < cssText.length; i++) {
      if (cssText[i] === "{") depth++;
      else if (cssText[i] === "}") {
        depth--;
        if (depth === 0) {
          bodies.push(cssText.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return bodies;
}

function customProps(body: string): Set<string> {
  return new Set([...body.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
}

describe("主题变量体系", () => {
  const darkBlock = [...blockBodies(css, ":root {"), ...blockBodies(css, ":root{")].join(
    "\n",
  );
  const lightBlock = blockBodies(css, '[data-theme="light"] {').join("\n");

  it("global.css 里两个主题块都存在", () => {
    expect(darkBlock).not.toBe("");
    expect(lightBlock).not.toBe("");
  });

  it("light 覆盖 dark 的全部主题变量（几何/字体豁免）", () => {
    const dark = [...customProps(darkBlock)].filter((v) => !GEOMETRIC_VARS.has(v));
    const light = customProps(lightBlock);
    const missing = dark.filter((v) => !light.has(v));
    expect(missing, `light 主题缺这些变量: ${missing.join(", ")}`).toEqual([]);
    // 反向也不许多：light 里冒出来的名字必然对应 dark 的一个变量
    const extra = [...light].filter((v) => !dark.includes(v));
    expect(extra, `light 主题多出 dark 没有的变量: ${extra.join(", ")}`).toEqual([]);
  });

  it("规则体不含裸颜色字面量（颜色只从变量来）", () => {
    // 规则体 = 非 :root / 非 light 块之外的全部内容。变量定义行豁免；
    // var(…, fallback) 里的字面量豁免（变量缺失时才生效，常态死分支）。
    const rules = css
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    let stripped = rules.replace(/var\([^()]*\)/g, "");
    while (stripped.includes("var(")) {
      stripped = stripped.replace(/var\([^()]*\)/g, "");
    }
    const bare = stripped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\s*\(/g) ?? [];
    expect(bare, `规则体里出现裸颜色: ${bare.join(", ")}`).toEqual([]);
  });
});

describe("语法高亮跟随主题", () => {
  it("HighlightStyle 的每个 color 都走 var()", () => {
    const colors = [...markdownTs.matchAll(/color:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(colors.length).toBeGreaterThan(10);
    const bad = colors.filter((c) => !c.startsWith("var("));
    expect(bad, `写死 hex 的 token 颜色: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("主题应用接线", () => {
  it("applySettingsToEditor 是 data-theme 唯一写入者，并镜像 localStorage", () => {
    expect(actionsTs).toMatch(/applyTheme\(settings\.theme\)/);
    expect(actionsTs).toMatch(/dataset\.theme/);
    expect(actionsTs).toMatch(/localStorage\.setItem\("bnote\.theme"/);
  });

  it("theme-boot.js 被 index.html 引用且读同一个 key（启动防闪）", () => {
    expect(indexHtml).toMatch(/theme-boot\.js/);
    expect(themeBootJs).toMatch(/localStorage\.getItem\("bnote\.theme"/);
  });
});

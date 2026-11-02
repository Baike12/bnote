import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * Theme gate: the only source of color in bnote is the CSS variables in
 * global.css (:root = dark theme, [data-theme="light"] overrides the whole
 * set). Four rules are locked here:
 *
 * 1. The light theme must override every dark theme variable - a new color
 *    that only exists for the dark theme fails the gate;
 * 2. No bare hex/rgba in rule bodies - color literals may only live in
 *    variable definitions, otherwise that one spot stays on the dark palette
 *    in light mode (regressed before: search highlight, inline code);
 * 3. Every HighlightStyle (markdown.ts) color goes through var() - that is
 *    how syntax highlighting follows the theme, a hardcoded hex silently
 *    falls back to a single theme;
 * 4. Application wiring: applySettingsToEditor is the only writer of
 *    data-theme and mirrors localStorage (theme-boot.js reads the same key
 *    to prevent the startup flash).
 */

const readSrc = (rel: string): string => readFileSync(rel, "utf8");

const globalCss = readSrc("src/styles/global.css");
const markdownTs = readSrc("src/editor/markdown.ts");
const actionsTs = readSrc("src/app/actions.ts");
const indexHtml = readSrc("index.html");
const themeBootJs = readSrc("public/theme-boot.js");

/** Pure geometry/font variables, shared by both themes; light need not override them. */
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

/** Strip block comments before parsing - variable names or colors mentioned in
 *  comment text must not influence the verdict. */
const css = globalCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** Extract the full brace body of every block matching a selector (the file has
 *  several :root blocks; CSS has no nesting, so counting braces is enough). */
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

/**
 * Remove every `var(...)` call (including its fallback, fallbacks with nested
 * parens such as `var(--x, rgba(0,0,0,.2))`). Historical defect: stripping them
 * with a `var\([^()]*\)` regex in a loop matched nothing on every pass once the
 * fallback contained function parens, so the replace was a no-op that spun
 * forever and hung the gate test. Bracket-pair scanning replaces it: a single
 * pass, and an unclosed call cannot loop either.
 */
function stripVarCalls(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s.startsWith("var(", i)) {
      let depth = 0;
      let j = i + 3; // points at the `(` of var(; the start itself counts toward depth
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= s.length) break; // unclosed var(: the rest cannot be a valid rule body either
      i = j + 1;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

function customProps(body: string): Set<string> {
  return new Set([...body.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
}

describe("theme variable system", () => {
  const darkBlock = [...blockBodies(css, ":root {"), ...blockBodies(css, ":root{")].join(
    "\n",
  );
  const lightBlock = blockBodies(css, '[data-theme="light"] {').join("\n");

  it("both theme blocks exist in global.css", () => {
    expect(darkBlock).not.toBe("");
    expect(lightBlock).not.toBe("");
  });

  it("light overrides every dark theme variable (geometry/font are exempt)", () => {
    const dark = [...customProps(darkBlock)].filter((v) => !GEOMETRIC_VARS.has(v));
    const light = customProps(lightBlock);
    const missing = dark.filter((v) => !light.has(v));
    expect(missing, `light 主题缺这些变量: ${missing.join(", ")}`).toEqual([]);
    // Nor may it have extra names: a name that shows up only in light must
    // correspond to a dark theme variable.
    const extra = [...light].filter((v) => !dark.includes(v));
    expect(extra, `light 主题多出 dark 没有的变量: ${extra.join(", ")}`).toEqual([]);
  });

  it("rule bodies contain no bare color literals (colors only come from variables)", () => {
    // Rule body = everything outside the :root / light blocks. Variable definition
    // lines are exempt; literals inside var(..., fallback) are exempt too (they
    // only take effect when the variable is missing, i.e. a dead branch).
    const rules = css
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    const stripped = stripVarCalls(rules);
    const bare = stripped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\s*\(/g) ?? [];
    expect(bare, `规则体里出现裸颜色: ${bare.join(", ")}`).toEqual([]);
  });

  it("stripVarCalls strips a fallback with nested parens and never loops", () => {
    // Regression for the historical defect: the regex loop spun forever on
    // var(--x, rgba(...)).
    expect(stripVarCalls("a var(--x, rgba(0, 0, 0, 0.2)) b")).toBe("a  b");
    expect(stripVarCalls("var(--a, var(--b, #fff)) c")).toBe(" c");
    expect(stripVarCalls("color: var(--accent);")).toBe("color: ;");
    // Unclosed: drop the rest instead of trying to match again (prevents spinning)
    expect(stripVarCalls("x var(--unclosed tail")).toBe("x ");
    expect(stripVarCalls("no vars here")).toBe("no vars here");
  });
});

describe("always-on cursor", () => {
  it("global.css turns off the blink animation of the .cm-cursorLayer shared by the normal and vim cursors", () => {
    // CM6's normal cursor layer and vim's block cursor layer both carry this class,
    // and the plugin restarts the blink with inline animation-name/duration
    // values, so the rule must carry !important.
    expect(css).toMatch(/\.cm-cursorLayer\s*\{[^}]*animation:\s*none\s*!important;/);
  });
});

describe("syntax highlighting follows the theme", () => {
  it("every color of the HighlightStyle goes through var()", () => {
    const colors = [...markdownTs.matchAll(/color:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(colors.length).toBeGreaterThan(10);
    const bad = colors.filter((c) => !c.startsWith("var("));
    expect(bad, `写死 hex 的 token 颜色: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("theme application wiring", () => {
  it("applySettingsToEditor is the only writer of data-theme and mirrors localStorage", () => {
    expect(actionsTs).toMatch(/applyTheme\(settings\.theme\)/);
    expect(actionsTs).toMatch(/dataset\.theme/);
    expect(actionsTs).toMatch(/localStorage\.setItem\("bnote\.theme"/);
  });

  it("theme-boot.js is referenced by index.html and reads the same key (no flash on startup)", () => {
    expect(indexHtml).toMatch(/theme-boot\.js/);
    expect(themeBootJs).toMatch(/localStorage\.getItem\("bnote\.theme"/);
  });
});

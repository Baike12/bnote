import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Settings-row layout gate. The Agent model page put three selects into one
 * row; each kept the single-control width (`.setting-control .settings-select-wrap
 * { width: 260px }`) while the row refused to wrap, so the control ran 780px
 * wide: the label was squeezed to one character per line and the selects were
 * painted past the card border. These rules are what keeps that class of bug
 * out; a later edit that restores a fixed control width fails here instead of
 * in the running app.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const css = readFileSync(resolve(root, "src/styles/global.css"), "utf8");

/** The declarations of one rule, with whitespace normalised. */
function rule(selector: string): string {
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "g",
  );
  const blocks = [...css.matchAll(pattern)].map((m) => m[1].replace(/\s+/g, " ").trim());
  if (blocks.length === 0) throw new Error(`missing rule: ${selector}`);
  return blocks.join(" ");
}

describe("settings rows keep room for the label", () => {
  it("a row wraps instead of squeezing its text", () => {
    expect(rule(".setting-row")).toMatch(/flex-wrap: wrap/);
  });

  it("the text has a basis, so it never collapses to single characters", () => {
    expect(rule(".setting-row-text")).toMatch(/flex: 1 1 \d+px/);
    expect(rule(".setting-row-text")).toMatch(/min-width: 0/);
  });

  it("the control may shrink and wrap", () => {
    const control = rule(".setting-control");
    expect(control).toMatch(/flex: 0 1 auto/);
    expect(control).toMatch(/flex-wrap: wrap/);
    expect(control).toMatch(/min-width: 0/);
  });
});

describe("the provider/model/level picker shares its row", () => {
  it("its selects stretch instead of keeping the 260px single-control width", () => {
    const wrap = rule(".agent-selection .settings-select-wrap");
    expect(wrap).toMatch(/flex: 1 1 0/);
    expect(wrap).toMatch(/width: auto/);
    expect(wrap).toMatch(/min-width: 0/);
    expect(wrap).toMatch(/max-width: none/);
  });

  it("the picker itself can shrink inside the control", () => {
    const selection = rule(".agent-selection");
    expect(selection).toMatch(/display: flex/);
    expect(selection).toMatch(/min-width: 0/);
    expect(selection).toMatch(/max-width: 100%/);
  });
});

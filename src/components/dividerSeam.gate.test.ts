import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural gate for the seam rule (docs/TESTING.md, "The seam rule"): a
 * component that passes measured DOM geometry into a propagation model must
 * go through the model module's seam functions — the divider-drag incident
 * shipped exactly the raw-call form this forbids, and both sides were
 * self-consistent so every per-side test stayed green.
 *
 * Reads the sources like `layering.test.ts` does; no component rendering.
 */

const componentsDir = path.resolve(__dirname);
const rawCall = /\b(dragLeftEdge|dragMiddleEdge|dragSideEdge|dragDailyEdge)\s*\(/;

function layoutSources(dir = componentsDir, rel = ""): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const relPath = path.join(rel, name);
    if (fs.statSync(file).isDirectory()) {
      out.push(...layoutSources(file, relPath));
    } else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) {
      out.push({ file: relPath, text: fs.readFileSync(file, "utf8") });
    }
  }
  return out;
}

describe("divider seam gate", () => {
  const sources = layoutSources();

  it("no component calls the drag model directly — only the seam functions", () => {
    for (const { file, text } of sources) {
      expect(rawCall.test(text), `${file} calls the drag model raw`).toBe(false);
    }
  });

  it("every layout that drags a divider uses the seam functions", () => {
    const layouts = sources.filter((s) => s.text.includes("startSplitDrag"));
    expect(layouts.length).toBeGreaterThanOrEqual(3);
    for (const { file, text } of layouts) {
      expect(text, `${file} drags dividers but bypasses the seams`).toMatch(
        /leftDividerWidths\(|middleDividerWidth\(|sideDividerWidth\(|dailyDividerWidth\(|projectsDividerWidth\(/,
      );
    }
  });

  it("the seam functions exist in the model module and own the call shape", () => {
    const model = fs.readFileSync(path.resolve(__dirname, "../study/layoutModel.ts"), "utf8");
    expect(model).toMatch(/export function leftDividerWidths\(/);
    expect(model).toMatch(/export function middleDividerWidth\(/);
    // The seams are the only exported wrappers of the raw model.
    for (const { file, text } of sources) {
      if (/\bleftDividerWidths\(|\bmiddleDividerWidth\(/.test(text)) {
        expect(text, `${file} imports the raw model alongside the seam`).not.toMatch(
          /import\s*\{[^}]*\bdrag(Left|Middle)Edge\b[^}]*\}\s*from/,
        );
      }
    }
  });
});

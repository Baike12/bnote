import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The macOS traffic lights (overlay title bar) cover the top-left 78px of the
 * window. Which column reaches that corner is not fixed: the focused swap
 * (`.agent-focused`, driven by mainColumn) moves the content column to
 * `order: 0`. The clearance must follow the order, never stay on the
 * assistant header - otherwise the code toolbar's first buttons (file tree /
 * diff / terminal) sit under the traffic lights in code mode (observed).
 */
const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const studyLayout = readFileSync("src/components/study/StudyLayout.tsx", "utf8");
const codeLayout = readFileSync("src/components/code/CodeLayout.tsx", "utf8");

describe("traffic-light clearance follows the leftmost column", () => {
  it("the assistant header yields while the assistant is leftmost", () => {
    expect(css).toMatch(
      /\.study-layout:not\(\.agent-focused\)\s+\.agent-header\s*\{[^}]*padding-left:\s*var\(--study-lead/,
    );
  });

  it("the content headers yield once the focused swap moves them to the far left", () => {
    expect(css).toMatch(
      /\.study-layout\.agent-focused\s+\.content-toolbar[^{]*\{[^}]*padding-left:\s*var\(--study-lead/,
    );
    expect(css).toMatch(
      /\.study-layout\.agent-focused\s+\.code-toolbar[^{]*\{[^}]*padding-left:\s*var\(--study-lead/,
    );
  });

  it("both three-column layouts emit the class the swap rules are keyed on", () => {
    expect(studyLayout).toMatch(/agent-focused/);
    expect(codeLayout).toMatch(/agent-focused/);
  });
});

/**
 * The focused swap moves the two panes between columns; the **column** widths
 * must not move with them. Each column keeps its width and the pane that lands
 * in it is resized to it, so the three columns (and the notes column) stay
 * exactly where they were.
 */
describe("the focused swap keeps the column widths, not the pane widths", () => {
  const ruleOf = (selector: string): string => {
    for (const block of css.split("}")) {
      const at = block.lastIndexOf("{");
      if (at < 0) continue;
      if (block.slice(0, at).trim() === selector) return block.slice(at + 1);
    }
    throw new Error(`${selector} 规则消失`);
  };

  it("the pane that moves left takes the left column's width", () => {
    expect(ruleOf(".study-layout.agent-focused .content-pane")).toMatch(
      /width:\s*var\(--agent-w\)/,
    );
  });

  it("the pane that moves to the middle takes the middle column's width", () => {
    const rule = ruleOf(".study-layout.agent-focused .study-left");
    expect(rule).toMatch(/flex:\s*0 0 var\(--content-w\)/);
    expect(rule).toMatch(/width:\s*var\(--content-w\)/);
  });

  it("dragging follows the same rule: a divider edits its two columns, whichever pane sits there", () => {
    for (const layout of [studyLayout, codeLayout]) {
      expect(layout).toMatch(/dragLeftEdge\(/);
      expect(layout).toMatch(/dragMiddleEdge\(/);
      // No "swap the roles of the widths while swapped" mapping: that was the
      // pane-width model (each pane dragging its own width around).
      expect(layout).not.toMatch(/swapped\s*\?\s*widths\./);
      expect(layout).not.toMatch(/widths\.(agent|content)/);
    }
  });
});

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

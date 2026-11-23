import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The middle column of study mode holds a parsed PDF / a live native web page.
 * Re-mounting it (the old behavior: leaving study mode unmounted the whole
 * layout) re-reads the file and reloads the page, and the reading position, the
 * SPA route and whatever was playing are gone — reported as "switching back
 * means opening it again". So the layout is **parked** while another shape owns
 * the window: still mounted, laid out at the real size, invisible.
 *
 * jsdom has no layout and no native child webview, so the model cannot be
 * observed from a unit test; these source facts are what keep it standing.
 */
const app = readFileSync("src/App.tsx", "utf8");
const studyLayout = readFileSync("src/components/study/StudyLayout.tsx", "utf8");
const contentPane = readFileSync("src/components/study/ContentPane.tsx", "utf8");
const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("study mode is parked, not unmounted", () => {
  it("App renders the study layout outside the shape branch", () => {
    expect(app).toMatch(/<StudyLayout parked=\{mode !== "study"\} \/>/);
  });

  it("the content column is not behind the parked switch", () => {
    // The assistant column, both dividers and the notes column are study-mode
    // furniture; the content column is the one that has to keep its instance
    // across a shape switch.
    expect(studyLayout.match(/\{parked \? null :/g)?.length).toBe(4);
    expect(studyLayout).toMatch(/\{creativeMode \? <CreativePreview \/> : <ContentPane \/>\}/);
  });

  it("parking keeps the geometry and hides the native page", () => {
    // display:none would collapse the reader to a zero-size container and
    // reflow the PDF; the native page paints above the DOM, so it is hidden
    // through the backend whenever study mode is not the shape on screen.
    expect(css).toMatch(
      /\.study-layout\.parked\s*\{[^}]*position:\s*absolute[^}]*visibility:\s*hidden/,
    );
    expect(css).not.toMatch(/\.study-layout\.parked\s*\{[^}]*display:\s*none/);
    expect(contentPane).toMatch(
      /const studyOnScreen = useAppStore\(\(s\) => s\.mode === "study"\)/,
    );
  });
});

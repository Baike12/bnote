import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Gate for the scroll chain of the study assistant.
 *
 * Root cause (2026-10-26): `.agent-panel` is a child of a column flex
 * (`.study-left`), where `min-height: auto` resolves to the content's
 * minimum height. As soon as the conversation got long the panel grew to the
 * content height and overflowed the page, `.agent-scroll`'s clientHeight was
 * permanently equal to its scrollHeight, `overflow-y: auto` had nothing to
 * scroll, and the wheel did nothing while the input box was pushed out of
 * the window.
 *
 * A node test without DOM cannot measure pixels, so both ends of the chain
 * are locked here: the panel must be allowed to shrink (min-height: 0) and
 * the message area must be the only vertical scroll container.
 */
const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const rule = (selector: string): string => {
  // Parse by rule block instead of by a line-anchored regex: the dividers
  // share one style, and with a selector list written as
  // `.study-resizer,\n.projects-resizer {` the line-anchored regex misses it.
  for (const block of css.split("}")) {
    const at = block.lastIndexOf("{");
    if (at < 0) continue;
    const selectors = block
      .slice(0, at)
      .split(",")
      .map((s: string) => s.trim());
    if (selectors.includes(selector)) return block.slice(at + 1);
  }
  expect(null, `${selector} 规则消失`).not.toBeNull();
  return "";
};

describe("agent panel scroll layout", () => {
  it("the panel can shrink inside the column flex (min-height: 0)", () => {
    expect(rule(".agent-panel")).toMatch(/min-height:\s*0/);
  });

  it("the message area is the vertical scroll container", () => {
    const scroll = rule(".agent-scroll");
    expect(scroll).toMatch(/overflow-y:\s*auto/);
    expect(scroll).toMatch(/flex:\s*1/);
  });

  it("no visible gap between the two columns: the divider occupies only 1px, the hit area is widened by a pseudo element", () => {
    expect(rule(".study-resizer")).toMatch(/flex:\s*0 0 1px/);
    expect(rule(".study-resizer::after")).toMatch(/left:\s*-4px/);
    expect(rule(".study-resizer::after")).toMatch(/right:\s*-4px/);
  });

  it("both dividers of the projects view share the study mode geometry (only 1px, no layout widening)", () => {
    expect(rule(".projects-resizer")).toMatch(/flex:\s*0 0 1px/);
    expect(rule(".projects-resizer::after")).toMatch(/left:\s*-4px/);
    expect(rule(".projects-resizer::after")).toMatch(/right:\s*-4px/);
  });

  it("the agent top and the PDF top bar share the same colour (bg0), not the panel grey", () => {
    expect(rule(".agent-panel")).toMatch(/background:\s*var\(--bg0\)/);
    expect(rule(".agent-header")).toMatch(/background:\s*var\(--bg0\)/);
  });
});

/**
 * Gate for the study assistant header (session switch and auxiliary session bar).
 *
 * Root cause (2026-10-30): the session switch used a native `<select>`,
 * which in WKWebView is the system grey pill in the system font and not the
 * same language as the middle column's "file name = materials dropdown"; the
 * auxiliary session bar pushed the whole summary of the parent session into
 * the "back" button (flex-shrink: 0), a colored band filled the entire row
 * and the source text was squeezed to a few characters. The new shape is
 * locked here: a custom button plus popover, a narrow bar with the same
 * background as the header, and a fixed-width back button.
 */
describe("study assistant header: session switch and auxiliary session bar", () => {
  const panelSrc = readFileSync("src/components/agent/AgentPanel.tsx", "utf8");
  const headerSrc = readFileSync("src/components/agent/AgentHeader.tsx", "utf8");
  // Only the code is searched: a comment saying "no native <select>" is documentation, not a violation.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the session switch does not use a native <select> (the system control does not match the project UI)", () => {
    expect(code(panelSrc)).not.toMatch(/<select/);
    expect(code(headerSrc)).not.toMatch(/<select/);
    expect(panelSrc).toMatch(/<AgentHeader/);
    expect(headerSrc).toMatch(/agent-conv-pop/);
  });

  it("the title button and the middle column materials dropdown share the same geometry: 26px tall, transparent background, background only on hover", () => {
    const button = rule(".agent-conv-btn");
    expect(button).toMatch(/height:\s*26px/);
    expect(button).toMatch(/background:\s*transparent/);
    expect(rule(".agent-conv-btn.open")).toMatch(/background:\s*var\(--bg3\)/);
    expect(rule(".content-title-btn.open")).toMatch(/background:\s*var\(--bg3\)/);
  });

  it("an overlong session title is ellipsised and does not squeeze out the right buttons", () => {
    const title = rule(".agent-conv-title");
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(title).toMatch(/white-space:\s*nowrap/);
    // The three header buttons (3 x 26 + 2 x 8 = 94) need that much room:
    // reserve less and in a narrow window it is the icon itself that gets
    // squeezed.
    expect(rule(".agent-conv")).toMatch(/max-width:\s*calc\(100% - 110px\)/);
    expect(rule(".agent-header .icon-btn")).toMatch(/flex:\s*0 0 auto/);
  });

  it("the auxiliary session bar shares the header background, the two blocks draw only one bottom border", () => {
    expect(rule(".agent-aux-bar")).toMatch(/background:\s*var\(--bg0\)/);
    expect(rule(".agent-aux-bar")).not.toMatch(/color-mix/);
    expect(rule(".agent-header:has(+ .agent-aux-bar)")).toMatch(/border-bottom:\s*none/);
  });

  it("the back button has a fixed width, the source summary is the only elidable part", () => {
    expect(rule(".agent-aux-back")).toMatch(/flex:\s*0 0 auto/);
    const based = rule(".agent-aux-based");
    // min-width: 0 is the precondition for ellipsis (a flex item is stretched by its content's minimum width by default).
    expect(based).toMatch(/min-width:\s*0/);
    expect(based).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("the history drawer makes room for the auxiliary bar and does not cover the source or the back button", () => {
    expect(rule(".agent-panel:has(.agent-aux-bar) .agent-history")).toMatch(
      /top:\s*calc\(var\(--study-head-h\) \+ 30px\)/,
    );
  });
});

/**
 * Gate for the conversation font size.
 *
 * Root cause (2026-10-30): the panel body was hard-coded to 13.5px, the
 * assistant column is only a few hundred pixels wide and a long answer read
 * blurry, while the middle column could be zoomed and the assistant column
 * could not. The body text is now derived from `--agent-text` (a 15px base
 * times the `--agent-fs` written by the "Aa" button in the header), and all
 * body-level text multiplies it; the header and the auxiliary bar are the
 * outer frame and keep fixed pixels.
 */
describe("study assistant: adjustable conversation font size", () => {
  const panelSrc = readFileSync("src/components/agent/AgentPanel.tsx", "utf8");

  it("the body base is not below 14px (13.5px is the too small that this fixes)", () => {
    const panel = rule(".agent-panel");
    expect(panel).toMatch(/--agent-body:\s*15px/);
    expect(panel).toMatch(/--agent-fs:\s*1/);
    expect(panel).toMatch(/--agent-text:\s*calc\(var\(--agent-body\) \* var\(--agent-fs\)\)/);
  });

  it("all body-level text multiplies --agent-text (one change cannot miss the messages or the input box)", () => {
    for (const selector of [
      ".agent-msg",
      ".agent-md",
      ".agent-thinking-body",
      ".agent-tool",
      ".agent-input",
    ]) {
      expect(rule(selector)).toMatch(
        /font-size:\s*(var\(--agent-text\)|calc\(var\(--agent-text\) \* [\d.]+\))/,
      );
    }
    // Multi-line selector (the heading group) and the single-line h1
    // override: the rule block parser cannot get the first line of a
    // multi-line selector, so the source is queried directly.
    expect(css).toMatch(/\.agent-md h6 \{\n[^}]*font-size: var\(--agent-text\)/);
    // The top level heading is one step larger than the body, still derived from it
    expect(css).toMatch(/\.agent-md h1 \{ font-size: calc\(var\(--agent-text\) \* 1\.1\); \}/);
  });

  it("the scale value is written by the panel root element (single writer), the control lives in the header", () => {
    expect(panelSrc).toMatch(/--agent-fs/);
    expect(panelSrc).toMatch(/agentFontScale/);
    expect(rule(".agent-font-pop")).toMatch(/position:\s*absolute/);
    expect(rule(".agent-font-value")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

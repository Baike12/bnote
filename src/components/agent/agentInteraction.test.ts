import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Gates for the agent panel's collapsible work section and its approval dock.
 *
 * Root cause (2026-11-08): the turn's work section, its thinking block and its
 * tool cards are nested native <details>. React dispatches a descendant's
 * toggle event to ancestor onToggle handlers, so the work section's handler
 * read the CHILD's open state and wrote it to itself: collapsing one tool
 * collapsed the whole section, and reopening revealed every previously opened
 * child at once. A descendant CSS selector (`.agent-turn-work[open]
 * .agent-tool-chevron`) also spun every tool chevron when the section opened,
 * reading as "all tools expanded". The approval / question cards were a
 * centered modal overlay instead of sitting above the input box.
 *
 * A node test without DOM cannot click details, so the invariants are locked
 * at the source: one writer per open state, the chevron rotation scoped to its
 * own summary, and the cards in normal flow above the composer (ZCode's bottom
 * dock). The live click-through is verified in the browser harness.
 */
const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const transcript = readFileSync("src/components/agent/Transcript.tsx", "utf8");
const panel = readFileSync("src/components/agent/AgentPanel.tsx", "utf8");

const rule = (selector: string): string => {
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

describe("turn work section: one writer per open state", () => {
  /** The work section's own toggle handler, from its opening to the next `}}`. */
  const toggleHandler = (): string => {
    const start = transcript.indexOf("onToggle={(e) => {");
    return transcript.slice(start, transcript.indexOf("}}", start) + 2);
  };

  it("the section's own toggle is the only writer of its open state, through the rule module", () => {
    // React walks the fiber tree for onToggle, so a child details' toggle also
    // reaches this handler; `own` separates the two. What each kind does
    // (descendant vs own, echo of our own write vs the user's click) is the
    // rule module `./turnWork.ts`, unit-tested in turnWork.test.ts.
    const handler = toggleHandler();
    expect(handler).toMatch(/own: e\.target === e\.currentTarget/);
    expect(handler).toMatch(/applySectionToggle\(/);
    expect(handler.match(/setSection/g)).toHaveLength(1);
  });

  it("the streaming → done edge decides through openWhenSettled", () => {
    // The collapse, the user's own choice and a turn with nothing but work to
    // read are one rule; writing the boolean inline here is how the rules drift
    // apart (the echo bug of 2026-11-23 lived in this handler).
    expect(transcript).toMatch(/openWhenSettled\(current, turn, answer\)/);
  });
});

describe("chevron rotation is scoped to its own summary", () => {
  it("the work section rotates only its own chevron, not every tool chevron", () => {
    expect(rule(".agent-turn-work[open] > summary .agent-tool-chevron")).toMatch(
      /transform:\s*rotate\(90deg\)/,
    );
    // The unscoped descendant selector is the bug: it matched every tool
    // chevron inside an open section.
    expect(css).not.toMatch(/\.agent-turn-work\[open\]\s+\.agent-tool-chevron/);
  });

  it("a tool chevron rotates only when that tool is open", () => {
    expect(rule(".agent-tool[open] .agent-tool-chevron")).toMatch(/transform:\s*rotate\(90deg\)/);
  });
});

describe("approval / question cards sit above the composer (ZCode's bottom dock)", () => {
  it("the card wrapper is a normal-flow dock item, not a centered modal overlay", () => {
    const wrapper = rule(".agent-approval");
    expect(wrapper).not.toMatch(/position:\s*absolute/);
    expect(wrapper).not.toMatch(/inset:/);
    expect(wrapper).toMatch(/flex-shrink:\s*0/);
  });

  it("the card spans the column and scrolls inside a bounded height", () => {
    const card = rule(".agent-approval-card");
    expect(card).not.toMatch(/max-width:\s*420px/);
    expect(card).toMatch(/max-height:\s*min\(60vh,\s*420px\)/);
    expect(card).toMatch(/overflow:\s*auto/);
  });

  it("both cards render before the composer, exactly once (not as a trailing overlay)", () => {
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, "");
    const composerAt = code.indexOf('className="agent-composer"');
    const approvalAt = code.indexOf("<AgentApprovalCard");
    const questionAt = code.indexOf("<AgentQuestionCard");
    expect(composerAt).toBeGreaterThan(-1);
    expect(approvalAt).toBeGreaterThan(-1);
    expect(questionAt).toBeGreaterThan(-1);
    expect(approvalAt).toBeLessThan(composerAt);
    expect(questionAt).toBeLessThan(composerAt);
    // Exactly one mount each: a second copy after the composer would reintroduce
    // the overlay.
    expect(code.split("<AgentApprovalCard").length).toBe(2);
    expect(code.split("<AgentQuestionCard").length).toBe(2);
  });
});

describe("a send while the previous turn is still generating", () => {
  it("tells the user instead of returning silently", () => {
    // Root cause (2026-11-12): after a stop, the next message was accepted by
    // the backend, whose model request then failed and retried invisibly. The
    // panel stayed on "generating", and `send()` returned without a word when
    // the user pressed Enter again — the only feedback-free path in the panel.
    const send = panel.slice(panel.indexOf("async function send()"));
    const guardAt = send.indexOf("if (busyRef.current === info)");
    expect(guardAt).toBeGreaterThan(-1);
    const guard = send.slice(guardAt, send.indexOf("return;", guardAt));
    expect(guard).toMatch(/showToast\(/);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Anchoring gate for full-bleed overlays (the "scrim covers the whole window"
 * class). The defect: a `position: absolute; inset: 0` overlay whose nearest
 * positioned ancestor is not the container the design meant — the containing
 * block silently becomes the initial containing block (the window). It shipped
 * four times (.invest-kline, .invest-import-scrim, .invest-toast,
 * .code-overlay), each time with all per-side tests green, because nothing
 * reads the CSS anchoring relationship.
 *
 * jsdom has no layout engine, so no unit layer can measure a containing block.
 * This gate enforces the source-level half of the rule; the measured half
 * (scrim rect === layout rect) lives in e2e/specs/investLayout.e2e.ts.
 *
 * Two mechanisms:
 * 1. ANCHORED overlays must have a container that declares `position:
 *    relative/absolute/fixed` in the same stylesheet. Adding an overlay
 *    without registering its anchor fails here.
 * 2. The full-bleed inventory is a snapshot: any new `absolute` + `inset: 0`
 *    rule must be added to the snapshot and anchored explicitly — the gate
 *    turns "we added another overlay" into a required, reviewable decision
 *    instead of a silent recurrence. `position: fixed` overlays are excluded:
 *    the window IS their intended containing block.
 */

const css = fs.readFileSync(path.resolve(__dirname, "../styles/global.css"), "utf8");

/** selector → declarations, for top-level rules only (no @media nesting). */
function rules(): Map<string, string> {
  const text = css.replace(/\/\*.*?\*\//gs, "");
  const out = new Map<string, string>();
  for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = selector.trim();
    if (sel.startsWith("@")) continue;
    out.set(sel, body);
  }
  return out;
}

function positionOf(body: string): string | null {
  return (
    /(?:^|;)\s*position\s*:\s*(absolute|fixed|relative|sticky)\s*(?:;|$)/.exec(body)?.[1] ?? null
  );
}

/** True when the rule absolutely positions itself and spans its container. */
function isFullBleedOverlay(selector: string, body: string): boolean {
  if (positionOf(body) !== "absolute") return false;
  const spans = /(?:^|;)\s*inset\s*:\s*0/.test(body)
    ? true
    : ["top", "right", "bottom", "left"].every((side) =>
        new RegExp(`(?:^|;)\\s*${side}\\s*:\\s*0\\b`).test(body),
      );
  if (!spans) return false;
  // A ::before/::after is anchored by its originating element, so the
  // pseudo-element rules are inventory-tracked but anchored by construction.
  return !/::(before|after)$/.test(selector.trim());
}

/** overlay selector → the container that must declare a position. */
const ANCHORED: Record<string, string> = {
  ".invest-import-scrim": ".invest-layout",
  ".invest-toast": ".invest-layout",
  ".invest-kline-overlay": ".invest-kline",
  ".code-overlay": ".code-mode-content",
  // The parked study layout covers the main area while another shape owns the
  // window; it stays mounted so the PDF / web page keeps living (see
  // StudyLayout).
  ".study-layout.parked": ".main",
};

const KNOWN_FULL_BLEED: readonly string[] = [
  ".agent-read-guide",
  ".code-overlay",
  ".content-editor",
  ".content-empty",
  ".content-web",
  ".content-web-fail",
  ".creative-empty",
  ".daily-date-select",
  ".drawing-error",
  ".drawing-loading",
  ".invest-import-scrim",
  ".invest-kline-overlay",
  ".pdf-anno-layer",
  ".pdf-crop-layer",
  ".pdf-fail",
  ".pdf-page canvas",
  ".pdf-page-tint",
  ".pdf-read-guide",
  ".pdf-viewer",
  ".study-layout.parked",
];

describe("overlay anchoring gate", () => {
  const ruleMap = rules();

  it("every anchored overlay's container declares a position", () => {
    const broken: string[] = [];
    for (const [overlay, anchor] of Object.entries(ANCHORED)) {
      const body = ruleMap.get(anchor);
      const pos = body ? positionOf(body) : null;
      if (!pos || pos === "static") {
        broken.push(
          `${overlay} anchors at ${anchor}, which declares position: ${pos ?? "nothing"}`,
        );
      }
    }
    expect(
      broken,
      "an overlay lost its containing block — the scrim-over-the-window class",
    ).toEqual([]);
  });

  it("every registered overlay still exists (no stale registrations)", () => {
    const stale = Object.keys(ANCHORED).filter((sel) => !ruleMap.has(sel));
    expect(stale, "an anchored overlay no longer exists — update ANCHORED").toEqual([]);
  });

  it("the full-bleed inventory matches the snapshot (new overlays must register an anchor)", () => {
    const current = [...ruleMap]
      .filter(([sel, body]) => isFullBleedOverlay(sel, body))
      .map(([sel]) => sel)
      .sort();
    const snapshot = [...KNOWN_FULL_BLEED].sort();
    expect(
      current,
      "unregistered or removed full-bleed overlays — register the anchor in ANCHORED (with a real container or a rect-equality E2E) and update KNOWN_FULL_BLEED",
    ).toEqual(snapshot);
  });

  it("the scan sees real overlays (not silently nothing)", () => {
    expect(KNOWN_FULL_BLEED.length).toBeGreaterThanOrEqual(15);
    expect(ruleMap.get(".invest-layout") ?? "").toMatch(/position\s*:\s*relative/);
    expect(ruleMap.get(".code-mode-content") ?? "").toMatch(/position\s*:\s*relative/);
  });
});

import { readFileSync, existsSync } from "node:fs";
import { $, browser, expect } from "@wdio/globals";
import { CONFIG_FILE } from "../paths";

/**
 * Gesture E2E: the layout dividers, driven through real W3C pointer actions.
 *
 * This spec exists because of a shipped bug no other layer could see (2026-11:
 * the divider jumped to its clamp bounds on the first drag). The unit layer
 * locks the pure drag model; only a real pointer sequence proves the wiring —
 * React pointerdown → startSplitDrag → CSS variables → layout — and that the
 * panes actually follow the pointer. Geometry is asserted numerically, per the
 * browser-measured invariants protocol in docs/TESTING.md.
 */

const LEFT_DEFAULT = 280;
const CENTER_DEFAULT = 680;

async function paneWidth(selector: string): Promise<number> {
  return browser.execute((sel: string) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().width) : -1;
  }, selector);
}

async function contentVar(): Promise<string> {
  return browser.execute(() => {
    const host = document.querySelector<HTMLElement>(".invest-layout");
    return host ? host.style.getPropertyValue("--invest-content-src") : "";
  });
}

/** The floored center of an element in viewport coordinates — the driver's
 * coordinates are i32, a half-pixel center fails to deserialize. */
async function centerOf(selector: string): Promise<{ x: number; y: number }> {
  const rect = await browser.execute((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
  if (!rect) throw new Error(`${selector} is not in the DOM`);
  return { x: Math.floor(rect.x + rect.w / 2), y: Math.floor(rect.y + rect.h / 2) };
}

/** Waits until a pane's width has committed to `expected` — the drag ends when
 * the pointer comes up, but the layout commits through React state, so the
 * wait is on DOM state, never on a timer (the flake policy). */
async function waitWidth(pane: string, expected: number): Promise<void> {
  await browser.waitUntil(async () => (await paneWidth(pane)) === expected, {
    timeoutMsg: `the drag never committed: ${pane} is ${await paneWidth(
      pane,
    )}px, expected ${expected}px (window ${await browser.execute(
      () => window.innerWidth,
    )}px, var ${await contentVar()})`,
  });
}

/** Drags a divider by dx px with a real pointer sequence (down → moves → up),
 * then waits until `pane` has committed to the new width. */
async function dragDivider(
  selector: string,
  dx: number,
  pane: string,
  expected: number,
): Promise<void> {
  // The embedded WebKitWebDriver accepts only the "viewport" | "pointer"
  // origin members, not an element handle (an element origin fails to
  // deserialize) — so start from the handle's absolute center and drag
  // relative to the pointer. The resizer is 1px wide with a ±4px hit area
  // (::after), so its center is inside the hit area.
  const start = await centerOf(selector);
  await browser.performActions([
    {
      type: "pointer",
      id: "e2e-mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: "viewport", x: start.x, y: start.y },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 60 },
        { type: "pointerMove", origin: "pointer", x: dx, y: 0, duration: 120 },
        { type: "pause", duration: 120 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await waitWidth(pane, expected);
}

describe("invest layout dividers (gesture level)", () => {
  before(async () => {
    await browser.waitUntil(async () => await $(".app-sidebar").isExisting(), {
      timeoutMsg: "app never booted",
    });
    // Enter invest mode through the real command keybinding.
    await browser.keys(["Meta", "Alt", "i"]);
    await browser.waitUntil(async () => await $(".invest-layout").isExisting(), {
      timeoutMsg: "invest layout never appeared",
    });
  });

  it("renders the default three-column widths", async () => {
    await waitWidth(".invest-left", LEFT_DEFAULT);
    await waitWidth(".invest-center", CENTER_DEFAULT);
  });

  it("the middle divider follows the pointer (dx == width delta)", async () => {
    const before = await paneWidth(".invest-center");
    await dragDivider(".resizer-content", 120, ".invest-center", before + 120);
    // The stored preference was committed, not just painted during the drag.
    expect(await contentVar()).toBe(`${before + 120}px`);
  });

  it("the left divider transfers width between the adjacent columns (sum conserved)", async () => {
    const leftBefore = await paneWidth(".invest-left");
    const centerBefore = await paneWidth(".invest-center");
    await dragDivider(".resizer-agent", 80, ".invest-left", leftBefore + 80);
    const leftAfter = await paneWidth(".invest-left");
    const centerAfter = await paneWidth(".invest-center");
    expect(leftAfter + centerAfter).toBe(leftBefore + centerBefore);
  });

  it("the import scrim covers exactly the invest layout (anchoring contract)", async () => {
    // Full-bleed overlays are enforced by overlayAnchoring.gate.test.ts at the
    // source level; only a real layout engine can prove the containing block —
    // this is the browser-measured lock for the scrim-over-the-window class.
    await $('button[title^="导入标的"]').click();
    await browser.waitUntil(async () => await $(".invest-import-scrim").isExisting(), {
      timeoutMsg: "the import scrim never appeared",
    });
    const rects = await browser.execute(() => {
      const rect = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? el.getBoundingClientRect().toJSON() : null;
      };
      return { scrim: rect(".invest-import-scrim"), layout: rect(".invest-layout") };
    });
    expect(rects.scrim).not.toBeNull();
    expect(rects.layout).not.toBeNull();
    expect(rects.scrim).toEqual(rects.layout);
    // The commit is real: the width preference written by the drags above is
    // persisted to the isolated config.json, not just painted (the "assumed
    // covered" trap — an in-memory-only value would pass every UI assertion).
    await browser.waitUntil(
      () => {
        if (!existsSync(CONFIG_FILE)) return false;
        const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as {
          settings?: { investContentWidth?: number };
        };
        return cfg.settings?.investContentWidth !== undefined;
      },
      { timeoutMsg: "config.json never recorded investContentWidth" },
    );
    await $(".invest-import-close").click();
    await browser.waitUntil(async () => !(await $(".invest-import-scrim").isExisting()), {
      timeoutMsg: "the import scrim never closed",
    });
  });

  // The double-click reset is NOT spec'd here on purpose. The embedded
  // WebKitWebDriver synthesizes `click` but never `dblclick` — measured with
  // an event probe (2026-11-18): WebdriverIO's element.doubleClick(), a
  // hand-written two-click sequence, and a clickCount=2 press all produced
  // dblclick:0 (three gestures, same result — a driver limitation, not an
  // app bug; the app's click chain itself was proven live by the same probe
  // after the splitDrag preventDefault fix). The reset semantics walk
  // docs/DEPLOYED-CHECKS.md with a real double-click instead.
});

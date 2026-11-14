// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FootprintView } from "./view";
import { currentFold, flipGroupFold, flipZoneFold, foldSignature, FootprintWidget } from "./widget";

/**
 * The footprint zone widget is the only DOM the footprint aggregation draws, and
 * every interaction on it is routed through data-footprint-* attributes, so this
 * file locks the DOM contract instead of the pixels:
 *
 *  - the header states the day, the file count and the block count, and the
 *    historical archive never claims to be "today";
 *  - the zone and group arrows carry the action + path a click routes on, and a
 *    folded group keeps its header while hiding its blocks;
 *  - block HTML comes from renderBlockHtml, so a click target carries the source
 *    line to jump to;
 *  - `eq` compares the fold snapshot and the view identity, which is what keeps
 *    an unrelated repaint from redrawing the zone.
 *
 * The clock is pinned: the header title compares the widget day with today.
 */

const TODAY = "2026-09-30";
const SRC = "/vault/Job/job todo.md";
const OTHER = "/vault/研究/文献笔记.md";

const viewData: FootprintView = {
  groups: [
    {
      path: SRC,
      label: "job todo",
      blocks: [
        { text: "第一段正文", start: 3, end: 3 },
        { text: "## 小标题", start: 5, end: 5 },
      ],
    },
    { path: OTHER, label: "文献笔记", blocks: [{ text: "另一段", start: 1, end: 1 }] },
  ],
  fileCount: 2,
  blockCount: 3,
};

const fold = (over: { zoneCollapsed?: boolean; groups?: string[] } = {}) => ({
  zoneCollapsed: over.zoneCollapsed ?? false,
  groups: new Set(over.groups ?? []),
});

function head(el: HTMLElement): HTMLElement {
  return el.querySelector(".footprint-zone-head") as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 30, 10, 0, 0) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the zone header", () => {
  it("today's zone says 今日足迹 and states both counts", () => {
    const el = new FootprintWidget(TODAY, viewData, fold()).toDOM();
    const h = head(el);
    expect(h.className).toBe("footprint-zone-head");
    expect(h.dataset.footprintAction).toBe("toggle-zone");
    expect(h.textContent).toContain("今日足迹");
    expect(h.textContent).toContain("2 个文件");
    expect(h.textContent).toContain("3 段");
    expect(h.textContent?.startsWith("▾")).toBe(true);
  });

  it("a historical day is titled with its date, never as today", () => {
    const el = new FootprintWidget("2026-09-21", viewData, fold()).toDOM();
    const h = head(el);
    expect(h.textContent).toContain("2026-09-21 足迹");
    expect(h.textContent).not.toContain("今日足迹");
  });

  it("a collapsed zone shows the closed arrow and drops every group", () => {
    const el = new FootprintWidget(TODAY, viewData, fold({ zoneCollapsed: true })).toDOM();
    expect(head(el).textContent?.startsWith("▸")).toBe(true);
    expect(el.querySelectorAll(".footprint-group")).toHaveLength(0);
    // The head itself stays: it is the only way to unfold again
    expect(el.querySelector(".footprint-zone-head")).not.toBeNull();
  });

  it("an empty view still renders a header with zero counts", () => {
    const el = new FootprintWidget(
      TODAY,
      { groups: [], fileCount: 0, blockCount: 0 },
      fold(),
    ).toDOM();
    expect(head(el).textContent).toContain("0 个文件");
    expect(head(el).textContent).toContain("0 段");
    expect(el.querySelectorAll(".footprint-group")).toHaveLength(0);
  });
});

describe("the groups", () => {
  it("a group header carries the toggle-group action and its path, plus an open-group target on the name", () => {
    const el = new FootprintWidget(TODAY, viewData, fold()).toDOM();
    const groups = el.querySelectorAll<HTMLElement>(".footprint-group");
    expect(groups).toHaveLength(2);
    const heads = el.querySelectorAll<HTMLElement>(".footprint-group-head");
    expect(heads[0].dataset.footprintAction).toBe("toggle-group");
    expect(heads[0].dataset.footprintPath).toBe(SRC);
    const title = heads[0].querySelector<HTMLElement>(".footprint-group-title");
    expect(title?.dataset.footprintAction).toBe("open-group");
    expect(title?.dataset.footprintPath).toBe(SRC);
    expect(title?.textContent).toBe("《job todo》");
    expect(heads[0].querySelector(".footprint-group-count")?.textContent).toBe(" · 2 段");
    expect(heads[0].textContent?.startsWith("▾")).toBe(true);
  });

  it("a folded group keeps its header, shows the closed arrow and hides its blocks; its siblings stay open", () => {
    const el = new FootprintWidget(TODAY, viewData, fold({ groups: [SRC] })).toDOM();
    const heads = el.querySelectorAll<HTMLElement>(".footprint-group-head");
    expect(heads[0].textContent?.startsWith("▸")).toBe(true);
    expect(heads[1].textContent?.startsWith("▾")).toBe(true);
    expect(el.querySelectorAll(".footprint-block")).toHaveLength(1);
    expect(el.querySelector(".footprint-block")?.textContent).toContain("另一段");
  });
});

describe("the blocks", () => {
  it("each block is a click target carrying the source path and start line, with the rendered markdown inside", () => {
    const el = new FootprintWidget(TODAY, viewData, fold()).toDOM();
    const bodies = el.querySelectorAll<HTMLElement>(".footprint-block");
    expect(bodies).toHaveLength(3);
    expect(bodies[0].dataset.footprintAction).toBe("open-block");
    expect(bodies[0].dataset.footprintPath).toBe(SRC);
    expect(bodies[0].dataset.footprintLine).toBe("3");
    expect(bodies[2].dataset.footprintPath).toBe(OTHER);
    // The markdown rendering is the same one the daily note uses
    expect(bodies[1].innerHTML).toContain('class="md-heading md-h2"');
  });

  it("the block body does not re-render markdown escapes as HTML (renderBlockHtml owns escaping)", () => {
    const el = new FootprintWidget(
      TODAY,
      {
        groups: [
          { path: SRC, label: "job todo", blocks: [{ text: "<b>不是标签</b>", start: 1, end: 1 }] },
        ],
        fileCount: 1,
        blockCount: 1,
      },
      fold(),
    ).toDOM();
    const body = el.querySelector(".footprint-block") as HTMLElement;
    expect(body.innerHTML).not.toContain("<b>");
    expect(body.textContent).toContain("<b>不是标签</b>");
  });
});

describe("WidgetType protocol", () => {
  it("eq accepts the same view snapshot and fold, and rejects a different fold or view", () => {
    const a = new FootprintWidget(TODAY, viewData, fold());
    const same = new FootprintWidget(TODAY, viewData, fold());
    expect(a.eq(same)).toBe(true);
    expect(a.eq(new FootprintWidget(TODAY, viewData, fold({ zoneCollapsed: true })))).toBe(false);
    expect(a.eq(new FootprintWidget(TODAY, viewData, fold({ groups: [SRC] })))).toBe(false);
    expect(
      a.eq(new FootprintWidget(TODAY, { groups: [], fileCount: 0, blockCount: 0 }, fold())),
    ).toBe(false);
  });

  it("the fold signature is stable per snapshot and independent of group order", () => {
    expect(new FootprintWidget(TODAY, viewData, fold()).foldSigStr).toBe("Z");
    expect(new FootprintWidget(TODAY, viewData, fold({ zoneCollapsed: true })).foldSigStr).toBe(
      "z",
    );
    expect(new FootprintWidget(TODAY, viewData, fold({ groups: [SRC, OTHER] })).foldSigStr).toBe(
      new FootprintWidget(TODAY, viewData, fold({ groups: [OTHER, SRC] })).foldSigStr,
    );
  });

  it("ignoreEvent is false: the click has to reach the extension's mousedown router", () => {
    expect(new FootprintWidget(TODAY, viewData, fold()).ignoreEvent()).toBe(false);
  });
});

describe("the session fold state", () => {
  it("starts fully expanded and flips at the zone and group level", () => {
    const initial = currentFold();
    expect(initial.zoneCollapsed).toBe(false);
    expect(initial.groups.size).toBe(0);
    expect(foldSignature()).toBe("Z");

    flipZoneFold();
    expect(currentFold().zoneCollapsed).toBe(true);
    expect(foldSignature()).toBe("z");
    flipZoneFold();

    flipGroupFold(SRC);
    expect(currentFold().groups.has(SRC)).toBe(true);
    flipGroupFold(OTHER);
    expect(foldSignature()).toBe(`Z${[SRC, OTHER].sort().join(";")}`);
    flipGroupFold(SRC);
    expect(currentFold().groups.has(SRC)).toBe(false);
    flipGroupFold(OTHER);
    expect(currentFold().groups.size).toBe(0);
    expect(foldSignature()).toBe("Z");
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_WIDTH,
  DEFAULT_CONTENT_WIDTH,
  RESIZER_WIDTH,
  basePageWidth,
  contentWidthForRenderedPage,
  dragLeftEdge,
  dragMiddleEdge,
  minColumnWidth,
  normalizeAgentWidth,
  normalizeContentWidth,
  studySplitToContentWidth,
} from "./layoutModel";

describe("normalizeContentWidth", () => {
  it("an old config ratio is converted to pixels by the window width", () => {
    expect(normalizeContentWidth(0.44, 1400)).toBe(616);
  });

  it("a pixel width is kept as is, only the lower bound is clamped (10% of the layout width)", () => {
    expect(normalizeContentWidth(900, 1400)).toBe(900);
    expect(normalizeContentWidth(20, 1400)).toBe(minColumnWidth(1400));
  });

  it("bad data falls back to the default value", () => {
    expect(normalizeContentWidth(null, 1400)).toBe(DEFAULT_CONTENT_WIDTH);
    expect(normalizeContentWidth(NaN, 1400)).toBe(DEFAULT_CONTENT_WIDTH);
    expect(normalizeContentWidth(0, 1400)).toBe(DEFAULT_CONTENT_WIDTH);
  });
});

describe("studySplitToContentWidth", () => {
  it("an old three-column array takes the middle column width (the 2nd element)", () => {
    expect(studySplitToContentWidth([320, 620])).toBe(620);
    expect(studySplitToContentWidth([0.24, 0.44])).toBeCloseTo(0.44, 10);
  });

  it("a single value (already the new config) is returned unchanged", () => {
    expect(studySplitToContentWidth(620)).toBe(620);
  });

  it("returns null when there is no migratable value", () => {
    expect(studySplitToContentWidth(undefined)).toBeNull();
    expect(studySplitToContentWidth([320])).toBeNull();
    expect(studySplitToContentWidth([320, "x"] as unknown)).toBeNull();
  });
});

describe("normalizeAgentWidth", () => {
  it("a pixel width is kept as is, only the lower bound is clamped (10% of the layout width)", () => {
    expect(normalizeAgentWidth(360, 1400)).toBe(360);
    expect(normalizeAgentWidth(20, 1400)).toBe(minColumnWidth(1400));
  });

  it("bad data falls back to the default value", () => {
    expect(normalizeAgentWidth(undefined, 1400)).toBe(DEFAULT_AGENT_WIDTH);
    expect(normalizeAgentWidth(NaN, 1400)).toBe(DEFAULT_AGENT_WIDTH);
    expect(normalizeAgentWidth(0, 1400)).toBe(DEFAULT_AGENT_WIDTH);
  });
});

describe("minColumnWidth", () => {
  it("the minimum width of each column is 10% of the layout width", () => {
    expect(minColumnWidth(1400)).toBe(140);
    expect(minColumnWidth(900)).toBe(90);
  });

  it("returns 0 when the width is invalid", () => {
    expect(minColumnWidth(0)).toBe(0);
    expect(minColumnWidth(NaN)).toBe(0);
  });
});

describe("dragLeftEdge (left | middle: only the two adjacent columns move)", () => {
  const host = 1400;
  const sum = 320 + 620; // left + middle
  const min = minColumnWidth(host);

  it("the width moves between the left and middle columns, the notes column stays put", () => {
    const widths = dragLeftEdge(RESIZER_WIDTH + 400, host, sum);
    expect(widths.left).toBe(400);
    expect(widths.middle).toBe(sum - 400);
    // The total width of the two columns is unchanged -> the notes column width is unchanged.
    expect(widths.left + widths.middle).toBe(sum);
    expect(widths.right).toBe(host - RESIZER_WIDTH * 2 - sum);
  });

  it("dragging the line left: the middle column grows and the left column shrinks", () => {
    const widths = dragLeftEdge(RESIZER_WIDTH + 200, host, sum);
    expect(widths.left).toBe(200);
    expect(widths.middle).toBe(sum - 200);
    expect(widths.right).toBe(host - RESIZER_WIDTH * 2 - sum);
  });

  it("the left column stops at 10%", () => {
    const widths = dragLeftEdge(0, host, sum);
    expect(widths.left).toBe(min);
    expect(widths.middle).toBe(sum - min);
  });

  it("the middle column stops at 10%", () => {
    const widths = dragLeftEdge(host, host, sum);
    expect(widths.middle).toBe(min);
    expect(widths.left).toBe(sum - min);
  });

  it("when neither column can reach 10% (the window is too narrow) a compromise is taken", () => {
    const narrow = 400;
    const widths = dragLeftEdge(0, narrow, 300);
    expect(widths.left).toBeGreaterThan(0);
    expect(widths.middle).toBeGreaterThan(0);
    expect(widths.left + widths.middle).toBe(300);
  });
});

describe("dragMiddleEdge (middle | notes: only the two adjacent columns move)", () => {
  const host = 1400;
  const middleLeft = 320 + RESIZER_WIDTH;
  const min = minColumnWidth(host);

  it("the middle column width = the pointer position minus the resizer, the right column takes the rest", () => {
    const widths = dragMiddleEdge(middleLeft + RESIZER_WIDTH + 500, host, middleLeft);
    expect(widths.middle).toBe(500);
    expect(widths.right).toBe(host - middleLeft - RESIZER_WIDTH - 500);
  });

  it("the notes column stops at 10%", () => {
    const widths = dragMiddleEdge(host, host, middleLeft);
    expect(widths.right).toBe(min);
    expect(widths.middle).toBe(host - middleLeft - RESIZER_WIDTH - min);
  });

  it("the middle column stops at 10%", () => {
    const widths = dragMiddleEdge(0, host, middleLeft);
    expect(widths.middle).toBe(min);
  });

  it("the left column is unaffected (only the middle and notes columns are visible)", () => {
    const widths = dragMiddleEdge(middleLeft + RESIZER_WIDTH + 400, host, middleLeft);
    expect(widths.middle + widths.right + middleLeft + RESIZER_WIDTH).toBe(host);
  });
});

describe("basePageWidth", () => {
  it("without a crop it is the column width", () => {
    expect(basePageWidth(620, 1)).toBe(620);
    expect(basePageWidth(620, 0)).toBe(620);
  });

  it("when half the width is cropped, the full page must double in size for the visible part to reach the edge", () => {
    expect(basePageWidth(620, 0.5)).toBe(1240);
    expect(basePageWidth(620, 0.8)).toBeCloseTo(775, 5);
  });

  it("returns 0 when the column width is invalid", () => {
    expect(basePageWidth(0, 0.5)).toBe(0);
  });
});

describe("contentWidthForRenderedPage", () => {
  const base = {
    contentWidth: 620,
    pageWidth: 610,
    pageHeight: 610 * Math.SQRT2,
    availableHeight: 630,
    pageRatio: Math.SQRT2,
    cropHeight: 1,
    cropWidth: 1,
    minPageWidth: 220,
    maxPageWidth: 1600,
  };

  it("the width is derived from the real page height difference, so one page just fits", () => {
    const width = contentWidthForRenderedPage(base) as number;
    const fittedPage = base.pageWidth + (width - base.contentWidth);
    // The width is rounded, so the height error stays within 1px.
    expect(Math.abs(fittedPage * base.pageRatio - base.availableHeight)).toBeLessThanOrEqual(1);
  });

  it("when half the page is cropped, the same height difference needs twice the width", () => {
    const full = contentWidthForRenderedPage(base) as number;
    const cropped = contentWidthForRenderedPage({ ...base, cropHeight: 0.5 }) as number;
    const fullDelta = full - base.contentWidth;
    const cropDelta = cropped - base.contentWidth;
    expect(Math.abs(cropDelta - fullDelta * 2)).toBeLessThanOrEqual(1);
  });

  it("when the side whitespace is cropped, the middle column only carries the visible width share", () => {
    // The page is scaled by 1/0.8, so a 1px change of the full page width is only 0.8px of the content column.
    const pageWidth = base.pageWidth / 0.8;
    const pageHeight = pageWidth * base.pageRatio;
    const target = contentWidthForRenderedPage({
      ...base,
      pageWidth,
      pageHeight,
      cropWidth: 0.8,
    }) as number;
    const fittedPage = pageWidth + (target - base.contentWidth) / 0.8;
    expect(Math.abs(fittedPage * base.pageRatio - base.availableHeight)).toBeLessThanOrEqual(1);
  });

  it("when the page width hits the upper or lower limit, the middle column stops growing", () => {
    const maxed = contentWidthForRenderedPage({
      ...base,
      pageWidth: 1600,
      pageHeight: 100,
      availableHeight: 900,
    }) as number;
    expect(maxed).toBe(base.contentWidth);
    const mined = contentWidthForRenderedPage({
      ...base,
      pageWidth: 220,
      pageHeight: 3000,
      availableHeight: 600,
    }) as number;
    expect(mined).toBe(base.contentWidth);
  });

  it("returns null when the geometry is not ready", () => {
    expect(contentWidthForRenderedPage({ ...base, pageHeight: 0 })).toBeNull();
    expect(contentWidthForRenderedPage({ ...base, availableHeight: 0 })).toBeNull();
    expect(contentWidthForRenderedPage({ ...base, pageRatio: 0 })).toBeNull();
  });
});

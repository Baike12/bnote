import { beforeEach, describe, expect, it } from "vitest";
import {
  canFlipPdfPage,
  flipPdfPage,
  setAgentNavHandlers,
  setPdfNavHandlers,
  setWebNavHandlers,
} from "./pdfNav";

/**
 * The page-turn shortcut is a "configurable command": the command layer does
 * not know the concrete reader, it only asks the handlers registered here.
 * PDF and web each occupy one slot — when the content switches, each one's
 * cleanup must not clobber the other.
 */
describe("where the study mode page-turn commands land", () => {
  beforeEach(() => {
    setPdfNavHandlers(null);
    setWebNavHandlers(null);
    setAgentNavHandlers(null);
  });

  it("with no reader the page cannot turn and the call has no side effect", () => {
    expect(canFlipPdfPage()).toBe(false);
    expect(flipPdfPage(1)).toBe(false);
    expect(flipPdfPage(-1)).toBe(false);
  });

  it("after registration the reader's canFlip decides whether the page turns", () => {
    const calls: string[] = [];
    let allowed = true;
    setPdfNavHandlers({
      canFlip: () => allowed,
      prev: () => calls.push("prev"),
      next: () => calls.push("next"),
    });

    expect(canFlipPdfPage()).toBe(true);
    expect(flipPdfPage(1)).toBe(true);
    expect(flipPdfPage(-1)).toBe(true);
    expect(calls).toEqual(["next", "prev"]);

    // With the focus in an input, a dialog open or a selection in progress, the reader sets canFlip to false.
    allowed = false;
    expect(canFlipPdfPage()).toBe(false);
    expect(flipPdfPage(1)).toBe(false);
    expect(calls).toEqual(["next", "prev"]);
  });

  it("unloading the reader hands the handlers back", () => {
    setPdfNavHandlers({ canFlip: () => true, prev: () => {}, next: () => {} });
    setPdfNavHandlers(null);
    expect(canFlipPdfPage()).toBe(false);
  });

  it("the web reader takes over the same command set when there is no PDF reader", () => {
    const calls: string[] = [];
    setWebNavHandlers({
      canFlip: () => true,
      prev: () => calls.push("web-prev"),
      next: () => calls.push("web-next"),
    });
    expect(canFlipPdfPage()).toBe(true);
    expect(flipPdfPage(1)).toBe(true);
    expect(flipPdfPage(-1)).toBe(true);
    expect(calls).toEqual(["web-next", "web-prev"]);
  });

  it("when the content switches each clears its own slot: the web cleanup does not clear the just-mounted PDF", () => {
    const calls: string[] = [];
    const pdf = {
      canFlip: () => true,
      prev: () => calls.push("pdf-prev"),
      next: () => calls.push("pdf-next"),
    };
    setWebNavHandlers({
      canFlip: () => true,
      prev: () => calls.push("web-prev"),
      next: () => calls.push("web-next"),
    });
    setPdfNavHandlers(pdf);
    // Simulate the "web page unload" cleanup running after the PDF mounted: it only clears the web slot.
    setWebNavHandlers(null);
    expect(flipPdfPage(1)).toBe(true);
    expect(calls).toEqual(["pdf-next"]);
  });

  it("the focused assistant owns the key: its slot wins over the reader's, and withdrawing it hands the key back", () => {
    const calls: string[] = [];
    setPdfNavHandlers({
      canFlip: () => true,
      prev: () => calls.push("pdf-prev"),
      next: () => calls.push("pdf-next"),
    });
    setAgentNavHandlers({
      canFlip: () => true,
      prev: () => calls.push("agent-prev"),
      next: () => calls.push("agent-next"),
    });
    // Study mode with a PDF open: the focused assistant column is what ⌃J scrolls.
    expect(flipPdfPage(1)).toBe(true);
    expect(calls).toEqual(["agent-next"]);
    // Focus leaves the panel (focusout) -> the PDF reader takes the key back.
    setAgentNavHandlers(null);
    expect(flipPdfPage(-1)).toBe(true);
    expect(calls).toEqual(["agent-next", "pdf-prev"]);
  });
});

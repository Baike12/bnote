import { beforeEach, describe, expect, it } from "vitest";
import {
  canFlipPdfPage,
  flipPdfPage,
  setPdfNavHandlers,
  setWebNavHandlers,
} from "./pdfNav";

/**
 * The page-turn shortcut is a "configurable command": the command layer does
 * not know the concrete reader, it only asks the handlers registered here.
 * PDF and web each occupy one slot — when the content switches, each one's
 * cleanup must not clobber the other.
 */
describe("学习模式翻页命令的落点", () => {
  beforeEach(() => {
    setPdfNavHandlers(null);
    setWebNavHandlers(null);
  });

  it("没有阅读器时不可翻页,调用无副作用", () => {
    expect(canFlipPdfPage()).toBe(false);
    expect(flipPdfPage(1)).toBe(false);
    expect(flipPdfPage(-1)).toBe(false);
  });

  it("注册后由阅读器的 canFlip 决定是否翻页", () => {
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

  it("阅读器卸载后归还处理器", () => {
    setPdfNavHandlers({ canFlip: () => true, prev: () => {}, next: () => {} });
    setPdfNavHandlers(null);
    expect(canFlipPdfPage()).toBe(false);
  });

  it("网页阅读器没有 PDF 阅读器时接管同一组命令", () => {
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

  it("切换内容时各清各的槽位：网页的清理不会清掉刚挂载的 PDF", () => {
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
});

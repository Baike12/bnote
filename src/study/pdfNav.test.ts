import { beforeEach, describe, expect, it } from "vitest";
import { canFlipPdfPage, flipPdfPage, setPdfNavHandlers } from "./pdfNav";

/**
 * 翻页快捷键是「可配置命令」:命令层不认识 PdfViewer,只问这里注册的处理器。
 * 这个文件锁的是两者的契约——没有阅读器/阅读器说不该翻时,键必须原样放行。
 */
describe("PDF 翻页命令的落点", () => {
  beforeEach(() => setPdfNavHandlers(null));

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

    // 焦点在输入框、弹窗打开或正在框选时,阅读器把 canFlip 置 false。
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
});

/**
 * 可配置翻页快捷键的落点:PDF 阅读器 / 网页阅读器把自己的翻页函数注册进来,
 * 命令层只管调用,不认识具体阅读器。两种内容共用同一组命令与键位,但各占
 * 一个槽位:切换内容时各自的清理只归还自己那一份,不会把对方刚注册的覆盖掉。
 */
export interface PdfNavHandlers {
  /** 上下文是否允许翻页(框选进行中、弹窗打开时不行)。焦点的归属由命令分发层
   *  按按键是否带修饰键判断,这里不再重复。 */
  canFlip: () => boolean;
  prev: () => void;
  next: () => void;
}

let pdfHandlers: PdfNavHandlers | null = null;
let webHandlers: PdfNavHandlers | null = null;

export function setPdfNavHandlers(next: PdfNavHandlers | null): void {
  pdfHandlers = next;
}

export function setWebNavHandlers(next: PdfNavHandlers | null): void {
  webHandlers = next;
}

function activeHandlers(): PdfNavHandlers | null {
  // 同一时刻只有一种学习内容;PDF 优先只是防御两个槽位短暂并存。
  return pdfHandlers ?? webHandlers;
}

/** 命令的 `when`:没有阅读器、或上下文不允许翻页时,按键原样放行。 */
export function canFlipPdfPage(): boolean {
  const handlers = activeHandlers();
  return handlers !== null && handlers.canFlip();
}

export function flipPdfPage(delta: 1 | -1): boolean {
  const handlers = activeHandlers();
  if (!handlers || !handlers.canFlip()) return false;
  if (delta > 0) handlers.next();
  else handlers.prev();
  return true;
}

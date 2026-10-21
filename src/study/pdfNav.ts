/**
 * 可配置快捷键的落点:阅读器把自己的翻页函数注册进来,命令层只管调用,
 * 不认识 PdfViewer。同一时刻最多一个阅读器——挂载即占用,卸载即归还。
 */
export interface PdfNavHandlers {
  /** 上下文是否允许翻页(框选进行中、弹窗打开时不行)。焦点的归属由命令分发层
   *  按按键是否带修饰键判断,这里不再重复。 */
  canFlip: () => boolean;
  prev: () => void;
  next: () => void;
}

let handlers: PdfNavHandlers | null = null;

export function setPdfNavHandlers(next: PdfNavHandlers | null): void {
  handlers = next;
}

/** 命令的 `when`:没有阅读器、或上下文不允许翻页时,按键原样放行。 */
export function canFlipPdfPage(): boolean {
  return handlers !== null && handlers.canFlip();
}

export function flipPdfPage(delta: 1 | -1): boolean {
  if (!handlers || !handlers.canFlip()) return false;
  if (delta > 0) handlers.next();
  else handlers.prev();
  return true;
}

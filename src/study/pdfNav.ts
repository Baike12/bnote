/**
 * Where the configurable page-turn shortcut lands: the PDF reader / web reader
 * registers its own page-turn function here, and the command layer only
 * calls it without knowing the concrete reader. Both content kinds share the
 * same commands and keybindings but occupy one slot each: when the content
 * switches, each one's cleanup only returns its own slot and never overwrites
 * what the other just registered.
 */
export interface PdfNavHandlers {
  /** Whether the context allows turning the page (not while a selection is
   *  being made or a dialog is open). Which element owns the focus is decided
   *  by the command dispatch layer from the modifier keys, not repeated here. */
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
  // Only one kind of study content is active at a time; preferring PDF only defends against the two slots briefly coexisting.
  return pdfHandlers ?? webHandlers;
}

/** The command's `when`: with no reader, or when the context forbids turning the page, the key passes through unchanged. */
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

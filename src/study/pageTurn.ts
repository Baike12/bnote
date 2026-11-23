/**
 * Where the page-turn command lands: the column that sits in the middle of a
 * three-column layout.
 *
 * The middle column is the appStore's `mainColumn` — the pane the user works
 * in takes it (a click inside a column or the assistant's focusin), and it is
 * sticky, so moving to the notes column does not undo it. The same state
 * decides the layout's geometry and the key target, which is why they cannot
 * disagree.
 *
 * Each pane registers its own handler slot here and withdraws it on unmount;
 * the command layer only asks "can it turn" and "turn it", never which reader
 * is mounted. The content column of study mode (PDF / web page) and the
 * assistant conversation are targets. The code and invest content columns are
 * not: the code editor owns PageUp/PageDown natively, and the market chart has
 * its own keys — a page-turn there would steal them.
 */
import { hasThreeColumnLayout, useAppStore } from "@/state/appStore";

export interface PageTurnHandlers {
  /** Whether the context allows turning the page (not while a selection is
   *  being made or a dialog is open). */
  canFlip: () => boolean;
  prev: () => void;
  next: () => void;
}

/**
 * The column in the middle right now. Null when the middle column is not a
 * page-turn target: no three-column layout is on screen, or the code editor
 * (which pages itself) or the invest chart holds it.
 */
export function pageTurnTarget(): "agent" | "content" | null {
  const { mode, mainColumn } = useAppStore.getState();
  if (!hasThreeColumnLayout(mode)) return null;
  if (mainColumn === "agent") return "agent";
  return mode === "study" ? "content" : null;
}

// One slot per reader. The PDF and the web page coexist briefly while the
// content switches, so each cleanup only clears its own slot and never
// overwrites what the other just registered.
let pdfHandlers: PageTurnHandlers | null = null;
let webHandlers: PageTurnHandlers | null = null;
// The assistant panel registers on mount: "is it the middle column" is the
// resolver's question, not the registration's.
let agentHandlers: PageTurnHandlers | null = null;

export function setPdfPageTurn(handlers: PageTurnHandlers | null): void {
  pdfHandlers = handlers;
}

export function setWebPageTurn(handlers: PageTurnHandlers | null): void {
  webHandlers = handlers;
}

export function setAgentPageTurn(handlers: PageTurnHandlers | null): void {
  agentHandlers = handlers;
}

function activeHandlers(): PageTurnHandlers | null {
  // While an overlay (settings, command palette, quick switcher) is open the
  // columns are behind it: the global binding must not scroll them.
  if (useAppStore.getState().modal !== null) return null;
  switch (pageTurnTarget()) {
    case "agent":
      return agentHandlers;
    case "content":
      // Only one kind of study content is active at a time; preferring the PDF
      // only defends against the two slots briefly coexisting.
      return pdfHandlers ?? webHandlers;
    default:
      return null;
  }
}

/** The command's `when`: with no target, the key passes through unchanged. */
export function canTurnPage(): boolean {
  const handlers = activeHandlers();
  return handlers !== null && handlers.canFlip();
}

export function turnPage(delta: 1 | -1): boolean {
  const handlers = activeHandlers();
  if (!handlers || !handlers.canFlip()) return false;
  if (delta > 0) handlers.next();
  else handlers.prev();
  return true;
}

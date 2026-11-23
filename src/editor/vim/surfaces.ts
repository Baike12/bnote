import type { EditorView } from "@codemirror/view";
import { activeEditors } from "../api";

/**
 * Vim / IME surfaces outside the notes editor registry.
 *
 * The notes editors register themselves in `editor/api.ts` (`activeEditors`),
 * but that registry is also the command layer's target (`getView()`): every
 * command that saves or edits "the note" acts on whatever sits there. The
 * agent composer runs the same vim engine and must take part in the IME
 * intent, yet it must never become that command target — `:w` in the composer
 * still means the note, and a command must not write the prompt into a file.
 *
 * So the composer registers here instead. The rule the IME needs is only
 * "which editor holds the text focus", answered by DOM containment: a view
 * that does not contain `document.activeElement` has no say in the source.
 */

/** The one member of an editor this rule needs: its DOM root. */
export interface Surface {
  dom: { contains(other: Node | null): boolean };
}

/**
 * The surface holding `active`, or null. Cards and popups do not count: their
 * focus lives outside every editor root.
 *
 * Pure, so the containment rule is testable without a browser; the live
 * lookup (`focusedVimSurface`) is the two-line DOM wrapper around it.
 */
export function pickFocusedSurface<T extends Surface>(
  active: Node | null,
  surfaces: readonly T[],
): T | null {
  if (!active) return null;
  for (const surface of surfaces) {
    if (surface.dom.contains(active)) return surface;
  }
  return null;
}

/** Views registered besides the notes editors (the agent composer). */
const extra = new Set<EditorView>();

/** Registers a vim surface and returns its unregistration. */
export function registerVimSurface(view: EditorView): () => void {
  extra.add(view);
  return () => {
    extra.delete(view);
  };
}

/**
 * The editor that owns the text focus right now: a notes editor or a
 * registered surface. Null when the focus sits anywhere else (a button, a
 * dialog, or outside the window).
 */
export function focusedVimSurface(): EditorView | null {
  if (typeof document === "undefined") return null;
  return pickFocusedSurface(document.activeElement, [...activeEditors(), ...extra]);
}

import { getCommand, runCommand, type CommandDef } from "./registry";
import {
  commandsForKey,
  eventToKey,
  fixedPageCommandFor,
  formOwnsEditChord,
  isEditableTarget,
  isPlainFocusOwnedKey,
  type KeyRegion,
} from "./keys";
import { recordCommandChord } from "./lastChord";

/**
 * Command keybindings are dispatched at the window level (capture phase) so
 * they work everywhere — sidebar, modals, editor — mirroring Obsidian.
 * Set `recordingHotkey` while the settings UI captures a new binding.
 */
let recordingHotkey = false;

export function setHotkeyRecording(v: boolean) {
  recordingHotkey = v;
}

/**
 * When the canvas is open the app enters "canvas mode": the canvas carries a
 * whole set of its own bindings (tools 1-9, Alt+S to snap, ⌘D to duplicate,
 * ⌘Z to undo, ...), so window-level command dispatch must yield. A drawing is
 * still "a file" though, so Obsidian-style file switching must keep working:
 * only the quick switcher, the command palette and "open today's daily note"
 * are let through (switching away finalizes the canvas first, see
 * actions.openNote / finalizeDrawingSession).
 */
export type CommandKeyContext = "drawing" | null;

let keyContext: CommandKeyContext = null;

/**
 * While a modal (settings / command palette / quick switcher, ...) is open the
 * focus sits in the overlay's input, which belongs to none of the three
 * regions: only global commands are let through and every region binding
 * yields (otherwise ⌘⇧N inside the settings page would create an Agent
 * session behind the overlay).
 */
let modalOpen = false;

export function setKeyModalOpen(open: boolean): void {
  modalOpen = open;
}

const DRAWING_ALLOWED = new Set([
  "nav.quick-switcher",
  "nav.command-palette",
  "workspace.open-daily",
]);

export function setCommandKeyContext(ctx: CommandKeyContext) {
  keyContext = ctx;
}

/**
 * Focus regions. Each focusable region carries `data-key-region` in the DOM:
 * the reading region (ContentPane), the notes region (EditorPane) and the
 * Agent panel.
 *
 * Ownership only follows "where the user last acted": pointer down, focus
 * entry, wheel/touch scrolling all count, and the last one wins (single
 * writer = the four input events below).
 *
 * `document.activeElement` alone is not enough: the reading region (PDF /
 * web placeholder) deliberately does not take focus — giving the reader a
 * tabindex/focus makes WebKit's text selection anchor jump (see the keyboard
 * ownership comment in PdfViewer), so scrolling the page or clicking the body
 * never changes activeElement. When the focus sits in the Agent input or the
 * note editor the region is computed from that instead, and the reading
 * region's bindings (screenshot, region switch) would silently fall through
 * to another command or do nothing. Counting the wheel as "acting" follows
 * the same reasoning: scrolling a PDF is the main way of reading it, and
 * reading does not require clicking.
 */
const REGION_ATTR = "data-key-region";
export type FocusRegion = Exclude<KeyRegion, "global">;
/**
 * Fallback order: reading → project cards → notes → Agent.
 *
 * The reading region has top priority (it never takes focus, so it is the
 * safest pick when nothing owns the keyboard), and project comes before
 * notes: right after switching into the project view there is no "recent
 * activity" yet — the journal on the right is on screen, but the keyboard
 * belongs to the cards in the middle. In study mode the project region is
 * absent and is simply skipped; the order itself is unchanged.
 *
 * The code region is last: it grows inside the reading column (middle pane),
 * so when the reading region is absent it is absent too and the fallback
 * never reaches it. It gets the keyboard through "the user acted inside it"
 * (owner) or "focus is inside it" (focus), not through this fallback list.
 */
const FOCUS_REGIONS: FocusRegion[] = ["reading", "project", "notes", "agent", "code"];
const FOCUS_REGION_SET = new Set<string>(FOCUS_REGIONS);

let ownerRegion: FocusRegion | null = null;

export function regionFromTarget(target: EventTarget | null): FocusRegion | null {
  const el = target instanceof Element ? target : null;
  const host = el?.closest(`[${REGION_ATTR}]`);
  const attr = host?.getAttribute(REGION_ATTR);
  return attr && FOCUS_REGION_SET.has(attr) ? (attr as FocusRegion) : null;
}

/**
 * Whether the region is on screen right now. The three columns (assistant /
 * content / notes) are always mounted; outside study mode only the notes
 * region exists. An invisible region must not hold the keyboard — things that
 * cannot be seen should not receive keys.
 */
export function regionOnScreen(region: FocusRegion): boolean {
  const el = document.querySelector(`[${REGION_ATTR}="${region}"]`);
  if (!el) return false;
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

/**
 * Which region owns the keyboard right now (pure function; the gate lives in
 * globalKeys.test.ts).
 * Order: the region of the most recent input → the focused region → any
 * region on screen (reading first).
 */
export function pickKeyRegion(input: {
  owner: FocusRegion | null;
  focus: FocusRegion | null;
  onScreen: (region: FocusRegion) => boolean;
}): FocusRegion {
  if (input.owner && input.onScreen(input.owner)) return input.owner;
  if (input.focus && input.onScreen(input.focus)) return input.focus;
  for (const region of FOCUS_REGIONS) {
    if (input.onScreen(region)) return region;
  }
  return "notes";
}

export function setActiveKeyRegion(region: FocusRegion): void {
  ownerRegion = region;
}

/** The region the user last claimed (an input event or an explicit focus command); the other half of `activeKeyRegion`. */
export function keyRegionOwner(): FocusRegion | null {
  return ownerRegion;
}

export function activeKeyRegion(): FocusRegion {
  return pickKeyRegion({
    owner: keyRegionOwner(),
    focus: regionFromTarget(document.activeElement),
    onScreen: regionOnScreen,
  });
}

/** Pick a command that can run right now (if the previous one's `when` is false, try the next). */
function pickCommand(ids: string[]): string | null {
  for (const id of ids) {
    const cmd = getCommand(id);
    if (!cmd) continue;
    if (cmd.when && !cmd.when()) continue;
    return id;
  }
  return null;
}

/**
 * The command this key will finally run in the current region (already
 * filtered by `when`).
 *
 * The web forwarding channel has to know whether the target command needs
 * the main window's focus before it takes the focus and runs (see
 * CommandDef.keepsPageFocus), so the resolved result is exposed here.
 */
export function resolveBoundCommand(key: string, region: FocusRegion): CommandDef | null {
  const id = pickCommand(commandsForKey(key, region));
  return id ? (getCommand(id) ?? null) : null;
}

/**
 * Run the command for an already resolved key. Window-level dispatch and the
 * web reader's forwarding channel share this one path, so "a key pressed in
 * the page" and "a key pressed in the main window" obey the same region rules.
 */
export function runBoundKey(key: string, region: FocusRegion): boolean {
  const cmd = resolveBoundCommand(key, region);
  if (!cmd) return false;
  if (keyContext === "drawing" && !DRAWING_ALLOWED.has(cmd.id)) return false;
  runCommand(cmd.id);
  return true;
}

export function installGlobalKeybindings() {
  // The four writers of region ownership: all of them are "the user acted"
  // events; synthetic events (tooltips, programmatic focus) do not count.
  // Scrolling is registered passive: scrolling is a hot path and the listener
  // must not slow it down.
  const claimRegion = (event: Event) => {
    const region = regionFromTarget(event.target);
    if (region) ownerRegion = region;
  };
  window.addEventListener("pointerdown", claimRegion, true);
  window.addEventListener("focusin", claimRegion, true);
  window.addEventListener("wheel", claimRegion, { capture: true, passive: true });
  window.addEventListener("touchmove", claimRegion, { capture: true, passive: true });

  window.addEventListener(
    "keydown",
    (e) => {
      if (recordingHotkey || e.defaultPrevented) return;
      const key = eventToKey(e);
      if (!key) return;
      // A text input's own editing chords (⌘A/C/X/V/⌘Z) take no part in
      // region dispatch: even when the same region binds those keys, pressing
      // them inside an input must still select/copy/paste (see editingChords).
      const chordTarget = e.target instanceof Element ? e.target : document.activeElement;
      if (chordTarget instanceof Element && formOwnsEditChord(key, chordTarget.tagName)) {
        return;
      }
      // Bare navigation keys (paging/arrows) have native meanings in the
      // editor and in inputs, so they must be passed through untouched;
      // modified bindings (such as ⌃J) take effect under any focus — the user
      // explicitly pressed a chord.
      if (
        isPlainFocusOwnedKey(e) &&
        (isEditableTarget(e.target) || isEditableTarget(document.activeElement))
      ) {
        return;
      }
      const region: FocusRegion | "global" = modalOpen ? "global" : activeKeyRegion();
      const id = pickCommand(commandsForKey(key, region));
      if (id) {
        if (keyContext === "drawing" && !DRAWING_ALLOWED.has(id)) return;
        e.preventDefault();
        e.stopPropagation();
        recordCommandChord(e);
        runCommand(id);
        return;
      }

      // Fixed paging keys: PageUp/PageDown always page the reading region's
      // content (PDF or web), even if the user rebound study.pdf-* elsewhere.
      // They only apply in the reading region — PageUp inside the note editor
      // belongs to the editor itself.
      if (keyContext === "drawing" || region !== "reading") return;
      const fixed = fixedPageCommandFor(e);
      if (!fixed) return;
      const fixedCmd = getCommand(fixed);
      if (!fixedCmd || (fixedCmd.when && !fixedCmd.when())) return;
      e.preventDefault();
      e.stopPropagation();
      recordCommandChord(e);
      runCommand(fixed);
    },
    true,
  );
}

/**
 * The project switcher's list: which recent project is offered, and what each
 * one is called.
 *
 * Pure on purpose (a node test, no DOM): the popover is only the wiring. The
 * recent list is the same one `openProjectAt` writes, so the switcher can
 * never offer a project the app forgot.
 */

/**
 * The projects worth offering, in the order they were opened: the recent list
 * minus the one already open (choosing it would flush buffers and rescan for
 * no reason), deduplicated (a hand-edited config may repeat a path).
 */
export function switchCandidates(recent: readonly string[], open: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([open]);
  for (const path of recent) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** The name of a project path: its last component (the folder name). */
export function projectLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  // A root path ("/", "///") has no component: show it as given instead of an
  // empty label.
  if (!trimmed) return path;
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

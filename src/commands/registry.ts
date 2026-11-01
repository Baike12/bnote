export interface CommandDef {
  /** Stable identifier, e.g. "edit.insert-math-block". */
  id: string;
  title: string;
  category: string;
  /**
   * Whether the command may run right now (optional). The window-level
   * dispatcher has to ask before preventDefault — a key whose guard returns
   * false must pass through untouched, otherwise keys shared with the editor,
   * such as the arrow keys, would be silently swallowed.
   */
  when?: () => boolean;
  /**
   * Do not steal the keyboard focus from the page when a native web page
   * forwards the command (optional).
   *
   * The page runs in a child webview: when a key comes back to the main
   * window over the title channel, the keyboard (the first responder) is still
   * on the child webview. Commands that switch regions must first pull the
   * keyboard back with `Webview.setFocus`, while webpage zoom only flips a
   * property on the Rust side — stealing focus there leaves the user unable to
   * scroll or type into the page after pressing ⌘=.
   */
  keepsPageFocus?: boolean;
  run: () => void | Promise<void>;
}

const registry = new Map<string, CommandDef>();

/** Commands register themselves at module load; the registry is the single
 *  source for the palette, the hotkey settings UI and keymap resolution. */
export function registerCommands(defs: CommandDef[]) {
  for (const d of defs) {
    registry.set(d.id, d);
  }
}

export function allCommands(): CommandDef[] {
  return [...registry.values()];
}

export function getCommand(id: string): CommandDef | undefined {
  return registry.get(id);
}

export function runCommand(id: string): void {
  const cmd = registry.get(id);
  if (!cmd) {
    console.warn(`[bnote] unknown command: ${id}`);
    return;
  }
  if (cmd.when && !cmd.when()) return;
  Promise.resolve(cmd.run()).catch((e) => {
    console.error(`[bnote] command ${id} failed`, e);
  });
}

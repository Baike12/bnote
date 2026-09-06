export interface CommandDef {
  /** Stable identifier, e.g. "edit.insert-math-block". */
  id: string;
  title: string;
  category: string;
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
  Promise.resolve(cmd.run()).catch((e) => {
    console.error(`[bnote] command ${id} failed`, e);
  });
}

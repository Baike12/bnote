export interface CommandDef {
  /** Stable identifier, e.g. "edit.insert-math-block". */
  id: string;
  title: string;
  category: string;
  /**
   * 现在能不能执行(可选)。窗口级分发必须在 preventDefault 之前问它——返回
   * false 的键要原样放行,否则像方向键这种与编辑器共享的键会被静默吞掉。
   */
  when?: () => boolean;
  /**
   * 由原生网页转发执行时不要抢走页面的键盘焦点(可选)。
   *
   * 网页跑在子 webview 里:按键经 title 通道转回主窗口时,焦点仍在子
   * webview 上。区域切换这类命令必须先 `setFocus()` 把焦点收回主窗口;
   * 而网页缩放只是在 Rust 侧改一个属性,抢焦点会让用户按完 ⌘= 就滚不动、
   * 打字也进不了页面。
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

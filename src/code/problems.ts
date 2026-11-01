import type { LspPosition } from "./types";

/**
 * 「下一个 / 上一个问题」(F8 / ⇧F8)的目标选择。
 *
 * 纯函数:诊断来自 store,光标来自编辑器,这里只决定该跳去哪。单拎出来是
 * 因为旧实现把「当前在第几条」写成了猜——它拿当前文件的**第 0 条**诊断当
 * 游标,于是连按 F8 只在两个文件之间来回跳,同一个文件里的第 2、3 条问题
 * 永远轮不到。
 *
 * 规则(与主流 IDE 一致):
 * - 先在**当前文件**里找光标之后(direction = 1)/ 之前(-1)的第一条;
 * - 当前文件没有了,按「有问题的文件」的顺序跨到相邻文件的头 / 尾;
 * - 只有一个文件时绕回它自己(单文件也要能循环);
 * - 当前文件没有诊断,从整个列表的头 / 尾开始。
 */

export interface ProblemTarget {
  /** 项目相对路径。 */
  path: string;
  position: LspPosition;
}

export interface ProblemCursor {
  /** 光标所在文件(null = 不知道)。 */
  path: string | null;
  /** 光标位置;没有编辑器时给 null(按文件头 / 尾处理)。 */
  position: LspPosition | null;
}

function comparePosition(a: LspPosition, b: LspPosition): number {
  return a.line - b.line || a.character - b.character;
}

export function nextProblemTarget(
  problems: readonly ProblemTarget[],
  cursor: ProblemCursor,
  direction: 1 | -1,
): ProblemTarget | null {
  if (problems.length === 0) return null;

  // 按文件分组(文件顺序 = 诊断首次出现的顺序),组内按位置排好:
  // 服务器推来的诊断不保证有序。
  const groups = new Map<string, ProblemTarget[]>();
  for (const problem of problems) {
    const list = groups.get(problem.path);
    if (list) list.push(problem);
    else groups.set(problem.path, [problem]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => comparePosition(a.position, b.position));
  }
  const paths = [...groups.keys()];

  /** 某个文件的头 / 尾一条。 */
  const edgeOf = (path: string): ProblemTarget => {
    const list = groups.get(path)!;
    return direction === 1 ? list[0] : list[list.length - 1];
  };

  if (cursor.path && groups.has(cursor.path)) {
    const list = groups.get(cursor.path)!;
    if (!cursor.position) return edgeOf(cursor.path);
    const position = cursor.position;
    const hit =
      direction === 1
        ? list.find((p) => comparePosition(p.position, position) > 0)
        : [...list].reverse().find((p) => comparePosition(p.position, position) < 0);
    if (hit) return hit;
    // 本文件已经没有下一条:换到相邻文件的头 / 尾(单文件时绕回自己)。
    const index = paths.indexOf(cursor.path);
    return edgeOf(paths[(index + direction + paths.length) % paths.length]);
  }

  // 当前文件没有诊断:从整个列表的头 / 尾开始。
  return edgeOf(paths[direction === 1 ? 0 : paths.length - 1]);
}

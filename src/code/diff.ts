/**
 * unified diff 的解析与并排对齐。
 *
 * 后端只给原始的 unified diff 文本(`git diff --no-color`),解析放在前端:
 * 渲染时需要按行号、颜色、并排对齐,这些都在这一层做,不必让后端再实现
 * 一遍 diff 模型。
 */

/** 一行 diff。 */
export interface DiffLine {
  type: "context" | "add" | "remove" | "meta";
  text: string;
  /** 原文件行号(1-based);新增行没有。 */
  oldLine: number | null;
  /** 新文件行号(1-based);删除行没有。 */
  newLine: number | null;
}

/** 一个 hunk(`@@ -a,b +c,d @@`)。 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** `@@` 后面那段上下文标题(可选)。 */
  section: string;
  lines: DiffLine[];
}

/** 一个文件的差异。 */
export interface DiffFileDiff {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
}

/** 解析后的整个 diff。 */
export interface ParsedDiff {
  files: DiffFileDiff[];
}

/** `@@ -1,4 +1,5 @@ foo` → hunk 头。 */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * 解析 unified diff 文本。
 *
 * 支持多文件(`diff --git` 分段)、新增文件(`/dev/null` 旧路径)、删除文件
 * (新路径 `/dev/null`)。不认识的行按 context 处理——宁可多显示一行,别丢
 * 上下文。
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFileDiff[] = [];
  const raw = text.split("\n");
  // 结尾的换行会切出一个空段:它不是「一行空的上下文」,是切分产物。
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const lines = raw;
  let file: DiffFileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const ensureFile = (): DiffFileDiff => {
    if (!file) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
    }
    return file;
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      ensureFile().oldPath = p === "/dev/null" ? null : stripPrefix(p);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      ensureFile().newPath = p === "/dev/null" ? null : stripPrefix(p);
      continue;
    }
    const m = HUNK_RE.exec(raw);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: newLine,
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5].trim(),
        lines: [],
      };
      ensureFile().hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" —— 附在上一行,不改行号。
      hunk.lines.push({ type: "meta", text: raw.slice(2), oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith("+")) {
      hunk.lines.push({ type: "add", text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      hunk.lines.push({ type: "remove", text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ type: "context", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // 其余(diff --git 之外的元信息行)不显示。
  }

  return { files };
}

/** 去掉 diff 路径的 `a/` `b/` 前缀。 */
function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** 并排视图的一行:左右各一格,缺的用 null 占位。 */
export interface DiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * 把一个 hunk 的行排成并排视图的行。
 *
 * 配对分两层:
 * 1. **内容没变的行**(LCS 找出来的公共子序列)左右对齐——它们是「挪了位置」
 *    的行,不该飘到别处;
 * 2. 剩下没配上的删除/新增**按位置配对**——这就是「改过的同一行」:左边旧的、
 *    右新的。
 *
 * 只按内容配对是不够的:改一个词的那一行,新旧文本不同,LCS 配不上,会变成
 * 「左边一格删除、右边一格新增」两行,读起来像删了一行又加了一行。
 */
export function alignHunk(hunk: DiffHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "context" || line.type === "meta") {
      rows.push({ left: line, right: line.type === "context" ? line : null });
      i += 1;
      continue;
    }
    // 一段连续的增删(中间没有上下文行)。
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && (lines[i].type === "remove" || lines[i].type === "add")) {
      if (lines[i].type === "remove") removed.push(lines[i]);
      else added.push(lines[i]);
      i += 1;
    }
    rows.push(...alignSegment(removed, added));
  }
  return rows;
}

/** 一段连续增删的对齐:先按 LCS 配上没变的行,剩下的按位置配对。 */
function alignSegment(removed: DiffLine[], added: DiffLine[]): DiffRow[] {
  const pairs = lcsPairs(
    removed.map((l) => l.text),
    added.map((l) => l.text),
  );
  const rows: DiffRow[] = [];
  let ri = 0;
  let ai = 0;
  for (const pair of pairs) {
    rows.push(...pairPositional(removed.slice(ri, pair.left), added.slice(ai, pair.right)));
    rows.push({ left: removed[pair.left], right: added[pair.right] });
    ri = pair.left + 1;
    ai = pair.right + 1;
  }
  rows.push(...pairPositional(removed.slice(ri), added.slice(ai)));
  return rows;
}

/** 按位置配对:多的那边留空。 */
function pairPositional(removed: DiffLine[], added: DiffLine[]): DiffRow[] {
  const n = Math.max(removed.length, added.length);
  const rows: DiffRow[] = [];
  for (let k = 0; k < n; k++) {
    rows.push({ left: removed[k] ?? null, right: added[k] ?? null });
  }
  return rows;
}

/** 配对结果:左边下标 → 右边下标。 */
interface LcsPair {
  left: number;
  right: number;
}

/**
 * 最长公共子序列的配对(只给下标,不给序列本身)。
 *
 * 用动态规划的标准 LCS 长度表,再回溯出配对。O(n*m) —— hunk 通常几十行,
 * 够用;真要防超大 hunk,调用方可以先按行数截断。
 */
export function lcsPairs(a: string[], b: string[]): LcsPair[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: LcsPair[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ left: i, right: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** diff 的统计:新增/删除多少行。 */
export function diffStats(diff: ParsedDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add") added += 1;
        else if (line.type === "remove") removed += 1;
      }
    }
  }
  return { added, removed };
}

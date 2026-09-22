/**
 * markdown 里 python 围栏代码块的提取与「行对齐虚拟文件」合成。
 *
 * 核心模型:一篇 markdown 的所有 ```python 围栏内容,按行号原位拼成一个
 * 虚拟 .py 文件 —— 非 python 行一律置空。虚拟文件与 markdown 逐行等长,
 * 所以 LSP 诊断、traceback 的行列号与 markdown 完全一致,零换算。
 *
 * 「把所有代码片段当一个 py 文件」的语义由空行保证:python 里空行不会闭合
 * 缩进块,原位拼接与直接顺序拼接在语法上等价,但行号对齐让错误定位免费。
 */

export interface PythonBlock {
  /** 围栏内容首行(0 基,不含 ``` 开栏行)。 */
  startLine: number;
  /** 围栏内容末行(0 基,不含闭栏行;未闭合围栏到文档末尾)。 */
  endLine: number;
  /** 剥掉围栏公共缩进后的代码文本。 */
  text: string;
  /** 开栏行的缩进数;虚拟文件每行剥掉 min(indent, 行首空格) 列。 */
  indent: number;
}

export interface PythonExtract {
  blocks: PythonBlock[];
  /** 与原文档逐行等长的虚拟文件(非 python 行为空行)。 */
  virtualText: string;
  /** 虚拟文件里识别到的模块级 main。 */
  hasMain: boolean;
  /** 原文里已有 __name__ 守卫(用户自己管调用,不再追加)。 */
  hasMainGuard: boolean;
  /** 为「有 main 无守卫」追加的行数(0 或 3)。 */
  appendedLines: number;
  /** 实际交给 python / LSP 的文本 = virtualText + 可能的 main 守卫。 */
  effectiveText: string;
}

/** 识别为 python 的 info string 首词。 */
const PYTHON_LANGS = new Set(["python", "py", "python3"]);

/** 快速判负:文档里连围栏标记都没有就无需解析(每次同步 tick 的省路)。 */
export function hasPythonFenceHint(doc: string): boolean {
  return doc.includes("```") || doc.includes("~~~");
}

export function extractPython(doc: string): PythonExtract {
  const lines = doc.split("\n");
  const virtual = new Array<string>(lines.length).fill("");
  const blocks: PythonBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const open = openFenceOf(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    // 围栏内容区:从开栏下一行到闭栏前一行(或文档末尾)。
    const startLine = i + 1;
    let j = startLine;
    while (j < lines.length && !isCloseFence(lines[j], open)) {
      j += 1;
    }
    const endLine = j - 1;
    if (PYTHON_LANGS.has(open.lang)) {
      const body = lines
        .slice(startLine, j)
        .map((l) => stripIndent(l, open.indent))
        .join("\n");
      blocks.push({ startLine, endLine, text: body, indent: open.indent });
      for (let k = startLine; k <= endLine; k += 1) {
        virtual[k] = lines[k].slice(Math.min(open.indent, leadingSpaces(lines[k])));
      }
    }
    i = j < lines.length ? j + 1 : j;
  }

  const virtualText = virtual.join("\n");
  const hasMain = virtual.some((l) => /^def\s+main\s*\(/.test(l));
  const hasMainGuard = virtual.some((l) => /if\s+__name__\s*==\s*['"]__main__['"]/.test(l));
  // 运行语义与跑一个 .py 文件一致:模块顶层 def main 存在且没人调它时,
  // 追加标准守卫;用户已写 __name__ 守卫就尊重原文。
  const appendGuard = hasMain && !hasMainGuard;
  const guard = appendGuard ? '\n\nif __name__ == "__main__":\n    main()' : "";
  return {
    blocks,
    virtualText,
    hasMain,
    hasMainGuard,
    appendedLines: appendGuard ? 3 : 0,
    effectiveText: virtualText + guard,
  };
}

interface OpenFence {
  char: "`" | "~";
  length: number;
  /** 开栏行前导空格数(≤3),内容行剥掉不超过这个数的缩进。 */
  indent: number;
  lang: string;
}

/**
 * CommonMark 围栏开栏:≤3 空格缩进 + ≥3 个相同字符。反引号围栏的 info
 * string 里不许再出现反引号(出现即不是围栏);波浪号无此限制。
 */
function openFenceOf(line: string): OpenFence | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const char = marker[0] as "`" | "~";
  if (char === "`" && m[2].includes("`")) return null;
  const lang = m[2].trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return { char, length: marker.length, indent: line.length - line.trimStart().length, lang };
}

function isCloseFence(line: string, open: OpenFence): boolean {
  const re = new RegExp(`^ {0,3}\\${open.char === "`" ? "`" : "~"}{${open.length},}[ \\t]*$`);
  return re.test(line);
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n += 1;
  return n;
}

function stripIndent(line: string, indent: number): string {
  return line.slice(Math.min(indent, leadingSpaces(line)));
}

// ---------------------------------------------------------------------------
// LSP 行列(CM6 偏移都是 UTF-16 code unit,LSP position 也是,可直接相加)
// ---------------------------------------------------------------------------

import type { Text } from "@codemirror/state";

export interface LspPoint {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPoint;
  end: LspPoint;
}

/** LSP position(0 基行 + UTF-16 列)→ CM 偏移;行越界返回 -1(调用方丢弃)。 */
export function lspPointToOffset(doc: Text, line0: number, character: number): number {
  if (!Number.isInteger(line0) || line0 < 0 || line0 >= doc.lines) return -1;
  const line = doc.line(line0 + 1);
  return line.from + Math.min(Math.max(character, 0), line.length);
}

export type UiSeverity = "error" | "warning" | "info" | "hint";

/** LSP Diagnostic 里前端要用的最小切片(后端原样转发 ty 的 JSON)。 */
export interface RawLspDiagnostic {
  range: LspRange;
  severity?: number;
  message?: string;
  code?: string | { value?: string };
  source?: string;
}

export interface UiDiagnostic {
  from: number;
  to: number;
  severity: UiSeverity;
  message: string;
  source: string;
  code?: string;
}

/**
 * LSP 诊断 → CM lint 诊断。虚拟文件与 markdown 行对齐,行列直接用;
 * 落在追加的 main 守卫区(超出文档行数)或无法映射的条目丢弃。
 */
export function mapLspDiagnostics(doc: Text, raw: RawLspDiagnostic[]): UiDiagnostic[] {
  const out: UiDiagnostic[] = [];
  for (const d of raw ?? []) {
    if (!d || !d.range || !d.range.start || !d.range.end) continue;
    const from = lspPointToOffset(doc, d.range.start.line, d.range.start.character);
    const to = lspPointToOffset(doc, d.range.end.line, d.range.end.character);
    if (from < 0 || to < 0) continue;
    const code =
      typeof d.code === "string" ? d.code : typeof d.code?.value === "string" ? d.code.value : undefined;
    out.push({
      from: Math.min(from, to),
      to: Math.max(from, to),
      severity: severityOf(d.severity),
      message: typeof d.message === "string" ? d.message : "",
      source: typeof d.source === "string" && d.source ? d.source : "ty",
      code,
    });
  }
  return out;
}

function severityOf(n: number | undefined): UiSeverity {
  if (n === 1) return "error";
  if (n === 2) return "warning";
  if (n === 3) return "info";
  if (n === 4) return "hint";
  return "error";
}

// ---------------------------------------------------------------------------
// 补全 / hover:LSP 应答 → 前端结构(纯映射,无 DOM,node 环境可测)
// ---------------------------------------------------------------------------

export interface UiCompletion {
  label: string;
  /** 插入文本;undefined = 用 label(snippet 格式不解析占位符,退回 label)。 */
  apply?: string;
  detail?: string;
  /** CM 的 completion type(class/function/variable/…),决定列表图标。 */
  type?: string;
  /** documentation 字段的纯文本。 */
  info?: string;
}

/** LSP CompletionItemKind(1-25)→ CM completion type 的常用子集。 */
const COMPLETION_KINDS: Record<number, string> = {
  2: "method",
  3: "function",
  4: "function",
  5: "property",
  6: "variable",
  7: "class",
  8: "type",
  9: "namespace",
  10: "property",
  12: "constant",
  13: "enum",
  14: "keyword",
  21: "constant",
  22: "class",
  25: "type",
};

/** MarkupContent / plain string → 纯文本;markdown 内容剥掉 ``` 围栏行。 */
function markupText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const m = v as { value?: unknown; kind?: unknown };
    if (typeof m.value === "string") {
      if (m.kind === "markdown") {
        return m.value
          .split("\n")
          .filter((l) => !/^\s*```/.test(l))
          .join("\n");
      }
      return m.value;
    }
  }
  return undefined;
}

/** LSP CompletionList / CompletionItem[] → 前端补全项;畸形条目丢弃。 */
export function mapLspCompletions(raw: unknown): UiCompletion[] {
  let items: readonly unknown[] | null = null;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { items?: unknown }).items)
  ) {
    items = (raw as { items: readonly unknown[] }).items;
  }
  if (!items) return [];
  const out: UiCompletion[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as {
      label?: unknown;
      insertText?: unknown;
      insertTextFormat?: unknown;
      detail?: unknown;
      documentation?: unknown;
      kind?: unknown;
    };
    if (typeof it.label !== "string" || !it.label) continue;
    out.push({
      label: it.label,
      apply:
        typeof it.insertText === "string" && it.insertText && it.insertTextFormat !== 2
          ? it.insertText
          : undefined,
      detail: typeof it.detail === "string" && it.detail ? it.detail : undefined,
      type: typeof it.kind === "number" ? COMPLETION_KINDS[it.kind] : undefined,
      info: markupText(it.documentation),
    });
  }
  return out;
}

/** LSP hover 应答 → 纯文本(contents 可为 string / MarkupContent / 数组)。 */
export function lspHoverText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const contents = (raw as { contents?: unknown }).contents;
  const parts: string[] = [];
  const push = (v: unknown) => {
    const t = markupText(v);
    if (t && t.trim()) parts.push(t);
  };
  if (Array.isArray(contents)) {
    for (const part of contents) push(part);
  } else {
    push(contents);
  }
  const text = parts.join("\n\n").trim();
  return text || null;
}

/**
 * markdown 光标偏移 → 虚拟文件 LSP position。行号天生对齐;列要剥掉围栏
 * 公共缩进(虚拟行 = markdown 行 slice 掉前缀),光标落在被剥的前缀里时
 * 贴到列 0。不在 python 围栏内容行时返回 null(补全/hover 的门)。
 */
export function mdPosToLspPosition(
  doc: Text,
  pos: number,
  eff: PythonExtract,
): { line: number; character: number } | null {
  const p = Math.min(Math.max(pos, 0), doc.length);
  const lineObj = doc.lineAt(p);
  const line0 = lineObj.number - 1;
  const block = eff.blocks.find((b) => line0 >= b.startLine && line0 <= b.endLine);
  if (!block) return null;
  let spaces = 0;
  while (spaces < lineObj.text.length && lineObj.text[spaces] === " ") spaces += 1;
  const strip = Math.min(block.indent, spaces);
  return { line: line0, character: Math.max(p - lineObj.from - strip, 0) };
}


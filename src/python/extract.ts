/**
 * Extraction of python fenced code blocks from markdown and the composition of a "line-aligned virtual file".
 *
 * Core model: the contents of every ```python fence in a markdown file are stitched into one virtual .py file in place, by line
 * number -- every non-python line is blanked out. The virtual file has exactly as many lines as the markdown, so LSP diagnostics
 * and traceback line/column numbers match the markdown exactly, with zero conversion.
 *
 * The "run every snippet as one py file" semantics is guaranteed by the blank lines: in python a blank line never closes an indented
 * block, so pasting in place is syntactically equivalent to concatenating in order, but the line alignment makes error locations free.
 */

export interface PythonBlock {
  /** First line of the fence content (0-based, excludes the ``` opening fence). */
  startLine: number;
  /** Last line of the fence content (0-based, excludes the closing fence; an unclosed fence runs to the end of the document). */
  endLine: number;
  /** The code text with the fence's common indent stripped. */
  text: string;
  /** Indent of the opening fence; every virtual line is stripped of min(indent, leading spaces) columns. */
  indent: number;
}

export interface PythonExtract {
  blocks: PythonBlock[];
  /** The virtual file, line-for-line as long as the original document (non-python lines are empty). */
  virtualText: string;
  /** A module-level main found in the virtual file. */
  hasMain: boolean;
  /** The source already has a __name__ guard (the user drives the call, so nothing is appended). */
  hasMainGuard: boolean;
  /** Number of lines appended for the "has main, no guard" case (0 or 3). */
  appendedLines: number;
  /** The text actually handed to python / the LSP = virtualText + a possible main guard. */
  effectiveText: string;
}

/** The first word of an info string that identifies python. */
const PYTHON_LANGS = new Set(["python", "py", "python3"]);

/** Cheap negative check: a document without any fence marker needs no parsing (the shortcut on every sync tick). */
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
    // The fence content region: from the line after the opening fence to the line before the closing fence (or the end of the document).
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
  // Same run semantics as executing a .py file: when a module-level def main exists and nothing calls it,
  // the standard guard is appended; a __name__ guard written by the user is respected as-is.
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
  /** Number of leading spaces on the opening fence (<=3); content lines are stripped of at most that many columns. */
  indent: number;
  lang: string;
}

/**
 * CommonMark fence opening: <=3 spaces of indent plus >=3 identical chars. The info string of a backtick fence
 * may not contain a backtick (if it does, it is not a fence); tilde fences have no such restriction.
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
// LSP line/column (CM6 offsets are UTF-16 code units, LSP positions too, so they add up directly)
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

/** LSP position (0-based line + UTF-16 column) -> CM offset; returns -1 for an out-of-range line (the caller drops it). */
export function lspPointToOffset(doc: Text, line0: number, character: number): number {
  if (!Number.isInteger(line0) || line0 < 0 || line0 >= doc.lines) return -1;
  const line = doc.line(line0 + 1);
  return line.from + Math.min(Math.max(character, 0), line.length);
}

export type UiSeverity = "error" | "warning" | "info" | "hint";

/** The minimal slice of an LSP Diagnostic the frontend needs (the backend forwards ty's JSON as-is). */
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
 * LSP diagnostics -> CM lint diagnostics. The virtual file is line-aligned with the markdown, so line and column are used directly;
 * entries that land in the appended main guard (past the document's line count) or cannot be mapped are dropped.
 */
export function mapLspDiagnostics(doc: Text, raw: RawLspDiagnostic[]): UiDiagnostic[] {
  const out: UiDiagnostic[] = [];
  for (const d of raw ?? []) {
    if (!d || !d.range || !d.range.start || !d.range.end) continue;
    const from = lspPointToOffset(doc, d.range.start.line, d.range.start.character);
    const to = lspPointToOffset(doc, d.range.end.line, d.range.end.character);
    if (from < 0 || to < 0) continue;
    const code =
      typeof d.code === "string"
        ? d.code
        : typeof d.code?.value === "string"
          ? d.code.value
          : undefined;
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
// Completion / hover: LSP replies -> frontend structures (pure mapping, no DOM, testable in the node environment)
// ---------------------------------------------------------------------------

export interface UiCompletion {
  label: string;
  /** Text to insert; undefined means use the label (snippet format is not parsed for placeholders, it falls back to the label). */
  apply?: string;
  detail?: string;
  /** CM completion type (class/function/variable/...), it decides the icon in the list. */
  type?: string;
  /** The documentation field as plain text. */
  info?: string;
}

/** The common subset of LSP CompletionItemKind (1-25) -> CM completion type. */
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

/** MarkupContent / plain string -> plain text; markdown content is stripped of its ``` fence lines. */
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

/** LSP CompletionList / CompletionItem[] -> frontend completion items; malformed entries are dropped. */
export function mapLspCompletions(raw: unknown): UiCompletion[] {
  let items: readonly unknown[] | null = null;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)) {
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

/** An LSP hover reply -> plain text (contents may be a string, a MarkupContent or an array). */
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
 * A markdown caret offset -> an LSP position in the virtual file. Line numbers align by construction; the column has to strip the
 * fence's common indent (the virtual line is the markdown line sliced off that prefix), and a caret inside the stripped prefix sticks
 * to column 0. Returns null when the caret is not on a python fence content line (the gate for completion and hover).
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

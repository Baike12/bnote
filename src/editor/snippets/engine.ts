import type { EditorState } from "@codemirror/state";
import { getContextAt, type EditContext } from "../context";
import { DEFAULT_SNIPPETS, type RawSnippet, type SnippetReplacement } from "./default-snippets";
import { DEFAULT_SNIPPET_VARIABLES } from "./default-variables";
import { LATEX_SUITE_WORD_DELIMITERS } from "./config";

export interface SnippetMode {
  text: boolean;
  inlineMath: boolean;
  blockMath: boolean;
  textEnv: boolean;
  code: boolean;
  codeBlock: boolean;
  catchall: boolean;
}

export interface ParsedSnippet {
  trigger: string | RegExp;
  /** Trigger with snippet variables substituted (display purposes). */
  displayTrigger: string;
  /** For regex triggers: precompiled, anchored-at-cursor variant. */
  anchored: RegExp | null;
  replacement: string | SnippetReplacement;
  auto: boolean;
  regex: boolean;
  word: boolean;
  visual: boolean;
  mode: SnippetMode;
  priority: number;
  description: string;
  source: "builtin" | "user";
}

export function parseSnippet(raw: RawSnippet): ParsedSnippet | null {
  const options = raw.options ?? "";
  let trigger: string | RegExp = raw.trigger;

  if (typeof trigger === "string") {
    trigger = substituteVariables(trigger);
    // latex-suite file format: regex triggers are strings carrying the "r"
    // option — compile them, or they'd only match as literal text.
    if (options.includes("r")) {
      try {
        trigger = new RegExp(trigger);
      } catch {
        return null;
      }
    }
  } else {
    // Regex triggers: substitute variables in the source, keep flags.
    const source = substituteVariables(trigger.source);
    try {
      trigger = new RegExp(source, trigger.flags);
    } catch {
      return null;
    }
  }

  let anchored: RegExp | null = null;
  if (trigger instanceof RegExp) {
    try {
      anchored = new RegExp("(?:" + trigger.source + ")$", trigger.flags.replace("g", ""));
    } catch {
      return null;
    }
  }

  const mode: SnippetMode = {
    text: false,
    inlineMath: false,
    blockMath: false,
    textEnv: false,
    code: false,
    codeBlock: false,
    catchall: false,
  };
  let sawModeFlag = false;
  for (const ch of options) {
    switch (ch) {
      case "m":
        mode.blockMath = true;
        mode.inlineMath = true;
        sawModeFlag = true;
        break;
      case "n":
        mode.inlineMath = true;
        sawModeFlag = true;
        break;
      case "M":
        mode.blockMath = true;
        sawModeFlag = true;
        break;
      case "t":
        mode.text = true;
        sawModeFlag = true;
        break;
      case "T":
        mode.textEnv = true;
        sawModeFlag = true;
        break;
      case "c":
        mode.codeBlock = true;
        sawModeFlag = true;
        break;
      case "C":
        mode.code = true;
        sawModeFlag = true;
        break;
    }
  }
  if (!sawModeFlag) mode.catchall = true;

  const visual =
    options.includes("v") ||
    (typeof raw.replacement === "string" && raw.replacement.includes("${VISUAL}"));

  return {
    trigger,
    displayTrigger: typeof trigger === "string" ? trigger : trigger.source,
    anchored,
    replacement: raw.replacement,
    auto: options.includes("A"),
    regex: options.includes("r") || raw.trigger instanceof RegExp,
    word: options.includes("w"),
    visual,
    mode,
    priority: raw.priority ?? 0,
    description: raw.description ?? "",
    source: raw.source ?? "builtin",
  };
}

function substituteVariables(s: string): string {
  let out = s;
  for (const [name, value] of Object.entries(DEFAULT_SNIPPET_VARIABLES)) {
    out = out.split(name).join(value);
  }
  return out;
}

/** Mirrors latex-suite: a snippet runs when any of its mode flags match the
 *  cursor context (or the snippet has no mode flags at all). */
export function matchesContext(s: ParsedSnippet, ctx: EditContext): boolean {
  if (s.mode.catchall) return true;
  if (s.mode.textEnv) return ctx.textEnv;
  if (s.mode.text && ctx.isText) return true;
  if (s.mode.inlineMath && ctx.inlineMath) return true;
  if (s.mode.blockMath && ctx.blockMath) return true;
  if (s.mode.code && ctx.code) return true;
  if (s.mode.codeBlock && ctx.codeBlock !== false) return true;
  return false;
}

/** latex-suite 的 `w` 判定:trigger 前后**都**必须是分隔符;非 ASCII(CJK)
 *  也算边界——否则中文笔记里的「测试dm」永远不展开。`\n` 在设置串里写的是
 *  字面两字符,还原成真换行。 */
export function isWordBoundary(
  state: EditorState,
  triggerPos: number,
  cursor: number,
  delimiters: string,
): boolean {
  const prev = triggerPos <= 0 ? "" : state.sliceDoc(triggerPos - 1, triggerPos);
  const next = cursor >= state.doc.length ? "" : state.sliceDoc(cursor, cursor + 1);
  const set = delimiters.replace(/\\n/g, "\n");
  const boundary = (ch: string) => ch === "" || /[^\x00-\x7F]/.test(ch) || set.includes(ch);
  return boundary(prev) && boundary(next);
}

export interface CompiledSnippetList {
  /** Sorted: priority desc, then longer triggers first. */
  list: ParsedSnippet[];
}

export function compileSnippets(raws: RawSnippet[]): CompiledSnippetList {
  const parsed = raws
    .map(parseSnippet)
    .filter((s): s is ParsedSnippet => s !== null)
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const la = a.regex ? 0 : a.displayTrigger.length;
      const lb = b.regex ? 0 : b.displayTrigger.length;
      return lb - la;
    });
  return { list: parsed };
}

export const builtinSnippets = compileSnippets(DEFAULT_SNIPPETS);

/** Global snippet state (single-editor app; reconfigured via reloadSnippets). */
export const snippetStore: { enabled: boolean; compiled: CompiledSnippetList } = {
  enabled: true,
  compiled: builtinSnippets,
};

export function reloadSnippets(raws: RawSnippet[] | null, enabled: boolean) {
  snippetStore.enabled = enabled;
  snippetStore.compiled = raws ? compileSnippets(raws) : builtinSnippets;
}

export interface ParsedReplacement {
  text: string;
  /** Tabstop index → ranges in the produced text. */
  stops: { index: number; from: number; to: number }[];
}

/** latex-suite replacement escaping: only `\$` and `\\` are escapes; any
 *  other `\x` keeps the backslash (so `\[[1]]` = literal "\" + group ref,
 *  and `\{` in \left\{ survives). */
const ESCAPABLE = new Set(["$", "\\"]);

/** Expands latex-suite replacement syntax into plain text + tabstops:
 *  `$0`… tabstops, `${0:default}` with placeholder text, `[[n]]` regex group
 *  references, `${VISUAL}` the visual selection, `\x` escapes for the chars
 *  in ESCAPABLE (anything else after `\` stays literal).
 *
 *  `raw: true` 是**函数型 replacement 的返回值**通道:latex-suite 里函数返回值
 *  原样入档,只做制表位扫描(`process` 直接采信返回值,`[[n]]`/`\$`/`\\` 的
 *  处理都在解析期对**字符串型** replacement 做)。少了这条通道,函数返回的
 *  `\\`(矩阵行分隔)会被当转义吃掉一层,矩阵直接渲染错。 */
export function parseReplacement(
  replacement: string,
  groups: string[],
  visualText: string | null,
  raw = false,
): ParsedReplacement {
  let out = "";
  const stops: ParsedReplacement["stops"] = [];
  let i = 0;
  const n = replacement.length;

  while (i < n) {
    const ch = replacement[i];

    if (!raw && ch === "\\" && i + 1 < n) {
      const next = replacement[i + 1];
      if (ESCAPABLE.has(next)) {
        out += next;
        i += 2;
      } else {
        out += "\\";
        i += 1;
      }
      continue;
    }

    if (ch === "$") {
      if (!raw && replacement.startsWith("${VISUAL}", i)) {
        out += visualText ?? "";
        i += "${VISUAL}".length;
        continue;
      }
      if (replacement[i + 1] === "{") {
        const close = replacement.indexOf("}", i + 2);
        if (close !== -1) {
          const inner = replacement.slice(i + 2, close);
          const colon = inner.indexOf(":");
          if (colon > 0 && /^\d+$/.test(inner.slice(0, colon))) {
            const index = Number(inner.slice(0, colon));
            const def = inner.slice(colon + 1);
            stops.push({ index, from: out.length, to: out.length + def.length });
            out += def;
            i = close + 1;
            continue;
          }
        }
        out += "${";
        i += 2;
        continue;
      }
      const digits = /^\d+/.exec(replacement.slice(i + 1));
      if (digits) {
        const index = Number(digits[0]);
        stops.push({ index, from: out.length, to: out.length });
        i += 1 + digits[0].length;
        continue;
      }
      out += "$";
      i += 1;
      continue;
    }

    if (!raw && ch === "[") {
      const group = /^\[\[(\d+)\]\]/.exec(replacement.slice(i));
      if (group) {
        const gi = Number(group[1]);
        out += groups[gi] ?? "";
        i += group[0].length;
        continue;
      }
      out += "[";
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { text: out, stops };
}

export interface MatchResult {
  snippet: ParsedSnippet;
  start: number; // replacement region start in the document
  end: number; // cursor position (replacement region end)
  replacement: ParsedReplacement;
}

/** latex-suite 的 `removeSnippetWhitespace`:行内公式里展开后不留多余空格
 *  (`$ …$` 里结尾的空格会被 KaTeX 吃掉却让源码难看)。两种尾部形态:
 *  以空格结尾 → 去掉所有尾随空格;末三字符是 `" $" + 数字`(即 `${n}` 制表位
 *  前有空格) → 只去掉那个空格,制表位保留。其余形态原样。 */
export function trimSnippetWhitespace(replacement: string): string {
  if (replacement.endsWith(" ")) return replacement.trimEnd();
  const tail = replacement.slice(-3);
  if (tail.length === 3 && tail.slice(0, 2) === " $" && /^\d$/.test(tail[2])) {
    return replacement.slice(0, -3) + replacement.slice(-2);
  }
  return replacement;
}

/** 展开文本:函数型 replacement 的入参随片段类型而定(正则 → exec 结果数组,
 *  字符串 → trigger,可视 → 选中文本);返回非字符串视为该片段不匹配。
 *  `raw` 标记"来自函数"——它的返回值不再过转义层(见 parseReplacement)。 */
function resolveReplacement(
  snippet: ParsedSnippet,
  arg: string | RegExpExecArray,
  visualText: string | null,
): { text: string; raw: boolean } | null {
  const r = snippet.replacement;
  if (typeof r !== "function") return { text: r, raw: false };
  const out = snippet.visual && visualText !== null ? r(visualText) : r(arg);
  return typeof out === "string" ? { text: out, raw: true } : null;
}

export interface MatchOptions {
  auto: boolean;
  visualText: string | null;
  /** latex-suite `removeSnippetWhitespace`(默认开,与插件默认一致)。 */
  removeSnippetWhitespace?: boolean;
  /** latex-suite `wordDelimiters`(缺省用插件默认集,见 config.ts)。 */
  wordDelimiters?: string;
}

/** Finds the best snippet matching the text right before `cursor`. */
export function findSnippet(
  state: EditorState,
  cursor: number,
  typedKey: string | null,
  opts: MatchOptions,
): MatchResult | null {
  const { compiled } = snippetStore;
  const line = state.doc.lineAt(cursor);
  const prefix = state.sliceDoc(line.from, cursor);
  const ctx = getContextAt(state, cursor);
  const delimiters = opts.wordDelimiters ?? LATEX_SUITE_WORD_DELIMITERS;
  // 只在行内公式里修剪(块级公式的换行前空格是排版的一部分)。
  const trim = (opts.removeSnippetWhitespace ?? true) && ctx.inlineMath;

  for (const snippet of compiled.list) {
    if (opts.auto && !snippet.auto) continue;

    // Visual snippets only fire when there is a selection to operate on.
    if (snippet.visual) {
      if (opts.visualText === null) continue;
      if (typeof snippet.trigger !== "string" || snippet.trigger !== typedKey) continue;
    } else if (opts.visualText !== null) {
      // Selection being replaced: only visual snippets apply.
      continue;
    }

    if (!matchesContext(snippet, ctx)) continue;

    if (snippet.regex && snippet.anchored) {
      snippet.anchored.lastIndex = 0;
      const m = snippet.anchored.exec(prefix);
      if (!m) continue;
      if (snippet.word && !isWordBoundary(state, cursor - m[0].length, cursor, delimiters)) continue;
      const res = resolveReplacement(snippet, m, opts.visualText);
      if (res === null) continue;
      // latex-suite semantics: [[0]] refers to the FIRST capture group,
      // so pass m.slice(1) and index [[n]] → m[n+1].
      const groups = m.slice(1);
      return {
        snippet,
        start: cursor - m[0].length,
        end: cursor,
        replacement: parseReplacement(
          trim ? trimSnippetWhitespace(res.text) : res.text,
          groups,
          opts.visualText,
          res.raw,
        ),
      };
    }

    const trigger = snippet.trigger as string;
    if (typedKey !== null && !trigger.endsWith(typedKey)) continue;
    if (!prefix.endsWith(trigger)) continue;
    const start = cursor - trigger.length;
    if (snippet.word && !isWordBoundary(state, start, cursor, delimiters)) continue;
    const res = resolveReplacement(snippet, trigger, opts.visualText);
    if (res === null) continue;
    return {
      snippet,
      start,
      end: cursor,
      replacement: parseReplacement(
        trim ? trimSnippetWhitespace(res.text) : res.text,
        [],
        opts.visualText,
        res.raw,
      ),
    };
  }
  return null;
}

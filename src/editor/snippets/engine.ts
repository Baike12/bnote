import type { EditorState } from "@codemirror/state";
import { getContextAt, type EditContext } from "../context";
import { DEFAULT_SNIPPETS, type RawSnippet } from "./default-snippets";
import { DEFAULT_SNIPPET_VARIABLES } from "./default-variables";

/** Character set treated as word delimiters for `w` (word-boundary) snippets. */
export const WORD_DELIMITERS = "., +-\\n\t:;!?\\/{}[]()=~$'\"|`<>*^%#@&";

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
  replacement: string;
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

function isWordBoundary(state: EditorState, triggerPos: number, cursor: number): boolean {
  const prev = triggerPos <= 0 ? "" : state.sliceDoc(triggerPos - 1, triggerPos);
  const next = cursor >= state.doc.length ? "" : state.sliceDoc(cursor, cursor + 1);
  // CJK and other non-ASCII characters count as boundaries — without this,
  // "测试dm" would never expand for Chinese notes.
  const boundary = (ch: string) => ch === "" || /[^\x00-\x7F]/.test(ch) || WORD_DELIMITERS.includes(ch);
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

const ESCAPABLE = new Set(["$", "[", "]", "{", "}", "\\"]);

/** Expands latex-suite replacement syntax into plain text + tabstops:
 *  `$0`… tabstops, `${0:default}` with placeholder text, `[[n]]` regex group
 *  references, `${VISUAL}` the visual selection, `\x` escapes for the chars
 *  in ESCAPABLE (anything else after `\` stays literal). */
export function parseReplacement(
  replacement: string,
  groups: string[],
  visualText: string | null,
): ParsedReplacement {
  let out = "";
  const stops: ParsedReplacement["stops"] = [];
  let i = 0;
  const n = replacement.length;

  while (i < n) {
    const ch = replacement[i];

    if (ch === "\\" && i + 1 < n) {
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
      if (replacement.startsWith("${VISUAL}", i)) {
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

    if (ch === "[") {
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

/** Finds the best snippet matching the text right before `cursor`. */
export function findSnippet(
  state: EditorState,
  cursor: number,
  typedKey: string | null,
  opts: { auto: boolean; visualText: string | null },
): MatchResult | null {
  const { compiled } = snippetStore;
  const line = state.doc.lineAt(cursor);
  const prefix = state.sliceDoc(line.from, cursor);
  const ctx = getContextAt(state, cursor);

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
      if (snippet.word && !isWordBoundary(state, cursor - m[0].length, cursor)) continue;
      // latex-suite semantics: [[0]] refers to the FIRST capture group,
      // so pass m.slice(1) and index [[n]] → m[n+1].
      const groups = m.slice(1);
      return {
        snippet,
        start: cursor - m[0].length,
        end: cursor,
        replacement: parseReplacement(snippet.replacement, groups, opts.visualText),
      };
    }

    const trigger = snippet.trigger as string;
    if (typedKey !== null && !trigger.endsWith(typedKey)) continue;
    if (!prefix.endsWith(trigger)) continue;
    const start = cursor - trigger.length;
    if (snippet.word && !isWordBoundary(state, start, cursor)) continue;
    return {
      snippet,
      start,
      end: cursor,
      replacement: parseReplacement(
        snippet.replacement,
        [],
        opts.visualText,
      ),
    };
  }
  return null;
}

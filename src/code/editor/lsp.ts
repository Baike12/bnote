import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { hoverTooltip, type EditorView } from "@codemirror/view";
import { forceLinting, linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { codeApi } from "../api";
import { useCodeStore } from "../store";
import type { LspDiagnostic, LspRange } from "../types";
import { activeCodeEditor, handleForView } from "./registry";
import { cmToLspPosition, lspRangeToCm } from "./positions";
import { completionRequestContext, triggerCharacterFor } from "./completionTrigger";

/**
 * Bridge between the language server and CodeMirror.
 *
 * Three jobs:
 * - completion (completion source): turn the LSP CompletionItem into a CM
 *   Completion;
 * - hover (hover tooltip): display the LSP MarkupContent;
 * - diagnostics (linter): turn the diagnostics pushed by the backend into CM
 *   Diagnostics marked on the lines.
 *
 * The jump actions (definition / references / rename) live in `goto.ts` — they
 * have to open a file and switch tabs, not just move the caret.
 *
 * The position conversion lives in `positions.ts`; the URI encoding in
 * `uri.ts`.
 */

/** LSP CompletionItemKind → CM completion type. */
const KIND_TO_TYPE: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "constructor",
  5: "field",
  6: "variable",
  7: "class",
  8: "interface",
  9: "namespace",
  10: "property",
  11: "unit",
  12: "constant",
  13: "enum",
  14: "keyword",
  15: "snippet",
  16: "type",
  17: "text",
  18: "text",
  19: "folder",
  20: "constant",
  21: "constant",
  22: "class",
  23: "text",
  24: "operator",
  25: "type",
};

/** Diagnostic severity (LSP) → CM severity. */
const SEVERITY_TO_CM: Record<number, CmDiagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** The LSP documentation field → plain text. */
export function documentationToText(doc: unknown): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc;
  if (Array.isArray(doc)) {
    return doc
      .map((d) => documentationToText(d))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof doc === "object") {
    const value = (doc as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return "";
}

/** Turn one LSP diagnostic into a CM Diagnostic. */
export function toCmDiagnostic(d: LspDiagnostic, doc: Text): CmDiagnostic {
  const range = d.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const { from, to } = lspRangeToCm(doc, range as LspRange);
  return {
    from,
    to,
    severity: SEVERITY_TO_CM[d.severity] ?? "error",
    message: d.message,
    source: d.source ?? undefined,
  };
}

/**
 * Completion source: hand the caret position to the language server and use
 * the candidates it returns.
 *
 * No server / a null answer / an error all quietly yield no candidates (no
 * error popup).
 */
export async function lspCompletion(context: CompletionContext): Promise<CompletionResult | null> {
  const handle = activeCodeEditor();
  if (!handle) return null;
  // `matchBefore(/[\w$]*/)` always matches (an empty match is a match too),
  // so "no word started yet" has to be decided by whether the text is empty —
  // looking at the return value alone makes this guard dead code and would ask
  // the server on every punctuation keystroke.
  const word = context.matchBefore(/[\w$]*/);
  const typed = word?.text ?? "";
  // No word yet, but the caret may sit right after a trigger character: `np.`
  // is exactly where the members are wanted (see completionTrigger.ts). Without
  // this branch the request was never sent and the panel stayed empty.
  const trigger = typed
    ? null
    : triggerCharacterFor(
        context.pos > 0 ? context.state.sliceDoc(context.pos - 1, context.pos) : "",
      );
  if (!typed && !trigger && !context.explicit) return null;

  const raw = await codeApi
    .lspRequest(handle.root, handle.language, "textDocument/completion", handle.path, {
      position: cmToLspPosition(handle.view.state.doc, context.pos),
      context: completionRequestContext(trigger),
    })
    .catch(() => null);
  if (!raw) return null;

  const items = completionItemsOf(raw);
  if (items.length === 0) return null;
  const options = items
    .map((item) => toCompletion(item))
    .filter((c): c is Completion => c !== null);
  if (options.length === 0) return null;
  return { from: word ? word.from : context.pos, options, validFor: /^[\w$]*$/ };
}

/** The LSP completion result has two shapes: an array, or `{items:[...]}`. */
function completionItemsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const items = (raw as { items?: unknown }).items;
    if (Array.isArray(items)) return items as Record<string, unknown>[];
  }
  return [];
}

/** One LSP CompletionItem → CM Completion. */
export function toCompletion(item: Record<string, unknown>): Completion | null {
  const label = typeof item.label === "string" ? item.label : null;
  if (!label) return null;
  const completion: Completion = {
    label,
    detail: typeof item.detail === "string" ? item.detail : undefined,
    type: KIND_TO_TYPE[Number(item.kind)] ?? "text",
    boost: item.preselect ? 1 : 0,
  };
  const info = documentationToText(item.documentation);
  if (info) completion.info = info;

  const edit = item.textEdit as { range?: LspRange; newText?: string } | undefined;
  if (edit?.range && typeof edit.newText === "string") {
    const range = edit.range;
    const newText = edit.newText;
    completion.apply = (view, _c, _from, _to) => {
      const r = lspRangeToCm(view.state.doc, range);
      view.dispatch({
        changes: { from: r.from, to: r.to, insert: newText },
        selection: { anchor: r.from + newText.length },
        userEvent: "input.complete",
      });
    };
  } else if (typeof item.insertText === "string" && item.insertText !== label) {
    completion.apply = item.insertText;
  } else if (typeof item.textEditText === "string" && item.textEditText !== label) {
    completion.apply = item.textEditText;
  }
  return completion;
}

/**
 * Hover tooltip.
 *
 * The content is rendered as plain text (no HTML injection): the hover of a
 * language server often carries markdown, but injecting it into the page as
 * HTML is an injection surface. Escaped and laid out line by line, the code
 * look survives while the risk does not.
 */
export const lspHoverTooltip = hoverTooltip(async (view, pos) => {
  // Find the file by **this view**, not by "the focused one": hovering with
  // the mouse does not change the focus.
  const handle = handleForView(view);
  if (!handle) return null;
  const raw = await codeApi
    .lspRequest(handle.root, handle.language, "textDocument/hover", handle.path, {
      position: cmToLspPosition(view.state.doc, pos),
    })
    .catch(() => null);
  if (!raw) return null;
  const contents = (raw as { contents?: unknown }).contents;
  const text = documentationToText(contents);
  if (!text.trim()) return null;
  return {
    pos,
    end: pos,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-code-hover";
      for (const line of text.split("\n")) {
        const p = document.createElement("div");
        p.textContent = line;
        dom.appendChild(p);
      }
      return { dom };
    },
  };
});

/**
 * Diagnostics: read the diagnostics the backend pushed into the store and mark
 * them on the lines.
 *
 * The diagnostics are **pushed** (a publishDiagnostics event), not pulled, so
 * this reads the cache; `forceLinting` has to be called for the linter to run
 * again when the cache changes (see `refreshDiagnostics`).
 */
export const lspDiagnosticsLinter = linter(
  (view) => {
    // Find the file by **this view**, not by "the focused one": when the focus
    // is not on the editor the latter would pick a different file and the
    // diagnostics would land in the wrong place.
    const handle = handleForView(view);
    if (!handle) return [];
    const list = useCodeStore.getState().diagnostics[handle.path] ?? [];
    return list.map((d) => toCmDiagnostic(d, view.state.doc));
  },
  { delay: 120 },
);

/** The diagnostic cache changed, make the editor redraw the diagnostic marks. */
export function refreshDiagnostics(view: EditorView | null): void {
  if (!view) return;
  forceLinting(view);
}

import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { hoverTooltip, type EditorView } from "@codemirror/view";
import { forceLinting, linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { codeApi } from "../api";
import { useCodeStore } from "../store";
import type { LspDiagnostic, LspRange } from "../types";
import { activeCodeEditor, handleForView } from "./registry";
import { cmToLspPosition, lspRangeToCm } from "./positions";

/**
 * 语言服务器 ↔ CodeMirror 的桥。
 *
 * 三件事:
 * - 补全(completion source):把 LSP 的 CompletionItem 翻成 CM 的 Completion;
 * - 悬停(hover tooltip):把 LSP 的 MarkupContent 显示出来;
 * - 诊断(linter):把后端推来的诊断变成 CM 的 Diagnostic 标在行上。
 *
 * 跳转类动作(定义 / 引用 / 重命名)在 `goto.ts`——它们要开文件、切标签,
 * 不只是改光标。
 *
 * 位置换算在 `positions.ts`;URI 编解码在 `uri.ts`。
 */

/** LSP 的 CompletionItemKind → CM 的 completion type。 */
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

/** 诊断严重度(LSP)→ CM 的 severity。 */
const SEVERITY_TO_CM: Record<number, CmDiagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** LSP 的 documentation 字段 → 纯文本。 */
export function documentationToText(doc: unknown): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc;
  if (Array.isArray(doc)) {
    return doc.map((d) => documentationToText(d)).filter(Boolean).join("\n\n");
  }
  if (typeof doc === "object") {
    const value = (doc as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return "";
}

/** 把一条 LSP 诊断变成 CM 的 Diagnostic。 */
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
 * 补全源:把光标位置交给语言服务器,回来的候选直接用。
 *
 * 没有服务器 / 服务器回 null / 出错,都安静地不给候选(不弹错误)。
 */
export async function lspCompletion(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const handle = activeCodeEditor();
  if (!handle) return null;
  // 词没开始(光标前面是标点)且不是手动触发 → 不问服务器。
  const word = context.matchBefore(/[\w$]*/);
  if (!word && !context.explicit) return null;

  const raw = await codeApi
    .lspRequest(
      handle.root,
      handle.language,
      "textDocument/completion",
      handle.path,
      {
        position: cmToLspPosition(handle.view.state.doc, context.pos),
        context: { triggerKind: context.explicit ? 1 : 2 },
      },
    )
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

/** LSP 的 completion 结果有两种形状:数组,或 `{items:[...]}`。 */
function completionItemsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const items = (raw as { items?: unknown }).items;
    if (Array.isArray(items)) return items as Record<string, unknown>[];
  }
  return [];
}

/** 一条 LSP CompletionItem → CM Completion。 */
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

  const edit = item.textEdit as
    | { range?: LspRange; newText?: string }
    | undefined;
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
 * 悬停提示。
 *
 * 内容按纯文本渲染(不注入 HTML):语言服务器的 hover 常带 markdown,但把它
 * 当 HTML 插进页面就是注入面。转义后按行排版,代码感还在,风险没有。
 */
export const lspHoverTooltip = hoverTooltip(async (view, pos) => {
  const handle = activeCodeEditor();
  if (!handle) return null;
  const raw = await codeApi
    .lspRequest(
      handle.root,
      handle.language,
      "textDocument/hover",
      handle.path,
      { position: cmToLspPosition(view.state.doc, pos) },
    )
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
 * 诊断:读 store 里后端推来的诊断,标到行上。
 *
 * 诊断是**推**来的(publishDiagnostics 事件),不是拉的,所以这里读缓存;
 * 缓存变了要 `forceLinting` 才会重跑(见 `refreshDiagnostics`)。
 */
export const lspDiagnosticsLinter = linter((view) => {
  // 按**这个视图**找文件,不按「当前聚焦的」:焦点不在编辑器上时,后者会
  // 取到别的文件,诊断就贴错地方了。
  const handle = handleForView(view);
  if (!handle) return [];
  const list = useCodeStore.getState().diagnostics[handle.path] ?? [];
  return list.map((d) => toCmDiagnostic(d, view.state.doc));
}, { delay: 120 });

/** 诊断缓存变了,让编辑器重画一遍诊断标记。 */
export function refreshDiagnostics(view: EditorView | null): void {
  if (!view) return;
  forceLinting(view);
}

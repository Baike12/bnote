/**
 * A quoted code selection, in the form the Agent input receives it.
 *
 * The Agent speaks plain text (there are no ACP content blocks to hang a
 * resource on), so the quote has to carry everything the model needs by
 * itself: where the code lives, which lines it is, and the code. The shape is
 * `path:12-18` (the convention greps, compilers and editors all print)
 * followed by a fenced block, and the coding system prompt documents it
 * (`prompt.rs`, the "conventions in user messages" block).
 *
 * It is the text form of Zed's `agent::AddSelectionToThread`: there the input
 * shows a `main.rs (12:18)` chip and the send turns it into a resource block
 * with the file URI; here the visible text and the model input are the same
 * thing, which is why the path and the line range are part of the text.
 */
export interface CodeQuote {
  /** Path as the agent addresses the file: project-relative in code mode. */
  path: string;
  /** 1-based, inclusive (the editor's own line numbering). */
  startLine: number;
  endLine: number;
  /** The selected text as it stands in the buffer (unsaved edits included). */
  text: string;
  /** Fence info string — the LSP languageId, empty when unknown. */
  language: string;
}

export function formatCodeQuote(quote: CodeQuote): string {
  const lines =
    quote.startLine === quote.endLine
      ? `${quote.startLine}`
      : `${quote.startLine}-${quote.endLine}`;
  // A linewise selection carries its trailing newline; keeping it would leave a
  // blank line between the code and the closing fence.
  const body = quote.text.replace(/\n+$/, "");
  return `${quote.path}:${lines}\n\`\`\`${quote.language}\n${body}\n\`\`\`\n`;
}

import type { LspRange } from "../types";

/**
 * An LSP WorkspaceEdit → "file → a set of text edits".
 *
 * Servers use two shapes, and **only one of them at a time**:
 * - `changes`: `{ [uri]: TextEdit[] }` — the older shape;
 * - `documentChanges`: `TextDocumentEdit[]` — what most servers today (and
 *   the standard rename implementation of every language) send.
 *
 * The old implementation only read `changes`, so "rename" silently returned
 * false against a modern server. The specification allows both to appear, so
 * they are merged by uri.
 */

/** The edits to apply to one file (positions are LSP coordinates). */
export interface WorkspaceFileEdit {
  /** The file URI (`file://…`). */
  uri: string;
  edits: { range: LspRange; newText: string }[];
}

/** One TextEdit (shapes that do not fit are dropped on the way: annotations, missing fields). */
function textEditsOf(raw: unknown): { range: LspRange; newText: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { range: LspRange; newText: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const edit = item as { range?: LspRange; newText?: unknown };
    const range = edit.range;
    if (!range || !range.start || !range.end) continue;
    if (typeof range.start.line !== "number" || typeof range.start.character !== "number") continue;
    if (typeof range.end.line !== "number" || typeof range.end.character !== "number") continue;
    if (typeof edit.newText !== "string") continue;
    out.push({ range, newText: edit.newText });
  }
  return out;
}

/** Flatten the WorkspaceEdit of the server into a list of edits grouped by file. */
export function workspaceEditsOf(edit: unknown): WorkspaceFileEdit[] {
  if (!edit || typeof edit !== "object") return [];
  const merged = new Map<string, { range: LspRange; newText: string }[]>();
  const add = (uri: unknown, raw: unknown): void => {
    if (typeof uri !== "string" || !uri) return;
    const edits = textEditsOf(raw);
    if (edits.length === 0) return;
    const existing = merged.get(uri);
    if (existing) existing.push(...edits);
    else merged.set(uri, edits);
  };

  const changes = (edit as { changes?: unknown }).changes;
  if (changes && typeof changes === "object" && !Array.isArray(changes)) {
    for (const [uri, raw] of Object.entries(changes)) add(uri, raw);
  }

  const documentChanges = (edit as { documentChanges?: unknown }).documentChanges;
  if (Array.isArray(documentChanges)) {
    for (const item of documentChanges) {
      if (!item || typeof item !== "object") continue;
      // CreateFile / RenameFile / DeleteFile (which carry a `kind`) can be
      // mixed in here: they have no textDocument.edits, so add() skips them
      // as an empty edit.
      const doc = item as { textDocument?: { uri?: unknown }; edits?: unknown };
      add(doc.textDocument?.uri, doc.edits);
    }
  }

  return [...merged].map(([uri, edits]) => ({ uri, edits }));
}

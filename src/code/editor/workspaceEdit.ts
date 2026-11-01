import type { LspRange } from "../types";

/**
 * LSP 的 WorkspaceEdit → 「文件 → 一组文本编辑」。
 *
 * 服务器给两种形状,而且**只给其中一种**:
 * - `changes`: `{ [uri]: TextEdit[] }` —— 早期形状;
 * - `documentChanges`: `TextDocumentEdit[]` —— 现在多数服务器(包括各语言
 *   rename 的标准实现)只给这个。
 *
 * 旧实现只读 `changes`,于是「重命名」对着现代服务器直接静默返回 false。
 * 规范允许两者同时出现,按 uri 合并。
 */

/** 一个文件上要做的编辑(位置是 LSP 坐标)。 */
export interface WorkspaceFileEdit {
  /** 文件 URI(`file://…`)。 */
  uri: string;
  edits: { range: LspRange; newText: string }[];
}

/** 一条 TextEdit(顺手挡掉形状不对的:annotations、缺失字段)。 */
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

/** 把服务器的 WorkspaceEdit 摊平成按文件分组的编辑列表。 */
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
      // 这里还可能混着 CreateFile / RenameFile / DeleteFile(带 `kind`):
      // 它们没有 textDocument.edits,add() 会当空编辑跳过。
      const doc = item as { textDocument?: { uri?: unknown }; edits?: unknown };
      add(doc.textDocument?.uri, doc.edits);
    }
  }

  return [...merged].map(([uri, edits]) => ({ uri, edits }));
}

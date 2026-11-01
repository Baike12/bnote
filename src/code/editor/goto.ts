import { codeApi } from "../api";
import { useCodeStore } from "../store";
import type { LspPosition, LspRange } from "../types";
import { activeCodeEditor } from "./registry";
import { cmToLspPosition } from "./positions";
import { decodeFileUri } from "./uri";
import { applyTextEdits } from "./textEdits";

/**
 * 跳转类动作:跳到定义、跳到引用、重命名。
 *
 * 它们的共同形状是「向语言服务器要一批位置 → 把位置变成项目里的文件与
 * 行」,所以定位与换算都收在这一层,UI 只负责「跳过去 / 列出来」。
 */

/** 语言服务器回的一个位置(可能是 Location 或 LocationLink)。 */
interface RawLocation {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
}

/** 归一成「项目相对路径 + 位置」。 */
export interface CodeTarget {
  /** 项目相对路径;不在项目内时是绝对路径(带 `!` 前缀标记)。 */
  path: string;
  position: LspPosition;
  /** 这个位置在项目外吗(外部依赖、库源码)。 */
  external: boolean;
}

/** 把服务器的 uri 变成项目相对路径。 */
function toTarget(uri: string, range: LspRange | undefined, root: string): CodeTarget | null {
  const abs = decodeFileUri(uri);
  if (!abs) return null;
  const position = range?.start ?? { line: 0, character: 0 };
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (abs.startsWith(prefix)) {
    return { path: abs.slice(prefix.length), position, external: false };
  }
  return { path: abs, position, external: true };
}

/** 归一服务器的返回(数组 / 单个 / LocationLink 混合)。 */
function normalizeLocations(raw: unknown): RawLocation[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as RawLocation[];
  if (typeof raw === "object") return [raw as RawLocation];
  return [];
}

/** 发一个「要位置」的请求,归一成项目内的目标列表。 */
async function requestTargets(method: string): Promise<CodeTarget[]> {
  const handle = activeCodeEditor();
  if (!handle) return [];
  const raw = await codeApi
    .lspRequest(
      handle.root,
      handle.language,
      method,
      handle.path,
      { position: cmToLspPosition(handle.view.state.doc, handle.view.state.selection.main.head) },
    )
    .catch(() => null);
  if (!raw) return [];
  return normalizeLocations(raw)
    .map((loc) => {
      const uri = loc.uri ?? loc.targetUri;
      const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
      return uri ? toTarget(uri, range, handle.root) : null;
    })
    .filter((t): t is CodeTarget => t !== null);
}

/**
 * 跳到定义(也用于类型定义、实现):要一个就跳第一个,要多个就列出来。
 *
 * 跳转会切标签页——所以先让 store 把文件打开,再由编辑器把光标落到位。
 */
export async function gotoDefinition(method = "textDocument/definition"): Promise<void> {
  const targets = await requestTargets(method);
  const first = targets[0];
  if (!first) return;
  const store = useCodeStore.getState();
  await store.openFile(first.path);
  store.requestJump(first.path, first.position);
}

/** 找出所有引用,填进引用面板。 */
export async function findReferences(): Promise<void> {
  const handle = activeCodeEditor();
  if (!handle) return;
  const raw = await codeApi
    .lspRequest(
      handle.root,
      handle.language,
      "textDocument/references",
      handle.path,
      {
        position: cmToLspPosition(handle.view.state.doc, handle.view.state.selection.main.head),
        context: { includeDeclaration: true },
      },
    )
    .catch(() => null);
  const targets = normalizeLocations(raw)
    .map((loc) => {
      const uri = loc.uri ?? loc.targetUri;
      const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
      return uri ? toTarget(uri, range, handle.root) : null;
    })
    .filter((t): t is CodeTarget => t !== null);
  useCodeStore.getState().setReferences(targets);
}

/**
 * 重命名符号。
 *
 * 流程:先 `prepareRename` 拿到可改的区间(有的服务器不给,那就跳过这步),
 * 再 `rename` 拿 WorkspaceEdit,最后把 edit 落到磁盘上改动的那些文件。
 *
 * WorkspaceEdit 的文本编辑是按位置给的:同一文件里多处修改要**从后往前**
 * 应用,前面的偏移才不会因为前面的改动而失效。
 */
export async function renameSymbol(newName: string): Promise<boolean> {
  const handle = activeCodeEditor();
  if (!handle) return false;
  const position = cmToLspPosition(
    handle.view.state.doc,
    handle.view.state.selection.main.head,
  );
  const prepared = await codeApi
    .lspRequest(handle.root, handle.language, "textDocument/prepareRename", handle.path, {
      position,
    })
    .catch(() => null);
  // prepareRename 不同意改名(返回 null)就别硬来。
  if (prepared === null) return false;

  const edit = await codeApi
    .lspRequest(handle.root, handle.language, "textDocument/rename", handle.path, {
      position,
      newName,
    })
    .catch(() => null);
  if (!edit || typeof edit !== "object") return false;

  const changes = (edit as { changes?: Record<string, unknown> }).changes;
  if (!changes) return false;
  const root = handle.root;
  const prefix = root.endsWith("/") ? root : `${root}/`;

  for (const [uri, edits] of Object.entries(changes)) {
    const abs = decodeFileUri(uri);
    if (!abs) continue;
    if (!abs.startsWith(prefix)) continue; // 项目外的文件不改
    const rel = abs.slice(prefix.length);
    const file = await codeApi.readFile(root, rel);
    if (file.binary) continue;
    const text = applyTextEdits(file.content, edits);
    await codeApi.writeFile(root, rel, text);
  }
  // 本地编辑器里的内容也要刷新:重读当前文件。
  const store = useCodeStore.getState();
  if (store.files[handle.path]) {
    const fresh = await codeApi.readFile(root, handle.path);
    store.replaceContent(handle.path, fresh.content);
  }
  await store.refreshGit();
  return true;
}


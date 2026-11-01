import { codeApi } from "../api";
import { useCodeStore } from "../store";
import { useAppStore } from "@/state/appStore";
import type { LspPosition, LspRange } from "../types";
import { activeCodeEditor } from "./registry";
import { cmToLspPosition } from "./positions";
import { decodeFileUri } from "./uri";
import { applyTextEdits } from "./textEdits";
import { workspaceEditsOf } from "./workspaceEdit";

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
  // 项目外的位置(标准库、node_modules、Rust 源码)打不开:后端只放行项目根
  // 内的路径。如实告诉用户,别去撞一个必然失败的 openFile。
  const first = targets.find((t) => !t.external);
  if (!first) {
    if (targets.length > 0) {
      useAppStore.getState().showToast("定义在项目外(依赖或标准库),不在这个面板里打开");
    }
    return;
  }
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
 * 两条纪律:
 * 1. **以缓冲区为底**:打开着的文件可能带着未保存的改动,必须拿 buffer 的
 *    内容算新文本(不是盘上的旧文本),否则用户没保存的编辑会被 rename 的
 *    结果整篇覆盖掉;
 * 2. **先算完再写**:所有文件的新文本都算好才动盘——读盘或解析中途失败时
 *    一个文件都没改。写盘本身没法跨文件原子,写到一半失败只能如实报错。
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
  // WorkspaceEdit 有两种形状,两种都要认(见 workspaceEdit.ts)。
  const fileEdits = workspaceEditsOf(edit);
  if (fileEdits.length === 0) return false;

  const root = handle.root;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const next = new Map<string, string>();

  for (const { uri, edits } of fileEdits) {
    const abs = decodeFileUri(uri);
    if (!abs || !abs.startsWith(prefix)) continue; // 项目外的文件不改
    const rel = abs.slice(prefix.length);
    const open = useCodeStore.getState().files[rel];
    let base = open?.content;
    if (base === undefined) {
      const file = await codeApi.readFile(root, rel).catch(() => null);
      if (!file || file.binary) continue;
      base = file.content;
    }
    next.set(rel, applyTextEdits(base, edits));
  }
  if (next.size === 0) return false;

  try {
    for (const [rel, text] of next) {
      await codeApi.writeFile(root, rel, text);
      // 打开着的文件:缓冲区换成刚落盘的内容(标记为已保存)。不刷的话,
      // 那个标签还是旧文本,下次保存又把重命名覆盖回去了。
      if (useCodeStore.getState().files[rel]) {
        useCodeStore.getState().replaceContent(rel, text);
      }
    }
  } catch (e) {
    useAppStore.getState().showToast(`重命名失败: ${String(e)}`);
    return false;
  }
  await useCodeStore.getState().refreshGit();
  return true;
}


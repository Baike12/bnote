import { codeApi } from "../api";
import { useCodeStore } from "../store";
import { useAppStore } from "@/state/appStore";
import type { LspPosition, LspRange } from "../types";
import { activeCodeEditor } from "./registry";
import { cmToLspPosition } from "./positions";
import { decodeFileUri } from "./uri";
import { applyTextEdits } from "./textEdits";
import { workspaceEditsOf } from "./workspaceEdit";
import { planGoto, shortPath, unavailableReasonOf } from "./gotoPlan";

/**
 * The jump actions: go to definition, go to references, rename.
 *
 * They share the same shape — "ask the language server for a batch of
 * positions → turn the positions into files and lines inside the project" —
 * so the locating and the conversion are collected here and the UI only
 * handles "jump there / list them".
 */

/** One location returned by the language server (a Location or a LocationLink). */
interface RawLocation {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
}

/** Normalized into "project-relative path + position". */
export interface CodeTarget {
  /** Project-relative path; an absolute path when it is outside the project (marked with a `!` prefix). */
  path: string;
  position: LspPosition;
  /** Is this location outside the project (external dependency, library source)? */
  external: boolean;
}

/** A server position counts only when it is two finite, non-negative numbers. */
function toPosition(value: unknown): LspPosition | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return ok(v.line) && ok(v.character) ? { line: v.line, character: v.character } : null;
}

/** Turn the uri of the server into a project-relative path. */
function toTarget(uri: string, range: LspRange | undefined, root: string): CodeTarget | null {
  const abs = decodeFileUri(uri);
  // A location without a usable start cannot be jumped to: the jump effect
  // builds a CodeMirror offset from it, and a non-finite offset throws inside
  // the editor (doc.lineAt), which unmounts the app.
  const position = toPosition(range?.start);
  if (!abs || !position) return null;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (abs.startsWith(prefix)) {
    return { path: abs.slice(prefix.length), position, external: false };
  }
  return { path: abs, position, external: true };
}

/** Normalize the answer of the server (array / single / mixed with LocationLink). */
function normalizeLocations(raw: unknown): RawLocation[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as RawLocation[];
  if (typeof raw === "object") return [raw as RawLocation];
  return [];
}

/**
 * The answer of a "give me positions" request.
 *
 * Three different things used to collapse into one empty list: no server,
 * a server that never answered, and a server that answered "nothing here".
 * The UI then said nothing at all, so a dead LSP looked exactly like a
 * keybinding that was never bound.
 */
type TargetReply =
  | { kind: "targets"; targets: CodeTarget[] }
  /** No code editor is live (the command's `when` guard should have stopped it). */
  | { kind: "no-editor" }
  /** The request never reached a server: it is not running, or it died / timed out. */
  | { kind: "server-down"; reason: "not-running" | "unreachable" }
  | { kind: "failed"; message: string };

/** Send a "give me positions" request and normalize it into a reply. */
async function requestTargets(
  method: string,
  extra: Record<string, unknown> = {},
): Promise<TargetReply> {
  const handle = activeCodeEditor();
  if (!handle) return { kind: "no-editor" };
  let raw: unknown;
  try {
    raw = await codeApi.lspRequest(handle.root, handle.language, method, handle.path, {
      position: cmToLspPosition(handle.view.state.doc, handle.view.state.selection.main.head),
      ...extra,
    });
  } catch (e) {
    // The backend reports "cannot ask" as an error (see commands/code.rs): a
    // null answer means the server really found nothing, so it is not one.
    const message = String(e);
    const reason = unavailableReasonOf(message);
    return reason ? { kind: "server-down", reason } : { kind: "failed", message };
  }
  // A null answer is the server's own verdict: nothing at this position.
  const targets = (raw == null ? [] : normalizeLocations(raw))
    .map((loc) => {
      const uri = loc.uri ?? loc.targetUri;
      const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
      return uri ? toTarget(uri, range, handle.root) : null;
    })
    .filter((t): t is CodeTarget => t !== null);
  return { kind: "targets", targets };
}

/** Say why a jump / references request got no answer at all. */
function reportUnavailable(reply: TargetReply): void {
  const toast = useAppStore.getState().showToast;
  if (reply.kind === "server-down") {
    const why = reply.reason === "not-running" ? "没在运行" : "没有响应";
    toast(`语言服务器${why},无法跳转(命令面板里执行「重启语言服务器」后再试)`);
  } else if (reply.kind === "failed") {
    toast(`语言服务器请求失败:${reply.message}`);
  }
}

/**
 * Go to definition (also used for type definition and implementation): with
 * one target jump to the first, with several list them.
 *
 * A jump switches tabs — so the store opens the file first and the editor
 * then places the caret.
 *
 * Every outcome is reported. A silent return is indistinguishable from a dead
 * keybinding, which is exactly how "⌘J does nothing" felt: the request was
 * fine, the answer was a stub outside the project.
 */
export async function gotoDefinition(method = "textDocument/definition"): Promise<void> {
  const reply = await requestTargets(method);
  if (reply.kind !== "targets") {
    reportUnavailable(reply);
    return;
  }
  const plan = planGoto(reply.targets);
  if (plan.kind === "none") {
    useAppStore.getState().showToast("当前位置没有可跳转的定义");
    return;
  }
  // Locations outside the project (the standard library, node_modules, the
  // Rust sources) cannot be opened: the backend only lets paths inside the
  // project root through. Name the place instead of running into an openFile
  // that is bound to fail.
  if (plan.kind === "outside") {
    useAppStore
      .getState()
      .showToast(`定义在项目外:${shortPath(plan.target.path)}(项目外的文件不在这个面板打开)`);
    return;
  }
  const store = useCodeStore.getState();
  await store.navigateTo(plan.target.path, plan.target.position);
}

/** Find all references and put them into the references panel. */
export async function findReferences(): Promise<void> {
  const reply = await requestTargets("textDocument/references", {
    context: { includeDeclaration: true },
  });
  if (reply.kind !== "targets") {
    reportUnavailable(reply);
    return;
  }
  // An empty list is visible feedback on its own: the panel says "no
  // references" (see Panels.tsx).
  useCodeStore.getState().setReferences(reply.targets);
}

/**
 * Rename a symbol.
 *
 * The flow: `prepareRename` first to get the range that may be renamed (some
 * servers do not provide it, then this step is skipped), then `rename` to get
 * the WorkspaceEdit, and finally apply the edit to the changed files on disk.
 *
 * Two rules:
 * 1. **the buffer is the base**: an open file may carry unsaved changes, so
 *    the new text has to be computed from the buffer content (not the old
 *    text on disk), otherwise the user's unsaved edits would be overwritten
 *    wholesale by the result of the rename;
 * 2. **compute everything before writing**: the new text of all files is
 *    computed before anything touches the disk — if reading a file or parsing
 *    fails halfway, not a single file has changed. Writing to disk cannot be
 *    atomic across files, so a failure halfway through can only be reported
 *    honestly.
 */
export async function renameSymbol(newName: string): Promise<boolean> {
  const handle = activeCodeEditor();
  if (!handle) return false;
  const position = cmToLspPosition(handle.view.state.doc, handle.view.state.selection.main.head);
  const prepared = await codeApi
    .lspRequest(handle.root, handle.language, "textDocument/prepareRename", handle.path, {
      position,
    })
    .catch(() => null);
  // When prepareRename refuses the rename (returns null), do not force it.
  if (prepared === null) return false;

  const edit = await codeApi
    .lspRequest(handle.root, handle.language, "textDocument/rename", handle.path, {
      position,
      newName,
    })
    .catch(() => null);
  // A WorkspaceEdit has two shapes, both have to be recognized (see
  // workspaceEdit.ts).
  const fileEdits = workspaceEditsOf(edit);
  if (fileEdits.length === 0) return false;

  const root = handle.root;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const next = new Map<string, string>();

  for (const { uri, edits } of fileEdits) {
    const abs = decodeFileUri(uri);
    if (!abs || !abs.startsWith(prefix)) continue; // files outside the project are not modified
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
      // For an open file: replace the buffer with the text just written to
      // disk (marked as saved). Without this the tab still holds the old text
      // and the next save would overwrite the rename again.
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

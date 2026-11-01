import { EditorState, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { documentPath } from "@/editor/docPath";
import { findEditorFor } from "@/editor/api";
import { DONE_STAMP_RE } from "@/editor/ops";
import { joinPath } from "@/lib/path";
import { normalizeTemplateDir, renderTemplate } from "@/templates/template";
import type { DailyLink, LinkStore } from "./links";
import { scheduleLinksPersist } from "./links";
import {
  appendEntrySpec,
  blockEnd,
  blockLines,
  blockRootLine,
  composeDailyScaffold,
  dailyPathFor,
  dailyScaffold,
  findEntryByText,
  isDailyPath,
  isTodo,
  parseDailyRegion,
  parseListLine,
  prependEntrySpec,
  previousDailyFile,
  removeEntrySpec,
  replaceEntrySpec,
  resolveRootLine,
  reindentBlock,
  rolloverBlocks,
  textAfterChanges,
  todoText,
  todoTextAt,
  type DocChange,
} from "./model";

/**
 * Cross-file todo sync engine.
 *
 * Model: a link binds a source todo block (the root plus its subtree) to one
 * top-level entry of the todo region at the head of the daily note. The identity
 * is the todo text (checkbox and done stamp stripped); mirroring keeps the text
 * identical on both sides, so the two sides recognize each other by text and the
 * line numbers are only a proximity hint.
 *
 * Event model (first principles: every check, child todo and rename ends up as a
 * document transaction, so we diff at line level in one single entry point instead
 * of chasing call sites):
 *  - The identity text of the block holding a changed line hits a link (old or
 *    new text, a rename migrates the anchor) -> mirror: move the whole current
 *    block of the changed side to the other side (re-indented, the checkbox and
 *    the done stamp travel with the text).
 *  - A touched todo block without a link -> auto send: copy the block (root plus
 *    its subtree) as a top-level entry of today's daily note and create an `auto`
 *    link - it syncs as soon as it exists, no shortcut and no prior check needed;
 *    unchecking a recorded root then clears it from the daily note and unlinks it.
 *  - The source root is no longer a todo -> delete the daily note entry and unlink
 *    it; the daily note root is no longer a todo -> unlink only (the user is
 *    tidying today's list, the project todos stay untouched).
 *
 * Write discipline: after every await we re-prove that the view still holds this
 * document (stale work is dropped); read-modify-write of files outside the editor
 * runs under a per-path serial lock; writing back into an open editor uses a
 * tagged dispatch, and the listener skips that tag to avoid a loop.
 */

// ---------------------------------------------------------------- dependency injection

export interface DailyIO {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /** File names inside the vault-relative directory `relPath` (no subdirectories); null on failure or when it does not exist. */
  readDir(relPath: string): Promise<string[] | null>;
}

export interface DailyDeps {
  io: DailyIO;
  vaultRoot: () => string | null;
  today: () => string;
  toast: (msg: string) => void;
  /** Template file used to scaffold a new daily note (vault-relative path); null/empty = the default `# YYYY-MM-DD` opening. */
  templatePath: () => string | null;
}

/** Tag the engine puts on a transaction when writing back into an open editor; a listener seeing it skips the transaction (loop guard). */
export const SYNC_USER_EVENT = "input.bnote-daily-sync";

function uuid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Serialize read-modify-write on the same file on disk (mirroring, recording and sending may originate from different source files). */
const fileChains = new Map<string, Promise<void>>();
export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileChains.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileChains.set(path, next.then(() => undefined, () => undefined));
  return next;
}

// ---------------------------------------------------------------- intent extraction

export type Intent =
  | { type: "mirror"; linkId: string; rootHint: number | null; renamedTo: string | null }
  | { type: "send"; rootHint: number; text: string };

/** Identity text of a block root appearing in the slice -> its root line (the first one). */
function rootTextsOfSlice(doc: Text, fromNo: number, toNo: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let n = fromNo; n <= toNo; n++) {
    const root = blockRootLine(doc, n);
    const t = todoTextAt(doc, root);
    if (t !== null && !out.has(t)) out.set(t, root);
  }
  return out;
}

/** The identity text of the line itself or of any ancestor hits a link (it is already mirrored by some link). */
function lineLinked(doc: Text, lineNo: number, fileLinks: DailyLink[]): boolean {
  const self = todoTextAt(doc, lineNo);
  if (self !== null && fileLinks.some((l) => l.text === self)) return true;
  const start = parseListLine(doc.line(lineNo).text);
  if (!start) return false;
  let depth = start.indent.length;
  for (let n = lineNo - 1; n >= 1; n--) {
    const p = parseListLine(doc.line(n).text);
    if (!p) break;
    if (p.indent.length < depth) {
      if (isTodo(p) && fileLinks.some((l) => l.text === todoText(p))) return true;
      depth = p.indent.length;
      if (depth === 0) break;
    }
  }
  return false;
}

/**
 * Changed range of one transaction (old and new document coordinates) -> sync
 * intents. The line numbers are only hints, the execution side relocates by text;
 * the real decision depends on the identity text alone.
 */
export function intentsForRange(
  startDoc: Text,
  endDoc: Text,
  fromA: number,
  toA: number,
  fromB: number,
  toB: number,
  fileLinks: DailyLink[],
  allowSend: boolean,
): Intent[] {
  if (fileLinks.length === 0 && !allowSend) return [];
  const oldFrom = startDoc.lineAt(fromA).number;
  const oldTo = (toA > fromA ? startDoc.lineAt(toA - 1) : startDoc.lineAt(fromA)).number;
  const newFrom = endDoc.lineAt(fromB).number;
  const newTo = (toB > fromB ? endDoc.lineAt(toB - 1) : endDoc.lineAt(fromB)).number;
  const intents: Intent[] = [];
  const newRoots = rootTextsOfSlice(endDoc, newFrom, newTo);

  if (fileLinks.length > 0) {
    const oldRoots = rootTextsOfSlice(startDoc, oldFrom, oldTo);
    // First block root of the new slice: root line hint plus the identity text after
    // a rename (null when the root turned into plain text -> treated as gone)
    const newFirstRootNo = blockRootLine(endDoc, newFrom);
    const newFirstRootText = todoTextAt(endDoc, newFirstRootNo);
    for (const link of fileLinks) {
      const hitOld = oldRoots.has(link.text);
      const hitNew = newRoots.has(link.text);
      if (!hitOld && !hitNew) continue;
      intents.push({
        type: "mirror",
        linkId: link.id,
        rootHint: hitNew ? (newRoots.get(link.text) ?? null) : newFirstRootText !== null ? newFirstRootNo : null,
        renamedTo: newFirstRootText,
      });
    }
  }

  // Auto sync: a touched todo block without a link is sent as a whole block to
  // today's daily note - no shortcut and no prior check needed. The decision uses
  // the identity text alone; empty text (still typing) is not sent; a block that is
  // already linked (through itself or an ancestor) goes through mirroring and is
  // not sent twice; the target text of a rename in this round is skipped as well
  // (the link migrates there, findByText on the apply side covers that race). The
  // caller turns allowSend off for paste and drag and drop.
  if (allowSend) {
    const renamed = new Set(
      intents.flatMap((i) => (i.type === "mirror" && i.renamedTo ? [i.renamedTo] : [])),
    );
    for (const [text, rootNo] of newRoots) {
      if (text === "") continue;
      if (fileLinks.some((l) => l.text === text)) continue;
      if (renamed.has(text)) continue;
      if (lineLinked(endDoc, rootNo, fileLinks)) continue;
      intents.push({ type: "send", rootHint: rootNo, text });
    }
  }
  return intents;
}

/** Merge duplicate intents within one debounce round: mirrors take the union of their hints per link, sends take the first per text. */
export function dedupeIntents(intents: Intent[]): Intent[] {
  const mirrors = new Map<string, { rootHint: number | null; renamedTo: string | null }>();
  const sends = new Map<string, { rootHint: number; text: string }>();
  for (const it of intents) {
    if (it.type === "mirror") {
      const cur = mirrors.get(it.linkId);
      mirrors.set(it.linkId, {
        rootHint: it.rootHint ?? cur?.rootHint ?? null,
        renamedTo: it.renamedTo ?? cur?.renamedTo ?? null,
      });
    } else if (!sends.has(it.text)) {
      sends.set(it.text, { rootHint: it.rootHint, text: it.text });
    }
  }
  const out: Intent[] = [];
  for (const [linkId, h] of mirrors) out.push({ type: "mirror", linkId, rootHint: h.rootHint, renamedTo: h.renamedTo });
  for (const s of sends.values()) out.push({ type: "send", rootHint: s.rootHint, text: s.text });
  return out;
}

// ---------------------------------------------------------------- execution

function viewAlive(view: EditorView, path: string): boolean {
  return view.dom.isConnected && documentPath(view.state) === path;
}

export async function applyIntents(
  view: EditorView,
  path: string,
  intents: Intent[],
  deps: DailyDeps,
  store: LinkStore,
): Promise<void> {
  for (const it of dedupeIntents(intents)) {
    if (it.type === "mirror") {
      const link = store.getById(it.linkId);
      if (link) await applyMirror(view, path, link, it.rootHint, it.renamedTo, deps, store);
    } else {
      await applySend(view, path, it.rootHint, it.text, deps, store);
    }
  }
}

function parseDoc(text: string): Text {
  return EditorState.create({ doc: text }).doc;
}

/** Flip a todo line from `[x]` to `[ ]` and strip the done stamp (same behaviour as toggleTodo and a click). */
function uncheckSpecs(doc: Text, lineNo: number): { changes: { from: number; to?: number; insert: string }[] } | null {
  const line = doc.line(lineNo);
  const p = parseListLine(line.text);
  if (!isTodo(p) || p.box === " ") return null;
  const markFrom = line.from + p.indent.length + p.marker.length + p.gap.length;
  const stamp = DONE_STAMP_RE.exec(p.text);
  const textEnd = markFrom + 3 + (stamp ? stamp.index : p.text.length);
  const changes = [{ from: markFrom + 1, to: markFrom + 2, insert: " " }];
  if (stamp) changes.push({ from: textEnd, to: line.to, insert: "" });
  return { changes };
}

/**
 * Where the change on the other side lands: patch the in-memory document when the
 * file is open in an editor, otherwise write it to disk.
 *
 * In the project view the project card and the daily note in the right column can
 * both be open, so both sides of a mirror may be "alive". Writing to disk would let
 * the stale content of the editor overwrite this change on the next save, so with
 * an open editor we dispatch instead. The position must be computed against one
 * and the same baseline: with an editor it is the editor's in-memory document (the
 * file on disk may lag behind unsaved input), without one it is the disk text just
 * read.
 */
function commitSpecs(
  deps: DailyDeps,
  path: string,
  baseText: string,
  specs: DocChange[],
  editor: EditorView | null,
): Promise<void> | void {
  if (editor && editor.dom.isConnected && documentPath(editor.state) === path) {
    editor.dispatch({ changes: specs, userEvent: SYNC_USER_EVENT });
    return;
  }
  return deps.io.writeFile(path, textAfterChanges(baseText, specs));
}

/** Current content of the other side plus the "baseline editor": with an editor the in-memory document (newest), otherwise the file on disk. */
async function readOther(
  deps: DailyDeps,
  path: string,
): Promise<{ text: string | null; editor: EditorView | null }> {
  const editor = findEditorFor(path);
  if (editor) return { text: editor.state.doc.toString(), editor };
  return { text: await deps.io.readFile(path).catch(() => null), editor: null };
}

async function applyMirror(
  view: EditorView,
  path: string,
  link: DailyLink,
  rootHint: number | null,
  renamedTo: string | null,
  deps: DailyDeps,
  store: LinkStore,
): Promise<void> {
  if (!viewAlive(view, path)) return;
  const side = path === link.srcPath ? "src" : "daily";
  const otherPath = side === "src" ? link.dailyPath : link.srcPath;
  await withFileLock(otherPath, async () => {
    if (!viewAlive(view, path)) return;
    const other = await readOther(deps, otherPath);
    if (!viewAlive(view, path)) return; // the file was switched away while we were reading: stale, drop it
    if (other.text === null) {
      // The other side is gone (deleted or renamed): unlink it, no more mirroring
      store.remove(link.id);
      scheduleLinksPersist();
      return;
    }
    const otherText = other.text;
    const otherDoc = parseDoc(otherText);
    const doc = view.state.doc;
    const texts = renamedTo && renamedTo !== link.text ? [renamedTo, link.text] : [link.text];
    const rootNo = resolveRootLine(doc, texts, rootHint);
    const root = rootNo !== null ? parseListLine(doc.line(rootNo).text) : null;

    // Recorded link: the root got unchecked -> clear this entry from the daily
    // note (holds no matter which side triggered it)
    if (isTodo(root) && link.kind === "recorded" && root.box === " ") {
      if (side === "src") {
        // The source side was unchecked: delete the daily note entry and unlink
        const region = parseDailyRegion(otherDoc);
        const entry = findEntryByText(otherDoc, region, link.text, link.dailyLine);
        if (entry) await commitSpecs(deps, otherPath, otherText, [removeEntrySpec(otherDoc, entry)], other.editor);
      } else {
        // The daily side was unchecked: drop the local entry and flip the source todo back to unfinished
        removeLocalEntry(view, doc, link, store);
        const srcRootNo = resolveRootLine(otherDoc, [link.text], link.srcLine);
        const specs = srcRootNo !== null ? uncheckSpecs(otherDoc, srcRootNo)?.changes : null;
        if (specs) await commitSpecs(deps, otherPath, otherText, specs, other.editor);
      }
      store.remove(link.id);
      scheduleLinksPersist();
      return;
    }

    if (!rootNo || !isTodo(root)) {
      // The root is no longer a todo (deleted or turned into prose). Gone on the
      // source side -> delete the daily note entry; gone on the daily side -> the
      // user is tidying today's list, so only unlink and leave the project todos
      // alone.
      if (side === "src") {
        const region = parseDailyRegion(otherDoc);
        const entry = findEntryByText(otherDoc, region, link.text, link.dailyLine);
        if (entry) await commitSpecs(deps, otherPath, otherText, [removeEntrySpec(otherDoc, entry)], other.editor);
      }
      store.remove(link.id);
      scheduleLinksPersist();
      return;
    }

    const block = blockLines(doc, rootNo);
    if (side === "src") {
      const region = parseDailyRegion(otherDoc);
      const entry = findEntryByText(otherDoc, region, link.text, link.dailyLine);
      if (!entry) {
        // The user deleted the daily note entry = unlink, do not resurrect it
        // (to sync again, press the shortcut again)
        store.remove(link.id);
        scheduleLinksPersist();
        return;
      }
      const reindented = reindentBlock(block, root.indent.length, "");
      await commitSpecs(deps, otherPath, otherText, [replaceEntrySpec(otherDoc, entry, reindented)], other.editor);
      store.update(link.id, { text: todoText(root), srcLine: rootNo, dailyLine: entry.start });
    } else {
      const srcRootNo = resolveRootLine(otherDoc, [link.text], link.srcLine);
      const srcRoot = srcRootNo !== null ? parseListLine(otherDoc.line(srcRootNo).text) : null;
      if (!srcRootNo || !isTodo(srcRoot)) {
        // The source todo is gone: delete the daily note entry and unlink
        removeLocalEntry(view, doc, link, store);
        store.remove(link.id);
        scheduleLinksPersist();
        return;
      }
      const reindented = reindentBlock(block, 0, srcRoot.indent);
      await commitSpecs(
        deps,
        otherPath,
        otherText,
        [
          {
            from: otherDoc.line(srcRootNo).from,
            to: otherDoc.line(blockEnd(otherDoc, srcRootNo)).to,
            insert: reindented.join("\n"),
          },
        ],
        other.editor,
      );
      store.update(link.id, { text: todoText(root), srcLine: srcRootNo, dailyLine: rootNo });
    }
    scheduleLinksPersist();
  });
}

/** Remove the entry of a link from the open daily note editor (when it is not found, only unlink). */
function removeLocalEntry(view: EditorView, doc: Text, link: DailyLink, store: LinkStore): void {
  const region = parseDailyRegion(doc);
  const entry = findEntryByText(doc, region, link.text, link.dailyLine);
  if (entry) view.dispatch({ changes: removeEntrySpec(doc, entry), userEvent: SYNC_USER_EVENT });
  store.remove(link.id);
  scheduleLinksPersist();
}

/**
 * Execution side of "auto sync": a touched todo block without a link is copied as
 * a whole block to a top-level entry of today's daily note (no check needed, the
 * checked state travels with the line), and a persistent link of kind `auto` is
 * created so mirroring keeps both sides in sync. When the daily note already holds
 * an entry with the same text it is claimed as is (an entry carried over by
 * rollover or pasted by hand is never appended twice). The send command
 * (sendTodoToDaily) takes the same write path, only the kind of the link differs.
 */
async function applySend(
  view: EditorView,
  path: string,
  rootHint: number,
  text: string,
  deps: DailyDeps,
  store: LinkStore,
): Promise<void> {
  const vaultRoot = deps.vaultRoot();
  if (!vaultRoot || !viewAlive(view, path)) return;
  const dailyPath = dailyPathFor(vaultRoot, deps.today());
  await withFileLock(dailyPath, async () => {
    if (!viewAlive(view, path)) return;
    const daily = await readOther(deps, dailyPath);
    if (!viewAlive(view, path)) return;
    const doc = view.state.doc;
    const rootNo = resolveRootLine(doc, [text], rootHint);
    const root = rootNo !== null ? parseListLine(doc.line(rootNo).text) : null;
    if (!rootNo || !isTodo(root)) return; // the block vanished or turned into prose during the debounce window: do not send
    if (text === "") return; // still typing
    if (store.findByText(path, text, rootNo)) return; // a link exists already (race): mirroring will pick it up
    const block = blockLines(doc, rootNo);
    const reindented = reindentBlock(block, root.indent.length, "");
    const base = daily.text ?? (await dailyScaffoldWithRollover(deps.io, vaultRoot, deps.today(), deps.templatePath()));
    const bdoc = parseDoc(base);
    const region = parseDailyRegion(bdoc);
    const existing = findEntryByText(bdoc, region, text, 0);
    let dailyLine: number;
    if (existing) {
      // The daily note already holds an entry with the same text (carried over by
      // rollover or pasted by hand): claim it as the mirror root
      dailyLine = existing.start;
    } else {
      const { change } = appendEntrySpec(bdoc, region, reindented);
      const ndoc = parseDoc(textAfterChanges(base, [change]));
      dailyLine =
        findEntryByText(ndoc, parseDailyRegion(ndoc), text, Number.MAX_SAFE_INTEGER)?.start ?? 1;
      await commitSpecs(deps, dailyPath, base, [change], daily.editor);
    }
    store.upsert({
      id: uuid(),
      kind: "auto",
      day: deps.today(),
      srcPath: path,
      dailyPath,
      text,
      srcLine: rootNo,
      dailyLine,
    });
    scheduleLinksPersist();
  });
}

// ---------------------------------------------------------------- todo rollover

/**
 * Initial content of a new day's daily note: the template (used when configured,
 * with the variables replaced by the day's date) plus the unfinished todos of the
 * previous note (todo rollover, the rule lives in model.rolloverBlocks). The
 * "previous note" is the most recent one in Daily/ that is older than today.
 * Rollover and template are enhancements, not obligations: if the directory
 * cannot be listed, the previous note cannot be read or the template cannot be
 * read, every failure folds back to the default content and never blocks the
 * creation of the daily note. All creation entry points (⌘⇧O open, ⌘⇧J send,
 * check-and-record, project send, daily column) go through here, so whoever
 * creates it first, the bytes on disk are identical.
 */
export async function dailyScaffoldWithRollover(
  io: DailyIO,
  vaultRoot: string,
  today: string,
  templatePath: string | null = null,
): Promise<string> {
  const base = await dailyBase(io, vaultRoot, today, templatePath);
  try {
    const names = await io.readDir("Daily");
    if (!names) return base;
    const prev = previousDailyFile(names, today);
    if (!prev) return base;
    const prevText = await io.readFile(dailyPathFor(vaultRoot, prev));
    if (prevText === null) return base;
    return composeDailyScaffold(today, rolloverBlocks(prevText), base);
  } catch {
    return base;
  }
}

/**
 * Starting point of the body of a new daily note: when a template file is
 * configured it is read and `{{date}}` / `{{title}}` are replaced by the day's
 * date; when there is none or it cannot be read (file deleted or renamed) we fall
 * back to the default `# YYYY-MM-DD`. The template content lands in the file
 * verbatim, and the todo region still follows the first H1 by the rules of
 * parseDailyRegion.
 */
async function dailyBase(
  io: DailyIO,
  vaultRoot: string,
  today: string,
  templatePath: string | null,
): Promise<string> {
  const fallback = dailyScaffold(today);
  const rel = normalizeTemplateDir(templatePath ?? "");
  if (!rel) return fallback;
  try {
    const text = await io.readFile(joinPath(vaultRoot, rel));
    return text === null ? fallback : renderTemplate(text, { date: today, title: today });
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- send command

/**
 * The link whose identity text `text` in `srcPath` points at the daily note
 * `dailyPath`. Links belong to a day: a link created yesterday points at
 * yesterday's file and takes no part in the "is it already synced today" check.
 */
function linkForDaily(store: LinkStore, srcPath: string, dailyPath: string, text: string): DailyLink | null {
  for (const l of store.all()) {
    if (l.srcPath === srcPath && l.dailyPath === dailyPath && l.text === text) return l;
  }
  return null;
}

/** The link of any **ancestor** todo of that line on `dailyPath` (the line itself is judged by the caller). */
function ancestorLinkForDaily(
  doc: Text,
  lineNo: number,
  srcPath: string,
  dailyPath: string,
  store: LinkStore,
): DailyLink | null {
  const start = parseListLine(doc.line(lineNo).text);
  if (!start) return null;
  let depth = start.indent.length;
  for (let n = lineNo - 1; n >= 1; n--) {
    const p = parseListLine(doc.line(n).text);
    if (!p) break;
    if (p.indent.length < depth) {
      if (isTodo(p)) {
        const l = linkForDaily(store, srcPath, dailyPath, todoText(p));
        if (l) return l;
      }
      depth = p.indent.length;
      if (depth === 0) break;
    }
  }
  return null;
}

/**
 * "Send todo to today's daily note": the todo line under the cursor (one per line
 * for multiple cursors) is copied to a top-level entry of today's daily note, the
 * pressed line decides - pressing on a child todo makes that child the top-level
 * entry of the daily note while its own subtree keeps its hierarchy. After the
 * persistent link is created, mirroring keeps both sides in sync.
 *
 * The "already synced" decision does not look at the link record itself but at
 * whether today's daily note really holds that entry: the link is only a cached
 * anchor and goes stale once the daily note is deleted or the entry is removed by
 * hand. A stale link is unlinked in place and the entry is sent again - this is
 * what keeps the promise "to sync again, press the shortcut again". Project todos
 * live long while the daily note is created per day, so only links pointing at
 * today's file count; yesterday's do not, and they are not removed by today's send
 * either (yesterday's list stays as it is).
 *
 * A recorded link is promoted to a regular link when it is sent explicitly.
 */
export async function sendTodoToDaily(
  view: EditorView,
  deps: DailyDeps,
  store: LinkStore,
  /** append = end of today's list (chronological); prepend = front of the todo region (send and drag in the project view). */
  position: "append" | "prepend" = "append",
): Promise<void> {
  const vaultRoot = deps.vaultRoot();
  if (!vaultRoot) {
    deps.toast("没有打开仓库");
    return;
  }
  const srcPath = documentPath(view.state);
  if (!srcPath) {
    deps.toast("没有打开的笔记");
    return;
  }
  if (isDailyPath(srcPath)) {
    deps.toast("日记文件的头部就是待办列表,无需发送");
    return;
  }
  const today = deps.today();
  const dailyPath = dailyPathFor(vaultRoot, today);
  await withFileLock(dailyPath, async () => {
    const daily = await readOther(deps, dailyPath);
    /** When today's daily note is open in an editor the change is dispatched in place, nothing is written to disk afterwards. */
    const dailyEditor = daily.editor;
    let dailyText: string | null = daily.text;
    let mutated = false;
    let linksDirty = false;
    let sent = 0;
    let already = 0;
    let notTodo = 0;
    /** Whether today's daily note (including what this round appended) already holds this entry. */
    const dailyHas = (text: string): boolean => {
      if (dailyText === null) return false;
      const d = parseDoc(dailyText);
      return findEntryByText(d, parseDailyRegion(d), text, 0) !== null;
    };
    const seenLines = new Set<number>();
    for (const range of view.state.selection.ranges) {
      const lineNo = view.state.doc.lineAt(range.head).number;
      if (seenLines.has(lineNo)) continue;
      seenLines.add(lineNo);
      const doc = view.state.doc;
      const line = doc.line(lineNo);
      const l = parseListLine(line.text);
      if (!isTodo(l) || todoText(l) === "") {
        notTodo++;
        continue;
      }
      const text = todoText(l);
      const own = linkForDaily(store, srcPath, dailyPath, text);
      if (own && dailyHas(text)) {
        // Already linked; an explicit send promotes a "recorded" link to a regular link
        if (own.kind === "recorded") {
          own.kind = "copied";
          linksDirty = true;
        }
        already++;
        continue;
      }
      if (own) {
        // Stale link (today's daily note was deleted or the entry removed by hand): unlink and resend as a new entry
        store.remove(own.id);
        linksDirty = true;
      } else {
        const anc = ancestorLinkForDaily(doc, lineNo, srcPath, dailyPath, store);
        if (anc) {
          if (dailyHas(anc.text)) {
            already++; // mirrored along with the parent todo, it is already in the daily note
            continue;
          }
          store.remove(anc.id); // the parent's entry is gone too, so the parent's link is stale as well
          linksDirty = true;
        }
      }
      const block = blockLines(doc, lineNo);
      const reindented = reindentBlock(block, l.indent.length, "");
      if (dailyText === null) dailyText = await dailyScaffoldWithRollover(deps.io, vaultRoot, today, deps.templatePath());
      const bdoc = parseDoc(dailyText);
      const region = parseDailyRegion(bdoc);
      const existing = findEntryByText(bdoc, region, text, 0);
      let dailyLine: number;
      if (existing) {
        dailyLine = existing.start; // an entry with the same text exists: claim it, do not append twice
      } else {
        const { change } =
          position === "prepend"
            ? prependEntrySpec(bdoc, region, reindented)
            : appendEntrySpec(bdoc, region, reindented);
        const newDaily = textAfterChanges(dailyText, [change]);
        const ndoc = parseDoc(newDaily);
        dailyLine =
          findEntryByText(ndoc, parseDailyRegion(ndoc), text, Number.MAX_SAFE_INTEGER)?.start ?? 1;
        if (dailyEditor && dailyEditor.dom.isConnected && documentPath(dailyEditor.state) === dailyPath) {
          dailyEditor.dispatch({ changes: change, userEvent: SYNC_USER_EVENT });
          dailyText = dailyEditor.state.doc.toString();
        } else {
          dailyText = newDaily;
        }
      }
      store.upsert({
        id: uuid(),
        kind: "copied",
        day: today,
        srcPath,
        dailyPath,
        text,
        srcLine: lineNo,
        dailyLine,
      });
      mutated = true;
      linksDirty = true;
      sent++;
    }
    // When the daily note is open in an editor the change is already in memory
    // (autosave will write it), writing to disk again would leave the stale
    // content of the editor in memory and the next save would overwrite it.
    const useEditor =
      dailyEditor !== null &&
      dailyEditor.dom.isConnected &&
      documentPath(dailyEditor.state) === dailyPath;
    if (mutated && dailyText !== null && !useEditor) {
      await deps.io.writeFile(dailyPath, dailyText);
    }
    if (linksDirty) scheduleLinksPersist();
    if (sent > 0) deps.toast(sent === 1 ? "已发送到今日日记" : `已发送 ${sent} 条到今日日记`);
    else if (already > 0) deps.toast("已在今日日记中,自动保持同步");
    else if (notTodo > 0) deps.toast("光标行不是待办");
  });
}

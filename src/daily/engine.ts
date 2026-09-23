import { EditorState, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { documentPath } from "@/editor/docPath";
import { DONE_STAMP_RE } from "@/editor/ops";
import type { DailyLink, LinkStore } from "./links";
import { scheduleLinksPersist } from "./links";
import {
  appendEntrySpec,
  blockEnd,
  blockLines,
  blockRootLine,
  dailyPathFor,
  findEntryByText,
  isDailyPath,
  isTodo,
  parseDailyRegion,
  parseListLine,
  removeEntrySpec,
  replaceEntrySpec,
  resolveRootLine,
  reindentBlock,
  textAfterChanges,
  todoText,
  todoTextAt,
} from "./model";

/**
 * 跨文件待办同步引擎。
 *
 * 模型:一条链接把「源待办块(根 + 其子树)」和「日记头部待办区的一条一级
 * 条目」绑在一起,身份是待办文本(剥 checkbox/✅戳);镜像保证两侧文本一致,
 * 所以互认靠文本、行号只是就近提示。
 *
 * 事件模型(第一性:所有勾选/子待办/改名最终都是文档事务,在唯一入口做行级
 * diff,不追逐任何调用点):
 *  - 变更行所在块的身份文本命中某条链接(旧或新文本,改名即迁移锚) → 镜像:
 *    把变更侧当前块整段搬到对侧(重缩进、checkbox/✅戳随文本走)。
 *  - 单行原位翻转 ` `→`x` 且祖先链未链接 → 记录:块(该行 + 其子树)复制为
 *    今日日记的一级条目;记录型根再取消 → 从日记清掉并解链。
 *  - 源侧根不再是待办 → 删日记条目并解链;日记侧根不再是待办 → 只解链
 *    (用户在整理今天的列表,不动项目里的待办)。
 *
 * 写入纪律:每个 await 之后重新自证视图还装着这份文档(过期放弃);盘外文件
 * 的读改写在 per-path 串行锁里;写回打开中的编辑器用带标记的 dispatch,
 * 监听器据此跳过,防回环。
 */

// ---------------------------------------------------------------- 依赖注入

export interface DailyIO {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface DailyDeps {
  io: DailyIO;
  vaultRoot: () => string | null;
  today: () => string;
  toast: (msg: string) => void;
}

/** 引擎写回打开编辑器时给事务打的标记;监听器看到它直接跳过(防回环)。 */
export const SYNC_USER_EVENT = "input.bnote-daily-sync";

function uuid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 同一份磁盘文件的读改写串行化(镜像/记录/发送可能来自不同源文件)。 */
const fileChains = new Map<string, Promise<void>>();
function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileChains.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileChains.set(path, next.then(() => undefined, () => undefined));
  return next;
}

// ---------------------------------------------------------------- 意图提取

export type Intent =
  | { type: "mirror"; linkId: string; rootHint: number | null; renamedTo: string | null }
  | { type: "record"; rootHint: number; text: string };

/** 切片内出现的块根身份文本 → 根行号(首个)。 */
function rootTextsOfSlice(doc: Text, fromNo: number, toNo: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let n = fromNo; n <= toNo; n++) {
    const root = blockRootLine(doc, n);
    const t = todoTextAt(doc, root);
    if (t !== null && !out.has(t)) out.set(t, root);
  }
  return out;
}

/** 该行自身或任一祖先的待办身份文本命中链接(即已随某个链接镜像)。 */
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
 * 一次事务改动范围(旧/新文档坐标)→ 同步意图。行号都是提示,执行端会按
 * 文本重新定位;真正的判定只依赖身份文本。
 */
export function intentsForRange(
  startDoc: Text,
  endDoc: Text,
  fromA: number,
  toA: number,
  fromB: number,
  toB: number,
  fileLinks: DailyLink[],
  allowRecord: boolean,
): Intent[] {
  if (fileLinks.length === 0 && !allowRecord) return [];
  const oldFrom = startDoc.lineAt(fromA).number;
  const oldTo = (toA > fromA ? startDoc.lineAt(toA - 1) : startDoc.lineAt(fromA)).number;
  const newFrom = endDoc.lineAt(fromB).number;
  const newTo = (toB > fromB ? endDoc.lineAt(toB - 1) : endDoc.lineAt(fromB)).number;
  const intents: Intent[] = [];

  if (fileLinks.length > 0) {
    const oldRoots = rootTextsOfSlice(startDoc, oldFrom, oldTo);
    const newRoots = rootTextsOfSlice(endDoc, newFrom, newTo);
    // 新切片首个块根:根行提示 + 改名后的身份文本(根变纯文本时为 null → 视为消失)
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

  // 记录:单行原位翻转 ` `→`x`(⌘L / 点击 / vim 映射的完成动作),且该行
  // 不在任何链接块里。粘贴/拖放不是「标记为完成」,由调用方关掉 allowRecord。
  if (allowRecord && oldFrom === oldTo && newFrom === newTo) {
    const oldL = parseListLine(startDoc.line(oldFrom).text);
    const newL = parseListLine(endDoc.line(newFrom).text);
    if (isTodo(oldL) && isTodo(newL) && oldL.box === " " && newL.box === "x" && !lineLinked(endDoc, newFrom, fileLinks)) {
      intents.push({ type: "record", rootHint: newFrom, text: todoText(newL) });
    }
  }
  return intents;
}

/** 同一轮防抖里合并重复意图:镜像按链接取并集提示,记录按文本取首个。 */
export function dedupeIntents(intents: Intent[]): Intent[] {
  const mirrors = new Map<string, { rootHint: number | null; renamedTo: string | null }>();
  const records = new Map<string, { rootHint: number; text: string }>();
  for (const it of intents) {
    if (it.type === "mirror") {
      const cur = mirrors.get(it.linkId);
      mirrors.set(it.linkId, {
        rootHint: it.rootHint ?? cur?.rootHint ?? null,
        renamedTo: it.renamedTo ?? cur?.renamedTo ?? null,
      });
    } else if (!records.has(it.text)) {
      records.set(it.text, { rootHint: it.rootHint, text: it.text });
    }
  }
  const out: Intent[] = [];
  for (const [linkId, h] of mirrors) out.push({ type: "mirror", linkId, rootHint: h.rootHint, renamedTo: h.renamedTo });
  for (const r of records.values()) out.push({ type: "record", rootHint: r.rootHint, text: r.text });
  return out;
}

// ---------------------------------------------------------------- 执行

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
      await applyRecord(view, path, it.rootHint, it.text, deps, store);
    }
  }
}

function parseDoc(text: string): Text {
  return EditorState.create({ doc: text }).doc;
}

/** 待办行翻转 `[x]`→`[ ]` 并剥掉 ✅ 戳(与 toggleTodo/点击行为一致)。 */
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

async function writeDisk(deps: DailyDeps, path: string, baseText: string, specs: { from: number; to?: number; insert?: string }[]): Promise<void> {
  await deps.io.writeFile(path, textAfterChanges(baseText, specs));
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
    const otherText = await deps.io.readFile(otherPath).catch(() => null);
    if (!viewAlive(view, path)) return; // 读盘窗口期里文件被切走:过期放弃
    if (otherText === null) {
      // 对侧文件没了(删除/改名):解链,不再镜像
      store.remove(link.id);
      scheduleLinksPersist();
      return;
    }
    const otherDoc = parseDoc(otherText);
    const doc = view.state.doc;
    const texts = renamedTo && renamedTo !== link.text ? [renamedTo, link.text] : [link.text];
    const rootNo = resolveRootLine(doc, texts, rootHint);
    const root = rootNo !== null ? parseListLine(doc.line(rootNo).text) : null;

    // 记录型链接:根被取消勾选 → 从日记清掉这条(两侧任一方向触发都成立)
    if (isTodo(root) && link.kind === "recorded" && root.box === " ") {
      if (side === "src") {
        // 源侧已取消:删日记条目 + 解链
        const region = parseDailyRegion(otherDoc);
        const entry = findEntryByText(otherDoc, region, link.text, link.dailyLine);
        if (entry) await writeDisk(deps, otherPath, otherText, [removeEntrySpec(otherDoc, entry)]);
      } else {
        // 日记侧取消:摘掉本地条目,并把源待办翻回未完成
        removeLocalEntry(view, doc, link, store);
        const srcRootNo = resolveRootLine(otherDoc, [link.text], link.srcLine);
        const specs = srcRootNo !== null ? uncheckSpecs(otherDoc, srcRootNo)?.changes : null;
        if (specs) await writeDisk(deps, otherPath, otherText, specs);
      }
      store.remove(link.id);
      scheduleLinksPersist();
      return;
    }

    if (!rootNo || !isTodo(root)) {
      // 根不再是待办(被删/转正文)。源侧消失 → 删日记条目;日记侧消失 →
      // 用户在整理今天的列表,只解链,不动项目里的待办。
      if (side === "src") {
        const region = parseDailyRegion(otherDoc);
        const entry = findEntryByText(otherDoc, region, link.text, link.dailyLine);
        if (entry) await writeDisk(deps, otherPath, otherText, [removeEntrySpec(otherDoc, entry)]);
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
        // 日记条目被用户删了 = 解链,不复活(要再同步就重新按快捷键)
        store.remove(link.id);
        scheduleLinksPersist();
        return;
      }
      const reindented = reindentBlock(block, root.indent.length, "");
      await writeDisk(deps, otherPath, otherText, [replaceEntrySpec(otherDoc, entry, reindented)]);
      store.update(link.id, { text: todoText(root), srcLine: rootNo, dailyLine: entry.start });
    } else {
      const srcRootNo = resolveRootLine(otherDoc, [link.text], link.srcLine);
      const srcRoot = srcRootNo !== null ? parseListLine(otherDoc.line(srcRootNo).text) : null;
      if (!srcRootNo || !isTodo(srcRoot)) {
        // 源待办没了:删日记条目 + 解链
        removeLocalEntry(view, doc, link, store);
        store.remove(link.id);
        scheduleLinksPersist();
        return;
      }
      const reindented = reindentBlock(block, 0, srcRoot.indent);
      await writeDisk(deps, otherPath, otherText, [
        {
          from: otherDoc.line(srcRootNo).from,
          to: otherDoc.line(blockEnd(otherDoc, srcRootNo)).to,
          insert: reindented.join("\n"),
        },
      ]);
      store.update(link.id, { text: todoText(root), srcLine: srcRootNo, dailyLine: rootNo });
    }
    scheduleLinksPersist();
  });
}

/** 从打开的日记编辑器里摘掉链接对应的条目(找不到就只解链)。 */
function removeLocalEntry(view: EditorView, doc: Text, link: DailyLink, store: LinkStore): void {
  const region = parseDailyRegion(doc);
  const entry = findEntryByText(doc, region, link.text, link.dailyLine);
  if (entry) view.dispatch({ changes: removeEntrySpec(doc, entry), userEvent: SYNC_USER_EVENT });
  store.remove(link.id);
  scheduleLinksPersist();
}

async function applyRecord(
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
    const dailyText = await deps.io.readFile(dailyPath).catch(() => null);
    if (!viewAlive(view, path)) return;
    const doc = view.state.doc;
    const rootNo = resolveRootLine(doc, [text], rootHint);
    const root = rootNo !== null ? parseListLine(doc.line(rootNo).text) : null;
    if (!rootNo || !isTodo(root) || root.box !== "x") return; // 防抖窗口里又取消了:不记录
    if (store.findByText(path, text, rootNo)) return; // 已有链接(竞态):镜像会带上
    const block = blockLines(doc, rootNo);
    const reindented = reindentBlock(block, root.indent.length, "");
    const base = dailyText ?? `# ${deps.today()}\n`;
    const bdoc = parseDoc(base);
    const region = parseDailyRegion(bdoc);
    const existing = findEntryByText(bdoc, region, text, 0);
    let newDaily = base;
    let dailyLine: number;
    if (existing) {
      // 日记里已有同文条目(手动贴过/早前记录):直接认领为镜像根,不重复追加
      dailyLine = existing.start;
    } else {
      const { change } = appendEntrySpec(bdoc, region, reindented);
      newDaily = textAfterChanges(base, [change]);
      const ndoc = parseDoc(newDaily);
      dailyLine =
        findEntryByText(ndoc, parseDailyRegion(ndoc), text, Number.MAX_SAFE_INTEGER)?.start ?? 1;
    }
    await deps.io.writeFile(dailyPath, newDaily);
    store.upsert({
      id: uuid(),
      kind: "recorded",
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

// ---------------------------------------------------------------- 发送命令

/**
 * 身份文本 `text` 在 `srcPath` 里指向 `dailyPath` 这一份日记的映射。映射按日
 * 归属:昨天建立的映射指向昨天的文件,不参与「今天是否已同步」的判断。
 */
function linkForDaily(store: LinkStore, srcPath: string, dailyPath: string, text: string): DailyLink | null {
  for (const l of store.all()) {
    if (l.srcPath === srcPath && l.dailyPath === dailyPath && l.text === text) return l;
  }
  return null;
}

/** 该行任一**祖先**待办在 `dailyPath` 上的映射(自身由调用方单独判定)。 */
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
 * 「待办发送到今日日记」:光标(多光标逐行)所在待办行复制为今日日记的
 * 一级条目,按下行为准——在子待办上按下,子待办就是日记里的一级条目,
 * 它自己的子树保持层级;建立持久化映射后由镜像保持两侧同步。
 *
 * 「已同步」的判定不看映射记录本身,而看今天这份日记里是否真有那条目:映射
 * 只是缓存的锚,日记文件被删/条目被手工删掉后它就过期了。过期映射就地解除
 * 并重新发送——「要再同步就重新按快捷键」这句承诺靠这里兑现。项目里的待办
 * 长期存在、日记按天新建,所以只认指向今天这份文件的映射,昨天的不算数,也
 * 不会因为今天发送而被解除(昨天的列表该什么样还是什么样)。
 *
 * 记录型链接在显式发送时升级为正式映射。
 */
export async function sendTodoToDaily(view: EditorView, deps: DailyDeps, store: LinkStore): Promise<void> {
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
    let dailyText: string | null = await deps.io.readFile(dailyPath).catch(() => null);
    let mutated = false;
    let linksDirty = false;
    let sent = 0;
    let already = 0;
    let notTodo = 0;
    /** 今天这份日记(含本轮已追加的部分)里是否已有这条条目。 */
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
        // 已映射;显式发送把「完成记录」升级为正式映射
        if (own.kind === "recorded") {
          own.kind = "copied";
          linksDirty = true;
        }
        already++;
        continue;
      }
      if (own) {
        // 映射过期(今日日记被删/条目被手工删掉):解链后按新条目重发
        store.remove(own.id);
        linksDirty = true;
      } else {
        const anc = ancestorLinkForDaily(doc, lineNo, srcPath, dailyPath, store);
        if (anc) {
          if (dailyHas(anc.text)) {
            already++; // 随父待办镜像,已在日记里
            continue;
          }
          store.remove(anc.id); // 父的条目也没了:父的映射同样过期
          linksDirty = true;
        }
      }
      const block = blockLines(doc, lineNo);
      const reindented = reindentBlock(block, l.indent.length, "");
      if (dailyText === null) dailyText = `# ${today}\n`;
      const bdoc = parseDoc(dailyText);
      const region = parseDailyRegion(bdoc);
      const existing = findEntryByText(bdoc, region, text, 0);
      let dailyLine: number;
      if (existing) {
        dailyLine = existing.start; // 已有同文条目:认领,不重复追加
      } else {
        const { change } = appendEntrySpec(bdoc, region, reindented);
        const newDaily = textAfterChanges(dailyText, [change]);
        const ndoc = parseDoc(newDaily);
        dailyLine =
          findEntryByText(ndoc, parseDailyRegion(ndoc), text, Number.MAX_SAFE_INTEGER)?.start ?? 1;
        dailyText = newDaily;
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
    if (mutated && dailyText !== null) await deps.io.writeFile(dailyPath, dailyText);
    if (linksDirty) scheduleLinksPersist();
    if (sent > 0) deps.toast(sent === 1 ? "已发送到今日日记" : `已发送 ${sent} 条到今日日记`);
    else if (already > 0) deps.toast("已在今日日记中,自动保持同步");
    else if (notTodo > 0) deps.toast("光标行不是待办");
  });
}

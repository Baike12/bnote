import { api } from "@/lib/tauri";
import { PROJECTS_DIR, projectNameOf, sanitizeProjectName } from "./model";

/**
 * 项目列表的唯一写入者。
 *
 * 列表只存「名字 + 绝对路径」;文档内容由编辑器持有,这里另存一份缓存,让
 * 切换聚焦时不必等一次 IPC(项目文件通常只有几 KB,但读盘往返会让卡片空白
 * 一帧)。缓存只在「本地写过」和「刚读过」时更新,不监听磁盘——外部改项目
 * 文件的刷新由 App 的 vault-changed 分支重新列目录承担。
 */

export interface ProjectEntry {
  name: string;
  path: string;
}

let entries: ProjectEntry[] = [];
let revision = 0;
const listeners = new Set<() => void>();

/** 文档缓存:路径 → 最近一次读/写的内容。 */
const docs = new Map<string, string>();

/**
 * 已被删除(进了废纸篓)的项目路径。
 *
 * 删除时编辑器可能还挂着一笔 800ms 防抖写、或卸载时冲刷一次:那些写入排在
 * 删除之后就会把文件重新落回来。写入侧按墓碑丢弃,是「删掉的项目不会复活」
 * 的唯一契约。文件真的又存在了(从废纸篓还原、外部新建同名项目)时由
 * loadProjects 清掉墓碑。
 */
const removed = new Set<string>();

/** 正在删的路径:那段时间文件还在盘上,watcher 的旧快照不能据此撤墓碑。 */
const deleting = new Set<string>();

function notify(): void {
  revision += 1;
  for (const fn of [...listeners]) fn();
}

export function subscribeProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** useSyncExternalStore 的快照。 */
export function projectsRevision(): number {
  return revision;
}

export function projectEntries(): ProjectEntry[] {
  return entries;
}

function sameEntries(a: ProjectEntry[], b: ProjectEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.path === b[i].path && e.name === b[i].name);
}

/** 重新列目录;目录不存在时按空列表处理(第一次建项目才建目录)。 */
let loadSeq = 0;

export async function loadProjects(vaultRoot: string): Promise<void> {
  const root = vaultRoot.replace(/\/+$/, "");
  const seq = ++loadSeq;
  let nodes: Awaited<ReturnType<typeof api.readDir>> = [];
  try {
    nodes = await api.readDir(PROJECTS_DIR);
  } catch {
    nodes = [];
  }
  // 列目录期间又发起了一次(删除后的刷新、watcher):旧快照别覆盖新列表与墓碑。
  if (seq !== loadSeq) return;
  const next = nodes
    .filter((n) => n.kind === "file" && /\.md$/i.test(n.name))
    .map((n) => ({ name: projectNameOf(n.name), path: `${root}/${n.relPath}` }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  // 缓存里已不存在的项目文档丢掉,别让被删的项目一直占内存。
  const alive = new Set(next.map((e) => e.path));
  for (const path of [...docs.keys()]) if (!alive.has(path)) docs.delete(path);
  // 文件又存在了(废纸篓还原 / 外部新建同名):墓碑作废,否则它的保存会被永久丢弃。
  // 删除正在进行的路径除外——那一刻文件确实还在盘上,是 watcher 的旧快照。
  for (const path of alive) if (!deleting.has(path)) removed.delete(path);
  if (sameEntries(entries, next)) return;
  entries = next;
  notify();
}

/** 缓存里的项目文档;没有缓存返回 undefined。 */
export function cachedProjectDoc(path: string): string | undefined {
  return docs.get(path);
}

/** 记下编辑器当前的文档(自动保存前也写,切换聚焦时无需再读盘)。 */
export function setCachedProjectDoc(path: string, text: string): void {
  if (removed.has(path)) return;
  docs.set(path, text);
}

/** 读项目文档(优先缓存);读失败当空文档(项目刚建/被外部删掉)。 */
export async function readProjectDoc(path: string): Promise<string> {
  if (removed.has(path)) return "";
  const hit = docs.get(path);
  if (hit !== undefined) return hit;
  let text = "";
  try {
    text = await api.readFile(path);
  } catch {
    text = "";
  }
  // 读盘期间项目被删掉了:别把删掉的内容又塞回缓存。
  if (!removed.has(path)) docs.set(path, text);
  return text;
}

/** 把项目文档写回磁盘(调用方已负责防抖)。同一路径串行写,避免两次自动
 *  保存的 IPC 交错成半截内容;已删除的项目丢弃迟到写入,不让文件复活。 */
const writeChains = new Map<string, Promise<void>>();

export function writeProjectDoc(path: string, text: string): Promise<void> {
  if (removed.has(path)) return Promise.resolve();
  docs.set(path, text);
  const prev = writeChains.get(path) ?? Promise.resolve();
  const next = prev.then(() => api.writeFile(path, text)).catch((e) => {
    console.warn("project save failed", e);
  });
  writeChains.set(path, next);
  return next;
}

/** 新建项目文件,返回创建出来的条目(名字可能因重名带 " 2")。 */
export async function createProject(
  vaultRoot: string,
  rawName: string,
): Promise<ProjectEntry | null> {
  const name = sanitizeProjectName(rawName);
  if (!name) return null;
  await api.ensureDir(PROJECTS_DIR);
  const created = await api.createFile(PROJECTS_DIR, `${name}.md`);
  removed.delete(created.path);
  // 给一个可以直接开始输入的待办行;空文档会让新建后的第一帧没有落点。
  await api.writeFile(created.path, "- [ ] ");
  docs.set(created.path, "- [ ] ");
  await loadProjects(vaultRoot);
  return { name: projectNameOf(created.path), path: created.path };
}

/**
 * 删除项目:整个文件送进废纸篓(与笔记树删除同一条出口,可恢复)。
 *
 * 顺序是契约:先立墓碑 → 等排队的写落完 → 再删盘。反过来就会有一笔迟到的
 * 自动保存把刚删掉的文件写回来。
 */
export async function deleteProject(vaultRoot: string, path: string): Promise<void> {
  removed.add(path);
  deleting.add(path);
  try {
    const pending = writeChains.get(path);
    if (pending) await pending;
    await api.trashPath(path);
  } catch (e) {
    // 删盘失败:项目还在,墓碑必须撤掉,否则它从此写不进任何东西。
    removed.delete(path);
    throw e;
  } finally {
    deleting.delete(path);
  }
  docs.delete(path);
  writeChains.delete(path);
  await loadProjects(vaultRoot);
  // 聚焦由视图按新列表重选;先清空,组件会落到剩下列表的第一个项目。
  setFocusedProject(null);
}

/** 只刷新列表、不动文档缓存(外部 watcher 用)。 */
export function refreshProjects(vaultRoot: string): Promise<void> {
  return loadProjects(vaultRoot);
}

// ------------------------------------------------------- 当前聚焦的项目

let focused: string | null = null;

/** 中栏落在哪个项目上(路径);命令层切换卡片时读它。 */
export function focusedProjectPath(): string | null {
  return focused;
}

export function setFocusedProject(path: string | null): void {
  if (focused === path) return;
  focused = path;
  notify();
}

/** 上/下一个项目(到边界就停,不循环——循环会让「再按一下」失去返回感)。 */
export function focusAdjacentProject(delta: 1 | -1): void {
  if (entries.length === 0) return;
  const cur = entries.findIndex((e) => e.path === focused);
  const base = cur === -1 ? (delta > 0 ? -1 : entries.length) : cur;
  const nextIdx = Math.max(0, Math.min(entries.length - 1, base + delta));
  setFocusedProject(entries[nextIdx]?.path ?? null);
}


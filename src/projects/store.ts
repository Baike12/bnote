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
export async function loadProjects(vaultRoot: string): Promise<void> {
  const root = vaultRoot.replace(/\/+$/, "");
  let nodes: Awaited<ReturnType<typeof api.readDir>> = [];
  try {
    nodes = await api.readDir(PROJECTS_DIR);
  } catch {
    nodes = [];
  }
  const next = nodes
    .filter((n) => n.kind === "file" && /\.md$/i.test(n.name))
    .map((n) => ({ name: projectNameOf(n.name), path: `${root}/${n.relPath}` }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  // 缓存里已不存在的项目文档丢掉,别让被删的项目一直占内存。
  const alive = new Set(next.map((e) => e.path));
  for (const path of [...docs.keys()]) if (!alive.has(path)) docs.delete(path);
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
  docs.set(path, text);
}

/** 读项目文档(优先缓存);读失败当空文档(项目刚建/被外部删掉)。 */
export async function readProjectDoc(path: string): Promise<string> {
  const hit = docs.get(path);
  if (hit !== undefined) return hit;
  let text = "";
  try {
    text = await api.readFile(path);
  } catch {
    text = "";
  }
  docs.set(path, text);
  return text;
}

/** 把项目文档写回磁盘(调用方已负责防抖)。同一路径串行写,避免两次自动
 *  保存的 IPC 交错成半截内容。 */
const writeChains = new Map<string, Promise<void>>();

export function writeProjectDoc(path: string, text: string): Promise<void> {
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
  // 给一个可以直接开始输入的待办行;空文档会让新建后的第一帧没有落点。
  await api.writeFile(created.path, "- [ ] ");
  docs.set(created.path, "- [ ] ");
  await loadProjects(vaultRoot);
  return { name: projectNameOf(created.path), path: created.path };
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


/**
 * 会话家族:一份材料下的会话记录是一棵树——主会话没有 parent,辅助会话
 * 的 `parent` 指向它的来源会话文件 id(链式分叉时父也是辅助会话)。
 *
 * 恢复时不能只看「最近更新的那一条」:那往往正是刚分叉出来的辅助会话,
 * 于是重启后面板只挂着一个子会话、也没有回去的路。这里按 parent 链把整
 * 个家族还原出来,根(主会话)永远是恢复的落点。
 */

/** 会话列表里的一条:只取恢复父子关系需要的字段。 */
export interface SessionNode {
  id: string;
  title: string;
  /** 来源会话的文件 id;主会话为 null。 */
  parent: string | null;
  /** 辅助会话的来源消息摘要(空白 = 老记录没存)。 */
  basedOn: string;
  /** 分叉时复制过来的前缀条数;0 = 主会话。 */
  forkAt: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 从一条会话向上找到家族根。
 *
 * 父记录已删(单独删过文件)、parent 指向不存在的 id、或手工改出了环时,
 * 就近停住——根一定存在,恢复不会因为一条坏记录整体失败。
 */
export function sessionRoot(anchorId: string, nodes: SessionNode[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([anchorId]);
  let cur = byId.get(anchorId);
  while (cur?.parent) {
    if (seen.has(cur.parent)) break;
    const parent = byId.get(cur.parent);
    if (!parent) break;
    seen.add(cur.parent);
    cur = parent;
  }
  return cur?.id ?? anchorId;
}

/**
 * 根 + 它的全部后代(含根),按创建时间升序——主会话在前,分叉按产生先后。
 *
 * 同一家族里允许「一个父挂多个子」(多次从不同消息分叉);不属于这棵树
 * 的其它会话(别的家族、孤立的老记录)不返回。
 */
export function sessionFamily(rootId: string, nodes: SessionNode[]): SessionNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(rootId)) return [];
  const children = new Map<string, SessionNode[]>();
  for (const node of nodes) {
    if (!node.parent) continue;
    const list = children.get(node.parent) ?? [];
    list.push(node);
    children.set(node.parent, list);
  }
  const out: SessionNode[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    seen.add(id);
    out.push(node);
    for (const child of children.get(id) ?? []) walk(child.id);
  };
  walk(rootId);
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

/**
 * 恢复入口:锚点会话 + 全部同家族会话。锚点本身已不在列表里(刚被删)
 * 时返回 null,调用方按「没有可恢复的会话」处理。
 */
export function resolveFamily(
  anchorId: string,
  nodes: SessionNode[],
): { rootId: string; members: SessionNode[] } | null {
  if (!nodes.some((n) => n.id === anchorId)) return null;
  const rootId = sessionRoot(anchorId, nodes);
  const members = sessionFamily(rootId, nodes);
  return members.length > 0 ? { rootId, members } : null;
}

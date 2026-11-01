/**
 * Session family: the session records of one material form a tree — the main
 * session has no parent, an auxiliary session's `parent` points at the file id
 * of the session it was forked from (in a chained fork the parent is itself an
 * auxiliary session).
 *
 * On restore it is not enough to take "the most recently updated one": that is
 * often exactly the auxiliary session that was just forked, so after a
 * restart the panel only holds one sub-session and has no way back. The whole
 * family is rebuilt along the parent chain, and the root (the main session) is
 * always the landing point of the restore.
 */

/** One entry of the session list: only the fields needed to rebuild the parent/child relation. */
export interface SessionNode {
  id: string;
  title: string;
  /** The file id of the source session; null for the main session. */
  parent: string | null;
  /** A summary of the source message of an auxiliary session (empty = an old record did not store it). */
  basedOn: string;
  /** The number of entries copied over when forking; 0 = the main session. */
  forkAt: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Walk up from a session to the root of its family.
 *
 * When the parent record is gone (the file was deleted on its own), when the
 * parent points at a nonexistent id, or when a hand edit created a cycle, it
 * stops at the closest existing node — the root always exists, so a bad
 * record never fails the whole restore.
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
 * The root plus all of its descendants (including the root), in ascending
 * creation order — the main session first, the forks in the order they were
 * made.
 *
 * Within one family "one parent with several children" is allowed (forking
 * from different messages several times); sessions outside this tree (other
 * families, orphaned old records) are not returned.
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
 * Restore entry point: the anchor session plus all sessions of the same
 * family. Returns null when the anchor itself is no longer in the list (it
 * was just deleted); the caller then treats it as "there is no session to
 * restore".
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

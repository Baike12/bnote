/**
 * Three-way merge of one day document (base / local / remote), entry-level.
 *
 * The identity of a top-level entry is its todo text (checkbox and done stamp
 * stripped), the same rule the cross-file link engine uses. Per entry: a side
 * that differs from base wins over an unmodified other side; both modified →
 * local wins (the user is looking at that screen). Deletion loses against a
 * remote modification, so a phone edit is never erased by a desktop delete.
 * Reorders follow the local sequence when local actually reordered, otherwise
 * the remote one. Everything below the todo region merges as one block: the
 * side that changed keeps its version.
 *
 * Pure string arithmetic — no editor, no IO — so sync.ts can run it against
 * editor documents and disk files alike, and the whole rule set is locked
 * down in merge.test.ts.
 */

const LIST_LINE_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;
const BOX_RE = /^\[([ xX])\][ \t]?/;
const BLANK_RE = /^\s*$/;
const HEADER_RE = /^#\s/;
/** Trailing " ✅ YYYY-MM-DD" completion stamp, with surrounding whitespace. */
const DONE_STAMP_RE = /(\s*✅\s*\d{4}-\d{2}-\d{2})\s*$/;

interface Block {
  identity: string;
  /** The whole entry (root + deeper list lines), verbatim. */
  lines: string[];
}

interface ParsedDoc {
  /** The `# …` line, or null. */
  header: string | null;
  blocks: Block[];
  /** Line index where the todo region ends (the prose part starts). */
  regionEnd: number;
}

/** Mirrors bnote's parseDailyRegion, on a plain line array. */
function parseDoc(doc: string): ParsedDoc {
  const lines = doc.split("\n");
  const headerEnd = lines.length >= 1 && HEADER_RE.test(lines[0]) ? 1 : 0;
  let i = headerEnd;
  while (i < lines.length && BLANK_RE.test(lines[i])) i++;
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let regionEnd = lines.length;
  for (; i < lines.length; i++) {
    const text = lines[i];
    if (BLANK_RE.test(text)) {
      if (i + 1 < lines.length && LIST_LINE_RE.test(lines[i + 1])) continue;
      regionEnd = i;
      break;
    }
    const p = LIST_LINE_RE.exec(text);
    if (!p) {
      regionEnd = i;
      break;
    }
    if (p[1].length === 0) {
      const box = BOX_RE.exec(p[4]);
      const content = box ? p[4].slice(box[0].length) : p[4];
      cur = { identity: identityOf(content), lines: [text] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(text);
    } else {
      // A deeper line before any top-level entry is not part of the region.
      regionEnd = i;
      break;
    }
  }
  return {
    header: headerEnd >= 1 ? lines[0] : null,
    blocks,
    regionEnd,
  };
}

function identityOf(rootText: string): string {
  return rootText.replace(DONE_STAMP_RE, "").trim();
}

function blocksByIdentity(blocks: Block[]): Map<string, Block> {
  const map = new Map<string, Block>();
  for (const b of blocks) {
    if (!map.has(b.identity)) map.set(b.identity, b);
  }
  return map;
}

function orderOf(blocks: Block[]): Map<string, number> {
  const order = new Map<string, number>();
  blocks.forEach((b, i) => {
    if (!order.has(b.identity)) order.set(b.identity, i);
  });
  return order;
}

function sameLines(a: string[] | undefined, b: string[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((l, i) => l === b[i]);
}

/**
 * Merge the three documents. Identities present only in one side are kept
 * (additions); present in base but gone from a side count as that side's
 * deletion, and a deletion loses to the other side's modification.
 */
export function mergeDocs(base: string, local: string, remote: string): string {
  const b = parseDoc(base);
  const l = parseDoc(local);
  const r = parseDoc(remote);

  const baseMap = blocksByIdentity(b.blocks);
  const localMap = blocksByIdentity(l.blocks);
  const remoteMap = blocksByIdentity(r.blocks);

  // The identities base knew about that both sides still hold: whichever
  // side actually reordered against base decides the sequence.
  const commonInBase = b.blocks
    .filter((x) => localMap.has(x.identity) && remoteMap.has(x.identity))
    .map((x) => x.identity);
  const commonInLocal = l.blocks.filter((x) => remoteMap.has(x.identity)).map((x) => x.identity);
  const localReordered = commonInLocal.join("\n") !== commonInBase.join("\n");
  const remoteOrder = orderOf(r.blocks);

  const merged = new Map<string, string[]>();
  const addedOrder: string[] = [];
  const keep = (identity: string, lines: string[] | null) => {
    if (lines === null) return; // deleted on the winning side
    if (!merged.has(identity)) addedOrder.push(identity);
    merged.set(identity, lines);
  };

  // 1. Every identity base knew about: three-way per entry.
  for (const block of b.blocks) {
    const id = block.identity;
    const inLocal = localMap.get(id);
    const inRemote = remoteMap.get(id);
    const localChanged = inLocal !== undefined && !sameLines(inLocal.lines, block.lines);
    const remoteChanged = inRemote !== undefined && !sameLines(inRemote.lines, block.lines);
    if (inLocal === undefined && inRemote === undefined) continue; // deleted on both sides
    if (inRemote === undefined) {
      // Deleted remotely: keep it only when local modified the content.
      keep(id, localChanged ? inLocal!.lines : null);
      continue;
    }
    if (inLocal === undefined) {
      // Deleted locally: a remote modification restores it.
      keep(id, remoteChanged ? inRemote.lines : null);
      continue;
    }
    keep(
      id,
      localChanged || !sameLines(inLocal.lines, block.lines) ? inLocal.lines : inRemote.lines,
    );
  }

  // 2. Local additions, in local order.
  for (const block of l.blocks) {
    if (baseMap.has(block.identity) || merged.has(block.identity)) continue;
    keep(block.identity, block.lines);
  }

  // 3. Remote additions, in remote order (identical text added on both sides
  //    collapses into one entry via the merged check above).
  for (const block of r.blocks) {
    if (baseMap.has(block.identity) || merged.has(block.identity)) continue;
    keep(block.identity, block.lines);
  }

  // Assemble: the common entries in the winning order (local's own sequence
  // when local reordered, otherwise the remote one), then the additions.
  const orderedCommon = localReordered
    ? commonInLocal
    : [...commonInBase].sort((a, z) => (remoteOrder.get(a) ?? 0) - (remoteOrder.get(z) ?? 0));
  const body: string[][] = [];
  for (const id of orderedCommon) {
    const lines = merged.get(id);
    if (lines) body.push(lines);
  }
  for (const id of addedOrder) {
    if (orderedCommon.includes(id)) continue;
    const lines = merged.get(id);
    if (lines) body.push(lines);
  }

  // 4. Header and below-region: the side that changed keeps its version.
  const header = l.header !== b.header ? l.header : r.header;
  const below = (() => {
    const baseBelow = belowOf(base, b.regionEnd);
    const localBelow = belowOf(local, l.regionEnd);
    return localBelow !== baseBelow ? localBelow : belowOf(remote, r.regionEnd);
  })();

  // The engine's written shape: header, one blank line, then the entries
  // ADJACENT (a single newline between blocks, appendEntrySpec semantics),
  // then one blank line before the prose.
  const parts: string[] = [];
  if (header !== null) parts.push(header);
  if (body.length > 0 && header !== null) parts.push("");
  parts.push(...body.flat());
  if (below !== "") {
    if (parts.length > 0) parts.push("");
    parts.push(...below.split("\n"));
  }
  return parts.join("\n").replace(/\s+$/, "") + "\n";
}

function belowOf(doc: string, regionEnd: number): string {
  return doc
    .split("\n")
    .slice(regionEnd)
    .join("\n")
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");
}

import { fuzzyMatchTerms, fuzzySort } from "@/lib/fuzzy";
import { joinPath } from "@/lib/path";

/**
 * Quick-switcher result ranking, Obsidian-style:
 *
 * 1. Notes whose own name matches the query (recency as tiebreak) — a note
 *    named like the query always outranks a folder's contents.
 * 2. Folders whose path matches the query contribute their (recursive)
 *    contents, each folder's files ordered by open recency — typing a folder
 *    name becomes a way to jump into it.
 * 3. Everything else that matches the full path (multi-term "folder name"
 *    queries that no single folder satisfied).
 *
 * Sections are deduplicated top-down and capped at `limit` overall.
 * `excludeAbs` (absolute path) drops one file from the empty-query jump list —
 * the current note: switching to it is meaningless, the list starts at the
 * previously opened file instead.
 */
export function buildSwitcherResults(
  flatFiles: string[],
  recentFiles: string[],
  vaultPath: string | null,
  query: string,
  excludeAbs: string | null = null,
  limit = 50,
): { item: string; positions: number[] }[] {
  const stripExt = (f: string) => f.replace(/\.(md|markdown|txt)$/i, "");
  // Recency rank: absolute stored paths → per-vault relative rank. Files
  // never opened rank after everything that was.
  const rank = new Map(recentFiles.map((p, i) => [p, i] as const));
  const rankOf = (rel: string) =>
    (vaultPath ? rank.get(joinPath(vaultPath, rel)) : undefined) ?? Number.POSITIVE_INFINITY;
  const q = query.trim();

  if (!q) {
    // Empty query = jump list: most recently opened first (Obsidian-style),
    // minus the note that is already open.
    return [...flatFiles]
      .filter((f) => !excludeAbs || !vaultPath || joinPath(vaultPath, f) !== excludeAbs)
      .sort((a, b) => rankOf(a) - rankOf(b))
      .map((item) => ({ item, positions: [] as number[] }));
  }

  const out: { item: string; positions: number[] }[] = [];
  const seen = new Set<string>();

  // 1) Basename matches.
  const nameHits = fuzzySort(
    flatFiles,
    (f) => stripExt(f).split("/").pop() ?? "",
    q,
    limit,
    (a, b) => rankOf(a) - rankOf(b),
  );
  for (const hit of nameHits) {
    seen.add(hit.item);
    out.push(hit);
  }

  // 2) Folder matches → contents by open recency. Ancestor folders absorb
  //    their descendants, so a matched "a" skips the also-matched "a/b".
  const folders = new Set<string>();
  for (const f of flatFiles) {
    const segs = f.split("/");
    for (let i = 1; i < segs.length; i++) folders.add(segs.slice(0, i).join("/"));
  }
  const folderHits: { folder: string; score: number }[] = [];
  for (const folder of folders) {
    const res = fuzzyMatchTerms(q, folder);
    if (res) folderHits.push({ folder, score: res.score });
  }
  folderHits.sort((a, b) => b.score - a.score || a.folder.localeCompare(b.folder));
  const coveredFolders: string[] = [];
  for (const { folder } of folderHits) {
    if (coveredFolders.some((c) => folder.startsWith(`${c}/`))) continue;
    coveredFolders.push(folder);
    const kids = flatFiles
      .filter((f) => f.startsWith(`${folder}/`) && !seen.has(f))
      .sort((a, b) => rankOf(a) - rankOf(b));
    for (const kid of kids) {
      seen.add(kid);
      out.push({ item: kid, positions: [] });
    }
  }

  // 3) Full-path matches not covered above.
  for (const hit of fuzzySort(flatFiles, stripExt, q, limit, (a, b) => rankOf(a) - rankOf(b))) {
    if (out.length >= limit) break;
    if (seen.has(hit.item)) continue;
    seen.add(hit.item);
    out.push(hit);
  }

  return out.slice(0, limit);
}

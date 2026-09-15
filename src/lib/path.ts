/** Path helpers for vault-relative operations (pure string, POSIX `/`). */

/** Directory part of an absolute vault file path, relative to the vault root.
 *  Returns "" when the file sits at the root. */
export function dirname(absolutePath: string, vaultRoot: string): string {
  const rel = absolutePath.startsWith(vaultRoot)
    ? absolutePath.slice(vaultRoot.length).replace(/^\//, "")
    : absolutePath;
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}

/** Parent of a vault-relative path; "" when it sits at the vault root. */
export function relDirname(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}

/** Ancestor directories of a vault-relative path, root-first: "a/b/c" → ["a", "a/b"]. */
export function ancestorDirs(rel: string): string[] {
  const parts = rel.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export function joinPath(base: string, rel: string): string {
  if (!base) return rel;
  return `${base.replace(/\/$/, "")}/${rel.replace(/^\//, "")}`;
}

export function fileName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Note extensions dropped when building a wikilink target. */
const NOTE_EXT_RE = /\.(md|markdown|txt)$/i;

/** Wikilink syntax characters. A target containing one cannot be written as
 *  `[[…]]`: `]]` would end the link early, `|` reads as alias, `#` as heading. */
const LINK_SYNTAX_RE = /[\[\]|#^]/;

/**
 * Shortest text linking to `rel` inside a vault: the bare note name, or the
 * vault-relative path when another note shares that name (a bare name
 * resolves to the first match, so a duplicate name must not be used).
 * Returns null when the name cannot be written as a wikilink at all.
 */
export function wikilinkText(rel: string, allRels: string[]): string | null {
  const stem = (p: string) => p.replace(NOTE_EXT_RE, "");
  const base = stem(fileName(rel));
  const lower = base.toLowerCase();
  const ambiguous = allRels.some((r) => r !== rel && stem(fileName(r)).toLowerCase() === lower);
  const text = ambiguous ? stem(rel) : base;
  return !text || LINK_SYNTAX_RE.test(text) ? null : text;
}

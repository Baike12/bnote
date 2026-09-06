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

export function joinPath(base: string, rel: string): string {
  if (!base) return rel;
  return `${base.replace(/\/$/, "")}/${rel.replace(/^\//, "")}`;
}

export function fileName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

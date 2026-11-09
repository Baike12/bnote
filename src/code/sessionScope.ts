/**
 * Where a coding session's transcript lives.
 *
 * A coding session belongs to the repository, not to the notebook: like
 * Claude Code's `~/.claude/projects/<project>/<session>.jsonl`, the record
 * goes into the agent home under `.bnote/projects/<sanitized project>/`.
 * The vault never sees it, so a repository can be worked on with any vault
 * open (or none).
 *
 * The identity is the project root, so switching projects switches the
 * session family while re-entering the same project restores it.
 */
export interface CodeSessionScope {
  /** `code:<project root>`. */
  identity: string;
  /** The repository root: relative tool paths and bash anchor here. */
  workdir: string;
  /** `<agent home>/projects/<sanitized root>` (created by the backend). */
  homeDir: string;
}

export function codeSessionIdentity(root: string | null): string {
  return `code|${root ?? "none"}`;
}

/** Absolute path of one session record; null while the home directory is unresolved. */
export function codeSessionPath(homeDir: string | null, id: string): string | null {
  if (!homeDir) return null;
  return `${homeDir.replace(/\/+$/, "")}/${id}.jsonl`;
}

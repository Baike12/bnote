/**
 * Templates: plain text files whose content is written into a new file.
 *
 * The template directory is a vault-relative path; every file under it (including subdirectories) can be picked as a
 * template from the "quick add" command and from the daily note. Templates are neither registered nor cached: each
 * creation reads the file once by path, so editing a template takes effect immediately.
 *
 * There are only two variables -- `{{date}}` (YYYY-MM-DD) and `{{title}}` (the new file name without extension; for a daily
 * note it is the date). Unknown `{{...}}` placeholders are kept verbatim: braces written for other purposes must not be swallowed.
 */

export interface TemplateVars {
  /** The day the file is created, YYYY-MM-DD. */
  date: string;
  /** The new file name without extension; for a daily note it is the date. */
  title: string;
}

const TEMPLATE_VAR_RE = /\{\{\s*(date|title)\s*\}\}/g;

/** Substitute the template variables with real values; every other byte is copied verbatim. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(TEMPLATE_VAR_RE, (_match, key: "date" | "title") => vars[key]);
}

/**
 * Canonical form of the template directory: unify `/`, trim whitespace and slashes, drop `.` segments. Returns "" (i.e.
 * "not configured") when it contains `..` (which would escape the vault) or is empty.
 */
export function normalizeTemplateDir(dir: string): string {
  const parts = dir
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return "";
  return parts.join("/");
}

/**
 * The template files under the template directory (vault-relative paths, sorted by path). `files` is the list of note files
 * in the vault (store.flatFiles); returns an empty array when the directory is unset or holds no files.
 */
export function templateFiles(files: string[], dir: string): string[] {
  const root = normalizeTemplateDir(dir);
  if (!root) return [];
  const prefix = `${root}/`;
  return files
    .filter((file) => file.startsWith(prefix))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The label a template shows in the picker: its path relative to the template directory; returned verbatim when outside that directory. */
export function templateLabel(file: string, dir: string): string {
  const root = normalizeTemplateDir(dir);
  const prefix = `${root}/`;
  return root && file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

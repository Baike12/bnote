import { api } from "@/lib/tauri";
import { PROJECTS_DIR, projectNameOf, sanitizeProjectName } from "./model";

/**
 * The single writer of the project list.
 *
 * The list only stores the "name + absolute path"; the document content is held by
 * the editor, and a cache of it is kept here so switching the focus does not have
 * to wait for an IPC round trip (a project file is usually only a few KB, but the
 * disk round trip leaves the card blank for a frame). The cache is only updated on
 * "written locally" and "just read", the disk is not watched - the refresh after a
 * project file changed outside is the job of the vault-changed branch of App.
 */

export interface ProjectEntry {
  name: string;
  path: string;
}

let entries: ProjectEntry[] = [];
let revision = 0;
const listeners = new Set<() => void>();

/** Document cache: path -> the content of the last read or write. */
const docs = new Map<string, string>();

/**
 * The paths of the projects that were deleted (moved to the trash).
 *
 * At the time of the deletion the editor may still hold an 800ms debounced write
 * or flush once on unmount: those writes come after the deletion and would put the
 * file back on disk. The write side drops them by the tombstone, and that is the
 * only contract behind "a deleted project does not come back". When the file
 * really exists again (restored from the trash, or a project with the same name
 * created outside) loadProjects clears the tombstone.
 */
const removed = new Set<string>();

/** The paths that are being deleted: the file is still on disk during that time, so the stale snapshot of the watcher must not clear the tombstone. */
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

/** The snapshot for useSyncExternalStore. */
export function projectsRevision(): number {
  return revision;
}

export function projectEntries(): ProjectEntry[] {
  return entries;
}

function sameEntries(a: ProjectEntry[], b: ProjectEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.path === b[i].path && e.name === b[i].name);
}

/** List the directory again; a directory that does not exist is treated as an empty list (the directory is only created when the first project is created). */
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
  // Another listing was started while this one was running (the refresh after a
  // deletion, the watcher): the stale snapshot must not overwrite the new list and
  // the tombstones.
  if (seq !== loadSeq) return;
  const next = nodes
    .filter((n) => n.kind === "file" && /\.md$/i.test(n.name))
    .map((n) => ({ name: projectNameOf(n.name), path: `${root}/${n.relPath}` }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  // Drop the cached documents of projects that no longer exist, so a deleted project
  // does not keep occupying memory.
  const alive = new Set(next.map((e) => e.path));
  for (const path of [...docs.keys()]) if (!alive.has(path)) docs.delete(path);
  // The file exists again (restored from the trash, or created outside with the
  // same name): the tombstone is void, otherwise its saves would be dropped for
  // good. The paths that are being deleted are excepted - at that moment the file
  // really is still on disk, this is the stale snapshot of the watcher.
  for (const path of alive) if (!deleting.has(path)) removed.delete(path);
  if (sameEntries(entries, next)) return;
  entries = next;
  notify();
}

/** The cached project document; undefined when there is no cache entry. */
export function cachedProjectDoc(path: string): string | undefined {
  return docs.get(path);
}

/** Record the current document of the editor (also written before the autosave, so switching the focus does not have to read from disk again). */
export function setCachedProjectDoc(path: string, text: string): void {
  if (removed.has(path)) return;
  docs.set(path, text);
}

/** Read the project document (the cache comes first); a failed read counts as an empty document (the project was just created or deleted outside). */
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
  // The project was deleted while reading: do not put the deleted content back
  // into the cache.
  if (!removed.has(path)) docs.set(path, text);
  return text;
}

/** Write the project document back to disk (the caller is responsible for the
 *  debounce). The writes of one path are serialized, so the IPC of two autosaves
 *  cannot interleave into half a content; a deleted project drops the late write
 *  and does not come back. */
const writeChains = new Map<string, Promise<void>>();

export function writeProjectDoc(path: string, text: string): Promise<void> {
  if (removed.has(path)) return Promise.resolve();
  docs.set(path, text);
  const prev = writeChains.get(path) ?? Promise.resolve();
  const next = prev
    .then(() => api.writeFile(path, text))
    .catch((e) => {
      console.warn("project save failed", e);
    });
  writeChains.set(path, next);
  return next;
}

/** Create a project file and return the entry that was created (the name may get a " 2" suffix when it collides). */
export async function createProject(
  vaultRoot: string,
  rawName: string,
): Promise<ProjectEntry | null> {
  const name = sanitizeProjectName(rawName);
  if (!name) return null;
  await api.ensureDir(PROJECTS_DIR);
  const created = await api.createFile(PROJECTS_DIR, `${name}.md`);
  removed.delete(created.path);
  // Give it a todo line the user can type into right away; an empty document
  // would leave the first frame after the creation without a place to put the
  // caret.
  await api.writeFile(created.path, "- [ ] ");
  docs.set(created.path, "- [ ] ");
  await loadProjects(vaultRoot);
  return { name: projectNameOf(created.path), path: created.path };
}

/**
 * Delete a project: the whole file goes into the trash (the same exit as a
 * deletion in the note tree, it can be restored).
 *
 * The order is the contract: raise the tombstone -> wait for the queued writes to
 * land -> then delete from the disk. The other way round a late autosave would
 * write the just deleted file back.
 */
export async function deleteProject(vaultRoot: string, path: string): Promise<void> {
  removed.add(path);
  deleting.add(path);
  try {
    const pending = writeChains.get(path);
    if (pending) await pending;
    await api.trashPath(path);
  } catch (e) {
    // Deleting from the disk failed: the project is still there, the tombstone
    // has to be withdrawn, otherwise nothing can ever be written to it again.
    removed.delete(path);
    throw e;
  } finally {
    deleting.delete(path);
  }
  docs.delete(path);
  writeChains.delete(path);
  await loadProjects(vaultRoot);
  // The view picks the focus again from the new list; clear it first, the
  // component falls back to the first project of the remaining list.
  setFocusedProject(null);
}

/** Only refresh the list, leave the document cache alone (used by the external watcher). */
export function refreshProjects(vaultRoot: string): Promise<void> {
  return loadProjects(vaultRoot);
}

// ------------------------------------------------------- the focused project

let focused: string | null = null;

/** The project the middle column is on (its path); the command layer reads it when it switches cards. */
export function focusedProjectPath(): string | null {
  return focused;
}

export function setFocusedProject(path: string | null): void {
  if (focused === path) return;
  focused = path;
  notify();
}

/** The previous or next project (it stops at the boundary, it does not wrap around - wrapping would take away the feeling of coming back when you press it again). */
export function focusAdjacentProject(delta: 1 | -1): void {
  if (entries.length === 0) return;
  const cur = entries.findIndex((e) => e.path === focused);
  const base = cur === -1 ? (delta > 0 ? -1 : entries.length) : cur;
  const nextIdx = Math.max(0, Math.min(entries.length - 1, base + delta));
  setFocusedProject(entries[nextIdx]?.path ?? null);
}

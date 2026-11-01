import { agentApi, type MaterialInfo, type StudyContent } from "@/lib/tauri";
import { vaultDotPath } from "./vaultJson";

/**
 * Where study materials are stored on disk (`<vault>/.bnote/materials/<kind>/<dir>/`).
 *
 * The backend generates the directory name with `pinyin_pro` and registers it
 * in `.bnote/materials/index.json`, so the same material always lands in the
 * same directory — a title filled in later or a rename never forks the
 * annotations / session into two places. The front end only caches the
 * "material identity -> directory" resolution and never builds the name itself.
 *
 * Identity: PDFs use the absolute path (the backend converts it to a
 * vault-relative path), web pages / WeRead use the URL.
 */
const inflight = new Map<string, Promise<MaterialInfo | null>>();

/** Material identity (same rules as the backend's `identity()`): a trailing slash is ignored in URLs. */
export function studyIdentity(content: StudyContent): string {
  if (content.kind === "pdf") return `pdf:${content.path}`;
  if (content.kind === "code") return `code:${content.path.replace(/\/+$/, "")}`;
  return `url:${content.url.replace(/\/+$/, "")}`;
}

export function materialCacheKey(vaultRoot: string, content: StudyContent): string {
  return `${vaultRoot}\u0000${studyIdentity(content)}`;
}

/**
 * Resolve / create the material directory. Returns null on failure (browser
 * harness, no vault, an older backend); the caller then falls back to the old
 * "do not persist" behaviour.
 */
export function ensureMaterial(
  vaultRoot: string,
  content: StudyContent,
): Promise<MaterialInfo | null> {
  const key = materialCacheKey(vaultRoot, content);
  const hit = inflight.get(key);
  if (hit) return hit;
  const pending = agentApi.materialEnsure(content).catch(() => null);
  inflight.set(key, pending);
  // A failure is not cached permanently: the next open still gets a chance to create the directory.
  void pending.then((info) => {
    if (!info && inflight.get(key) === pending) inflight.delete(key);
  });
  return pending;
}

/** Absolute path of the material directory (`<vault>/.bnote/<relDir>`). */
export function materialAbsDir(vaultRoot: string, relDir: string): string {
  return vaultDotPath(vaultRoot, relDir);
}

/** Absolute path of one session transcript. */
export function sessionFilePath(vaultRoot: string, relDir: string, id: string): string {
  return `${materialAbsDir(vaultRoot, relDir)}/sessions/${id}.jsonl`;
}

/** For tests: clear the cache. */
export function resetMaterialCache(): void {
  inflight.clear();
}

import { api } from "@/lib/tauri";
import { linksFilePath } from "./model";

/**
 * Persistent storage for cross-file todo links. A link binds one source todo
 * block (in a project note) to one daily note entry; the two sides recognize each
 * other through the todo identity text (the line content with the checkbox and
 * the done stamp stripped), the line numbers are only a proximity hint.
 *
 * Persisted inside the vault at `<vault>/.bnote/daily-links.json` - it travels with
 * the repo and survives a restart. Writes are debounced by 300ms and flushed by
 * App.tsx on quit/hide (the same convention as the config persistence). Concurrent
 * writes from several instances of the same vault are last-write-wins, matching the
 * concurrency semantics of the editor itself.
 */

export interface DailyLink {
  id: string;
  /** copied = sent explicitly via the shortcut; recorded = recorded automatically when a todo is checked; auto = aggregated automatically as soon as it exists */
  kind: "copied" | "recorded" | "auto";
  /** Day the link belongs to (YYYY-MM-DD), the creation timestamp of the record */
  day: string;
  /** Absolute path of the source file (the project note) */
  srcPath: string;
  /** Absolute path of the daily note file */
  dailyPath: string;
  /** Todo identity text shared by both sides (mirroring keeps the text identical) */
  text: string;
  /** Source root line number at the last sync (a proximity hint) */
  srcLine: number;
  /** Start line of the daily note entry at the last sync (a proximity hint) */
  dailyLine: number;
}

interface StoredLinks {
  version: 1;
  links: DailyLink[];
}

// ------------------------------------------------------- change notification (store -> view)

const listeners = new Set<() => void>();

/** Subscribe to store changes (editor decorations recompute on them); returns the unsubscribe function. */
export function onLinksChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The single exit for changes: every writer (add, update, remove, vault swap)
 *  goes through here, so no subscriber misses an event. */
function markLinksChanged(): void {
  for (const fn of [...listeners]) fn();
}

export class LinkStore {
  private links = new Map<string, DailyLink>();

  static fromJSON(raw: string | null): LinkStore {
    const store = new LinkStore();
    if (!raw) return store;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredLinks>;
      if (parsed.version !== 1 || !Array.isArray(parsed.links)) return store;
      for (const l of parsed.links) {
        if (typeof l?.id !== "string" || typeof l?.srcPath !== "string") continue;
        store.links.set(l.id, l as DailyLink);
      }
    } catch {
      // Corrupted metadata is treated as an empty store: the sync feature rebuilds
      // from scratch, the notes themselves are unaffected
    }
    return store;
  }

  toJSON(): string {
    const data: StoredLinks = {
      version: 1,
      links: [...this.links.values()].map((l) => ({ ...l })),
    };
    return JSON.stringify(data, null, 2);
  }

  all(): DailyLink[] {
    return [...this.links.values()];
  }

  getById(id: string): DailyLink | null {
    return this.links.get(id) ?? null;
  }

  /** All links a file takes part in (either as the source or as the daily note). */
  forFile(path: string): DailyLink[] {
    return this.all().filter((l) => l.srcPath === path || l.dailyPath === path);
  }

  /**
   * Find a link by identity text: only links where `path` takes part (source or
   * daily side). With several links of the same text take the one whose line
   * hint is closest to `nearLine`. Returns null when nothing matches.
   */
  findByText(path: string, text: string, nearLine: number): DailyLink | null {
    let best: DailyLink | null = null;
    let bestDist = Infinity;
    for (const l of this.links.values()) {
      if (l.text !== text) continue;
      if (l.srcPath !== path && l.dailyPath !== path) continue;
      const dist = Math.min(
        l.srcPath === path ? Math.abs(l.srcLine - nearLine) : Infinity,
        l.dailyPath === path ? Math.abs(l.dailyLine - nearLine) : Infinity,
      );
      if (dist < bestDist) {
        bestDist = dist;
        best = l;
      }
    }
    return best;
  }

  upsert(link: DailyLink): void {
    this.links.set(link.id, link);
    markLinksChanged();
  }

  update(id: string, patch: Partial<Omit<DailyLink, "id">>): void {
    const cur = this.links.get(id);
    if (cur) {
      this.links.set(id, { ...cur, ...patch });
      markLinksChanged();
    }
  }

  remove(id: string): void {
    if (this.links.delete(id)) markLinksChanged();
  }
}

// -------------------------------------------------------- runtime singleton + persistence

let cache: { vault: string; store: LinkStore } | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Read the link store (or re-read it after a vault swap); a failure yields an empty store. */
export async function ensureLinks(vaultRoot: string): Promise<LinkStore> {
  if (cache && cache.vault === vaultRoot) return cache.store;
  let raw: string | null = null;
  try {
    raw = await api.readFile(linksFilePath(vaultRoot));
  } catch {
    raw = null; // missing file = no mapping exists yet
  }
  const store = LinkStore.fromJSON(raw);
  cache = { vault: vaultRoot, store };
  markLinksChanged(); // the store holds new content (after a vault swap): rendered marks recompute from it
  return store;
}

/** Synchronously return the loaded link store; null when it is not loaded yet or the vault changed (the caller skips this sync round). */
export function peekLinks(vaultRoot: string): LinkStore | null {
  return cache && cache.vault === vaultRoot ? cache.store : null;
}

export function hasPendingLinksPersist(): boolean {
  return persistTimer !== null;
}

/** Write the pending link metadata right away (flushed before quit/hide). */
export function flushLinksPersist(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  writeNow();
}

function writeNow(): void {
  if (!cache) return;
  void api
    .writeFile(linksFilePath(cache.vault), cache.store.toJSON())
    .catch((e) => console.warn("daily links persist failed", e));
}

/** Schedule a write after the link store changed (300ms debounce). */
export function scheduleLinksPersist(): void {
  if (!cache) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeNow();
  }, 300);
}

import { api } from "@/lib/tauri";
import { joinPath } from "@/lib/path";
import { todayStamp } from "@/lib/todoStamp";
import { useAppStore } from "@/state/appStore";
import {
  diffBlocks,
  footprintsFilePath,
  isAggregatePath,
  type FootprintBlock,
  type StoredFootprints,
} from "./model";

/**
 * Runtime storage of today's footprint: the baseline on disk
 * (<vault>/.bnote/daily-footprints.json), the rotation across days, the in-memory
 * incremental index and the change broadcast. It follows the same conventions as
 * daily/links.ts - a module level singleton, a 300ms write debounce and a
 * revision plus listeners broadcast to the editor decorations.
 *
 * The single source of truth for "what was written on a given day":
 *  - The baseline = a snapshot of the whole vault at the moment the day switched
 *    (one rotation, at most one full vault read per day);
 *  - Today's footprint = the content on disk diffed against the baseline (only for
 *    the dirty paths the watcher reported, 1s debounce);
 *  - Historical footprint = during the rotation the diff of the old baseline day
 *    is frozen into an archive (history[day][path]) and only read afterwards,
 *    never recomputed - opening a historical daily note aggregates the footprint
 *    of that day from it;
 *  - Opening today's daily note rebuilds everything once as a fallback (it covers
 *    the files changed while the app was not running - the watcher only reports
 *    changes of the running session, so after a restart there is no dirty path to
 *    feed it).
 *
 * Race discipline: every async callback (after a writeFile or readFile) first
 * proves "I am still the current vault and still the same day", and drops itself
 * when it is stale instead of blindly writing the index.
 */

// ------------------------------------------------------- change notification (store -> view)

let revision = 0;
const listeners = new Set<() => void>();

/** Version counter of the index, incremented on every content change. */
export function footprintRevision(): number {
  return revision;
}

/** Subscribe to index changes (the editor decorations recompute on them); returns the unsubscribe function. */
export function onFootprintsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function markFootprintsChanged(): void {
  revision++;
  for (const fn of [...listeners]) fn();
}

// ---------------------------------------------------------------- dependency injection

/** The outside world: file IO. A failed read (file does not exist and the like) folds into null. */
export interface FootprintIO {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  listFiles(): Promise<{ files: string[] }>;
}

export interface FootprintDeps {
  io: FootprintIO;
  today: () => string;
}

export const tauriFootprintIO: FootprintIO = {
  async readFile(path) {
    try {
      return await api.readFile(path);
    } catch {
      return null;
    }
  },
  writeFile(path, text) {
    return api.writeFile(path, text);
  },
  async listFiles() {
    const idx = await api.listFiles();
    return { files: idx.files };
  },
};

/** Dirty paths reported by the watcher, diffed once 1s has passed - the footprint does not need 300ms level realtime. */
const DIRTY_DELAY = 1000;
const PERSIST_DELAY = 300;
/** Throttle of the full fallback triggered by opening a daily note: switching between files quickly does not read the whole vault again. */
const FULL_REFRESH_THROTTLE = 5000;

function sameBlocks(a: FootprintBlock[], b: FootprintBlock[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.text === b[i].text && x.start === b[i].start && x.end === b[i].end)
  );
}

function sameIndex(
  a: Map<string, FootprintBlock[]>,
  b: Map<string, FootprintBlock[]>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !sameBlocks(v, w)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- core

export class FootprintCore {
  /** Day the baseline belongs to (YYYY-MM-DD); an empty string = not rotated yet (first use, corrupted metadata). */
  private day = "";
  private baselines = new Map<string, string>();
  /** Historical footprint archive: day -> path -> the footprint blocks of that day. Frozen during the rotation, read only afterwards. */
  private history = new Map<string, Map<string, FootprintBlock[]>>();
  private index = new Map<string, FootprintBlock[]>();
  private dirty = new Set<string>();
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private rotating: Promise<void> | null = null;
  private lastFullRefresh = 0;

  constructor(
    private deps: FootprintDeps,
    readonly vault: string,
  ) {}

  /** Load the baseline metadata and rotate when needed; missing or corrupted metadata
   *  is treated as "never rotated" (the first launch of the day takes a snapshot of
   *  the whole vault - an empty baseline would otherwise count the entire old vault
   *  as written today). A v1 file (without the archive) still loads its baseline and
   *  the archive stays empty - the days before the upgrade have no archive and none
   *  is invented. */
  async init(): Promise<void> {
    const raw = await this.deps.io.readFile(footprintsFilePath(this.vault));
    if (raw) {
      try {
        // v1 and v2 live side by side on disk (v1 has no history field), the shape
        // guard validates every field
        const parsed = JSON.parse(raw) as {
          version?: number;
          day?: string;
          baselines?: Record<string, string>;
          history?: Record<string, Record<string, FootprintBlock[]>>;
        };
        if (
          (parsed.version === 1 || parsed.version === 2) &&
          typeof parsed.day === "string" &&
          parsed.baselines
        ) {
          this.day = parsed.day;
          this.baselines = new Map(Object.entries(parsed.baselines));
          this.history = new Map(
            Object.entries(parsed.history ?? {}).map(([d, files]) => [
              d,
              new Map(Object.entries(files)),
            ]),
          );
        }
      } catch {
        // Corrupted metadata is treated as never rotated: the baseline is rebuilt
        // right away today, the notes themselves are unaffected
      }
    }
    await this.rotateIfNeeded();
  }

  /** The instance is still the module singleton (cache === null only happens for an
   *  instance built directly in a test); after a vault swap the in-flight callbacks
   *  of the old instance give up here instead of blindly writing an index nobody
   *  observes. */
  private stillCurrent(): boolean {
    return cache === null || cache === this;
  }

  // ---- rotation

  private rotateIfNeeded(): Promise<void> {
    if (this.day === this.deps.today()) return Promise.resolve();
    if (!this.rotating) {
      this.rotating = this.doRotate().finally(() => {
        this.rotating = null;
      });
    }
    return this.rotating;
  }

  /** The day switched: the snapshot of the whole vault becomes the new baseline and
   *  the footprint diff of the old baseline day is frozen into the historical
   *  archive, which the historical daily notes aggregate from. Content written in
   *  the minutes before midnight lands in the archive of the old baseline day (it
   *  is shown once too late) - a minute level effect, accepted for now; an mtime
   *  refinement can come later. When the app was not open for several days there is
   *  no snapshot to diff for the days in between, so their archive is missing - that
   *  day simply has no footprint section (nothing is invented). */
  private async doRotate(): Promise<void> {
    const today = this.deps.today();
    const { files } = await this.deps.io.listFiles();
    if (!this.stillCurrent() || this.deps.today() !== today) return;
    const snapshot: Record<string, string> = {};
    await Promise.all(
      files.map(async (rel) => {
        const abs = joinPath(this.vault, rel);
        if (!isAggregatePath(abs, this.vault)) return;
        const text = await this.deps.io.readFile(abs);
        // The callback proves itself: it is dropped when the vault changed or the
        // day switched again (theoretically impossible, the guards agree)
        if (!this.stillCurrent() || this.deps.today() !== today) return;
        if (text !== null) snapshot[abs] = text;
      }),
    );
    if (!this.stillCurrent() || this.deps.today() !== today) return;
    // The footprint of the old baseline day = the old baseline diffed against the
    // current state of the disk; it reuses the same batch of texts that were read
    // for the new baseline, so there is no extra IO. On first use (no old baseline)
    // there is no "that day", so no archive is produced.
    const previousDay = this.day;
    if (previousDay !== "") {
      const archived = new Map<string, FootprintBlock[]>();
      for (const [abs, text] of Object.entries(snapshot)) {
        const blocks = diffBlocks(this.baselines.get(abs) ?? null, text);
        if (blocks.length > 0) archived.set(abs, blocks);
      }
      this.history.set(previousDay, archived);
    }
    this.day = today;
    this.baselines = new Map(Object.entries(snapshot));
    this.index.clear();
    markFootprintsChanged();
    this.schedulePersist();
  }

  // ---- index update

  /** Entry point fed by the watcher: filter out the aggregateable paths and diff them after the debounce. A non aggregateable path costs nothing. */
  noteDirty(paths: string[]): void {
    for (const p of paths) {
      if (isAggregatePath(p, this.vault)) this.dirty.add(p);
    }
    if (this.dirty.size === 0 || this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      void this.flushDirty();
    }, DIRTY_DELAY);
  }

  private async flushDirty(): Promise<void> {
    await this.rotateIfNeeded();
    if (!this.stillCurrent()) return;
    const targets = [...this.dirty];
    this.dirty.clear();
    await this.refreshPaths(targets);
  }

  /** Read from disk and diff only the dirty paths; a deleted file (unreadable) is removed from the index. */
  private async refreshPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const results = await Promise.all(
      paths.map(async (p) => [p, await this.deps.io.readFile(p)] as const),
    );
    if (!this.stillCurrent()) return;
    let changed = false;
    for (const [p, text] of results) {
      if (text === null) {
        changed = this.index.delete(p) || changed;
        continue;
      }
      const blocks = diffBlocks(this.baselines.get(p) ?? null, text);
      if (!sameBlocks(this.index.get(p) ?? [], blocks)) {
        this.index.set(p, blocks);
        changed = true;
      }
    }
    if (changed) markFootprintsChanged();
  }

  /** Full fallback rebuild (called when today's daily note is opened): read the
   *  whole vault and recompute the index, covering the files that changed while the
   *  app was not running and that the watcher never reported. Throttled. */
  async refreshAll(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastFullRefresh < FULL_REFRESH_THROTTLE) return;
    this.lastFullRefresh = now;
    await this.rotateIfNeeded();
    if (!this.stillCurrent()) return;
    const { files } = await this.deps.io.listFiles();
    if (!this.stillCurrent()) return;
    const paths = files
      .map((rel) => joinPath(this.vault, rel))
      .filter((p) => isAggregatePath(p, this.vault));
    const results = await Promise.all(
      paths.map(async (p) => [p, await this.deps.io.readFile(p)] as const),
    );
    if (!this.stillCurrent()) return;
    const next = new Map<string, FootprintBlock[]>();
    for (const [p, text] of results) {
      if (text === null) continue;
      next.set(p, diffBlocks(this.baselines.get(p) ?? null, text));
    }
    if (!sameIndex(this.index, next)) {
      this.index = next;
      markFootprintsChanged();
    }
  }

  // ---- queries

  /** Today's footprint blocks of a file; an empty array when there is no record. */
  footprintsFor(path: string): FootprintBlock[] {
    return this.index.get(path) ?? [];
  }

  /** All files with a footprint today (sorted by path, so the widget renders in a stable order). */
  todayEntries(): { path: string; blocks: FootprintBlock[] }[] {
    return this.entriesOf(this.index);
  }

  /** The footprint entries of a day: today -> the live index, a historical day ->
   *  the frozen archive (read only). A day without a record returns an empty array.
   *  While the core is not rotated yet (day is an empty string: the window of the
   *  injection path and of init) the live index is the only available data
   *  surface, so every day goes through it. */
  entriesFor(day: string): { path: string; blocks: FootprintBlock[] }[] {
    if (day === this.day || this.day === "") return this.todayEntries();
    return this.entriesOf(this.history.get(day) ?? new Map());
  }

  private entriesOf(map: Map<string, FootprintBlock[]>): { path: string; blocks: FootprintBlock[] }[] {
    return [...map.entries()]
      .filter(([, blocks]) => blocks.length > 0)
      .map(([path, blocks]) => ({ path, blocks }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** First access after the day switched: finish the rotation (freeze the archive
   *  of the old day and move the baseline to the new day). Idempotent, called when
   *  any daily note is opened - a historical daily note therefore sees the freshly
   *  frozen archive right away. */
  async ensureDay(): Promise<void> {
    await this.rotateIfNeeded();
  }

  /** Test/development hook: inject the archive of a historical day (used by the harness __setFootprints). */
  installHistoryForTest(day: string, entries: Map<string, FootprintBlock[]>): void {
    this.history.set(day, entries);
    markFootprintsChanged();
  }

  get baselineDay(): string {
    return this.day;
  }

  // ---- persistence (only the rotation changes the baseline)

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeNow();
    }, PERSIST_DELAY);
  }

  private writeNow(): void {
    const stored: StoredFootprints = {
      version: 2,
      day: this.day,
      baselines: Object.fromEntries(this.baselines),
      history: Object.fromEntries(
        [...this.history].map(([d, files]) => [d, Object.fromEntries(files)]),
      ),
    };
    void this.deps.io
      .writeFile(footprintsFilePath(this.vault), JSON.stringify(stored))
      .catch((e) => console.warn("footprint persist failed", e));
  }

  hasPendingPersist(): boolean {
    return this.persistTimer !== null;
  }

  flushPersist(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.writeNow();
  }

  /** Test/development hook: replace the in-memory index directly and broadcast (used by the harness __setFootprints). */
  installIndexForTest(index: Map<string, FootprintBlock[]>): void {
    this.index = index;
    markFootprintsChanged();
  }
}

// ---------------------------------------------------------------- module level singleton

let cache: FootprintCore | null = null;

/** Read (or rebuild after a vault swap) the footprint store; the rotation finishes in the background and does not block opening the vault. */
export async function ensureFootprints(vaultRoot: string): Promise<void> {
  if (cache && cache.vault === vaultRoot) return;
  const core = new FootprintCore(
    { io: tauriFootprintIO, today: () => todayStamp() },
    vaultRoot,
  );
  cache = core;
  try {
    await core.init();
  } catch (e) {
    console.warn("footprint init failed", e);
  }
}

/** Entry point fed by the watcher; silent while the store is not loaded (the full fallback fills the gap once ensureFootprints is done). */
export function noteDirtyPaths(paths: string[]): void {
  cache?.noteDirty(paths);
}

/** The full fallback when today's daily note is opened; the store is created first when it is not loaded (it does not depend on the timing of ensureFootprints). */
export async function refreshFootprints(): Promise<void> {
  const vaultRoot = useAppStore.getState().vaultPath;
  if (!vaultRoot) return;
  if (!cache || cache.vault !== vaultRoot) await ensureFootprints(vaultRoot);
  await cache?.refreshAll();
}

export function footprintsFor(path: string): FootprintBlock[] {
  return cache?.footprintsFor(path) ?? [];
}

export function todayFootprintEntries(): { path: string; blocks: FootprintBlock[] }[] {
  return cache?.todayEntries() ?? [];
}

/** The footprint entries of a day (live for today, from the archive for history); empty while the store is not loaded. */
export function footprintEntriesFor(day: string): { path: string; blocks: FootprintBlock[] }[] {
  return cache?.entriesFor(day) ?? [];
}

/** Rotation duty when any daily note is opened: after the day switched, the first access finalizes the archive here. Idempotent. */
export async function ensureFootprintDay(): Promise<void> {
  await cache?.ensureDay();
}

/** The day the current baseline belongs to; null while the store is not loaded. For tests and debugging. */
export function footprintDay(): string | null {
  return cache?.baselineDay ?? null;
}

export function hasPendingFootprintsPersist(): boolean {
  return cache?.hasPendingPersist() ?? false;
}

/** Flush the baseline write before quitting or hiding. */
export function flushFootprintsPersist(): void {
  cache?.flushPersist();
}

/** Harness debugging hook: inject a fake index (harness __setFootprints). */
export function setFootprintIndexForTest(vaultRoot: string, index: Map<string, FootprintBlock[]>): void {
  if (cache && cache.vault === vaultRoot) {
    cache.installIndexForTest(index);
  } else {
    const core = new FootprintCore({ io: tauriFootprintIO, today: () => todayStamp() }, vaultRoot);
    cache = core;
    core.installIndexForTest(index);
  }
}

/** Harness debugging hook: inject the archive of a historical day (harness __setFootprints with a day). */
export function setFootprintHistoryForTest(
  vaultRoot: string,
  day: string,
  entries: Map<string, FootprintBlock[]>,
): void {
  if (!cache || cache.vault !== vaultRoot) setFootprintIndexForTest(vaultRoot, new Map());
  cache?.installHistoryForTest(day, entries);
}

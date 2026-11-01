import { api } from "@/lib/tauri";

/**
 * Reading and writing the JSON files under `<vault>/.bnote/**`: one cache per
 * "file", one file per piece of data.
 *
 * User data like annotations has to travel with the file it belongs to (one
 * file each), and cannot be accumulated into one global blob — with many
 * annotated PDFs, opening any one of them would read and write the whole
 * library, and the files would overwrite each other. So the cache and the
 * write scheduling are kept apart per `(vault, key)`, and each file has only
 * one writer at a time. When an async read returns it proves "I am still that
 * file" by its key; stale results are dropped.
 */
export interface JsonIO {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

export interface VaultJsonLoad<T> {
  data: T;
  /** Whether the file really exists on disk (an empty file counts as existing). Used for "no file at the new path, migrate the old one". */
  existed: boolean;
}

export interface VaultJsonFileStore<T> {
  /** Read into the cache and return that file's content; a missing or broken file returns empty. */
  load(vaultRoot: string, key: string): Promise<T>;
  /** Like `load`, but also tells the caller whether the file exists on disk. */
  loadFile(vaultRoot: string, key: string): Promise<VaultJsonLoad<T>>;
  /** The already-loaded cache; null when it has not been loaded yet. */
  peek(vaultRoot: string, key: string): T | null;
  /** Change the cache and schedule the write; when it is not loaded yet, read from disk first and then change it, the queue guarantees the order. */
  update(vaultRoot: string, key: string, mutate: (data: T) => T): void;
  /** Write out all pending changes right away (flush before leaving the page / quitting). */
  flush(): void;
}

interface Options<T> {
  /** key -> absolute path on disk (must live under <vault>/.bnote). */
  pathFor: (vaultRoot: string, key: string) => string;
  empty: () => T;
  parse: (raw: string | null) => T;
  serialize: (data: T) => string;
  /** Injected in tests; goes through IPC by default. */
  io?: JsonIO;
  debounceMs?: number;
}

const DEFAULT_IO: JsonIO = {
  read: (path) => api.readFile(path),
  write: (path, text) => api.writeFile(path, text),
};

export function vaultDotPath(vaultRoot: string, relPath: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/.bnote/${relPath.replace(/^\/+/, "")}`;
}

interface Entry<T> {
  vault: string;
  key: string;
  path: string;
  data: T;
  /** The file existed on disk to begin with (the read succeeded), not "unreadable, treated as empty". */
  existed: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createVaultJsonStore<T>(opts: Options<T>): VaultJsonFileStore<T> {
  const io = opts.io ?? DEFAULT_IO;
  const debounceMs = opts.debounceMs ?? 300;
  /** One cache per file. */
  const entries = new Map<string, Entry<T>>();
  /** At most one read in flight per file; several load calls share the same promise. */
  const loads = new Map<string, Promise<VaultJsonLoad<T>>>();
  /** The read->mutate serial queue of each file. */
  const queues = new Map<string, Promise<void>>();

  const idOf = (vault: string, key: string) => `${vault}\u0000${key}`;

  function warn(action: string, error: unknown): void {
    console.warn(`[annotations] ${action} failed`, error);
  }

  async function read(vault: string, key: string): Promise<VaultJsonLoad<T>> {
    const id = idOf(vault, key);
    let raw: string | null = null;
    try {
      raw = await io.read(opts.pathFor(vault, key));
    } catch {
      raw = null; // the file does not exist yet = empty data
    }
    // While the read was in flight the cache was already created locally (and may already have been edited): keep the local one, the stale disk state must not overwrite it.
    const existing = entries.get(id);
    if (existing) return { data: existing.data, existed: existing.existed };
    const entry: Entry<T> = {
      vault,
      key,
      path: opts.pathFor(vault, key),
      data: opts.parse(raw),
      existed: raw !== null,
      dirty: false,
      timer: null,
    };
    entries.set(id, entry);
    return { data: entry.data, existed: entry.existed };
  }

  function load(vault: string, key: string): Promise<T> {
    return loadFile(vault, key).then((loaded) => loaded.data);
  }

  function loadFile(vault: string, key: string): Promise<VaultJsonLoad<T>> {
    const id = idOf(vault, key);
    const entry = entries.get(id);
    if (entry) return Promise.resolve({ data: entry.data, existed: entry.existed });
    const pending = loads.get(id);
    if (pending) return pending;
    const promise = read(vault, key).finally(() => {
      if (loads.get(id) === promise) loads.delete(id);
    });
    loads.set(id, promise);
    return promise;
  }

  function write(entry: Entry<T>): void {
    entry.dirty = false;
    const id = idOf(entry.vault, entry.key);
    void io.write(entry.path, opts.serialize(entry.data)).catch((error: unknown) => {
      // Keep the dirty flag when the write fails: the next update/flush tries again.
      if (entries.get(id) === entry) entry.dirty = true;
      warn(`write ${entry.key}`, error);
    });
  }

  function apply(entry: Entry<T>, mutate: (data: T) => T): void {
    entry.data = mutate(entry.data);
    entry.dirty = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      write(entry);
    }, debounceMs);
  }

  function update(vault: string, key: string, mutate: (data: T) => T): void {
    const id = idOf(vault, key);
    const entry = entries.get(id);
    // The normal case: the cache is ready, mutate and schedule synchronously. Only flush makes this change visible.
    if (entry) {
      apply(entry, mutate);
      return;
    }
    const prev = queues.get(id) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        let current = entries.get(id);
        if (!current) {
          await load(vault, key);
          current = entries.get(id);
        }
        // When the read fails (in theory read always creates the cache) this change is not lost: mutate the empty data.
        if (!current) {
          current = {
            vault,
            key,
            path: opts.pathFor(vault, key),
            data: opts.empty(),
            existed: false,
            dirty: false,
            timer: null,
          };
          entries.set(id, current);
        }
        apply(current, mutate);
      })
      .catch((error: unknown) => warn(`update ${key}`, error));
    queues.set(id, next);
    void next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    });
  }

  function flush(): void {
    for (const [id, entry] of entries) {
      const queued = queues.get(id);
      if (queued) {
        // A queued read->mutate has not landed yet: write after it, do not drop the pending change.
        void queued.then(() => {
          if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          write(entry);
        });
        continue;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.dirty) write(entry);
    }
  }

  return {
    load,
    loadFile,
    peek: (vault, key) => entries.get(idOf(vault, key))?.data ?? null,
    update,
    flush,
  };
}

import { api } from "@/lib/tauri";

/**
 * `<vault>/.bnote/**` 下的 JSON 文件读写:按「文件」建缓存,一份数据一个文件。
 *
 * 批注这类用户数据必须跟着被批注的文件走(一对一文件),不能攒进一个全局
 * 大文件——批注的 PDF 一多,打开任何一份都要读/写整库,还会互相覆盖。
 * 这里因此按 `(vault, key)` 分开缓存、分开排程写盘;同一份文件同一时刻只有
 * 一个写入者。异步读盘回来时用 key 自证「我还是那个文件」,过期结果丢弃。
 */
export interface JsonIO {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

export interface VaultJsonLoad<T> {
  data: T;
  /** 盘上是否真的有这个文件(空文件也算有)。用于「新路径没有就迁旧路径」。 */
  existed: boolean;
}

export interface VaultJsonFileStore<T> {
  /** 读进缓存并返回该文件的内容;不存在/坏文件返回 empty。 */
  load(vaultRoot: string, key: string): Promise<T>;
  /** 同 `load`,另外告诉调用方盘上有没有这个文件。 */
  loadFile(vaultRoot: string, key: string): Promise<VaultJsonLoad<T>>;
  /** 已加载的缓存;尚未加载返回 null。 */
  peek(vaultRoot: string, key: string): T | null;
  /** 改缓存并排程写盘;尚未加载时先读盘再改,顺序由队列保证。 */
  update(vaultRoot: string, key: string, mutate: (data: T) => T): void;
  /** 立即写出全部挂起的改动(离开页面/退出前冲刷)。 */
  flush(): void;
}

interface Options<T> {
  /** key → 磁盘绝对路径(必须落在 <vault>/.bnote 下)。 */
  pathFor: (vaultRoot: string, key: string) => string;
  empty: () => T;
  parse: (raw: string | null) => T;
  serialize: (data: T) => string;
  /** 测试注入;默认走 IPC。 */
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
  /** 盘上原本有这个文件(读盘成功),不是「读不到当空数据」。 */
  existed: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createVaultJsonStore<T>(opts: Options<T>): VaultJsonFileStore<T> {
  const io = opts.io ?? DEFAULT_IO;
  const debounceMs = opts.debounceMs ?? 300;
  /** 每个文件一份缓存。 */
  const entries = new Map<string, Entry<T>>();
  /** 每个文件最多一轮读盘在途,多个 load 共享同一个 promise。 */
  const loads = new Map<string, Promise<VaultJsonLoad<T>>>();
  /** 每个文件的 read→mutate 串行队列。 */
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
      raw = null; // 文件还不存在 = 空数据
    }
    // 读盘期间本地已经建过这份缓存(可能已经编辑):保留本地这份,不能被旧盘面覆盖。
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
      // 写失败保留 dirty:下一次 update/flush 会再试。
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
    // 常态:缓存已就绪,同步改、同步排程。flush 才能看见这份改动。
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
        // 读盘失败(理论上 read 总会建缓存)时不丢这次改动:在空数据上改。
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
        // 排队中的 read→mutate 还没落地:排完再写,别把挂起的改动丢掉。
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

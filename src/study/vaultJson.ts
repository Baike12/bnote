import { api } from "@/lib/tauri";

/**
 * `<vault>/.bnote/<name>.json` 的读写器:缓存一份解析结果,写入 300ms 防抖。
 *
 * 学习模式的批注都属于「随仓库走」的用户数据(与 daily-links 同思路)。
 * 同一时刻只有一个写入者(缓存里的那一份),异步读盘回来时用 vault 路径自证
 * 「我还是当前仓库」,过期结果直接丢弃。
 */
export interface JsonIO {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

export interface VaultJsonStore<T> {
  /** 读进缓存并返回当前内容;不存在/坏文件返回 empty。 */
  load(vaultRoot: string): Promise<T>;
  /** 已加载的缓存;尚未加载或换了仓库返回 null。 */
  peek(vaultRoot: string): T | null;
  /** 改缓存并排程写盘;尚未加载时先读盘再改,顺序由队列保证。 */
  update(vaultRoot: string, mutate: (data: T) => T): void;
  /** 立即写出挂起的改动(离开页面/退出前冲刷)。 */
  flush(): void;
}

interface Options<T> {
  /** `.bnote/` 下的文件名。 */
  fileName: string;
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

export function vaultDotPath(vaultRoot: string, fileName: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/.bnote/${fileName}`;
}

export function createVaultJsonStore<T>(opts: Options<T>): VaultJsonStore<T> {
  const io = opts.io ?? DEFAULT_IO;
  const debounceMs = opts.debounceMs ?? 300;
  let cache: { vault: string; data: T } | null = null;
  let loading: { vault: string; promise: Promise<T> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 并发读盘时只让「最后一次请求」写缓存,避免换仓时旧结果盖掉新结果。 */
  let loadSeq = 0;
  /** 写盘队列:读盘先于改数据完成,后一次 update 覆盖前一次的快照。 */
  let queue: Promise<void> = Promise.resolve();

  function pathFor(vaultRoot: string): string {
    return vaultDotPath(vaultRoot, opts.fileName);
  }

  async function readFile(vaultRoot: string): Promise<T> {
    const seq = ++loadSeq;
    let raw: string | null = null;
    try {
      raw = await io.read(pathFor(vaultRoot));
    } catch {
      raw = null; // 文件还不存在 = 空库
    }
    const data = opts.parse(raw);
    if (seq === loadSeq) cache = { vault: vaultRoot, data };
    return data;
  }

  function load(vaultRoot: string): Promise<T> {
    if (cache && cache.vault === vaultRoot) return Promise.resolve(cache.data);
    if (loading && loading.vault === vaultRoot) return loading.promise;
    const promise = readFile(vaultRoot);
    loading = { vault: vaultRoot, promise };
    void promise.finally(() => {
      if (loading && loading.promise === promise) loading = null;
    });
    return promise;
  }

  function scheduleWrite(vaultRoot: string): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const now = cache;
      if (!now || now.vault !== vaultRoot) return;
      void io.write(pathFor(vaultRoot), opts.serialize(now.data)).catch((e: unknown) => {
        console.warn(`[annotations] ${opts.fileName} persist failed`, e);
      });
    }, debounceMs);
  }

  function update(vaultRoot: string, mutate: (data: T) => T): void {
    // 常态:缓存已就绪,同步改、同步排程。flush 才能看见这份改动。
    if (cache && cache.vault === vaultRoot) {
      const next = mutate(cache.data);
      cache = { vault: vaultRoot, data: next };
      scheduleWrite(vaultRoot);
      return;
    }
    queue = queue.then(async () => {
      const base =
        cache && cache.vault === vaultRoot ? cache.data : await load(vaultRoot);
      // 读盘期间换了仓库:这份结果不属于当前写入者,丢弃。
      if (cache && cache.vault !== vaultRoot) return;
      const next = mutate(base);
      cache = { vault: vaultRoot, data: next };
      scheduleWrite(vaultRoot);
    });
    // 队列里前一次失败不能卡死后续写入。
    queue = queue.catch(() => {});
  }

  function writeNow(): void {
    const now = cache;
    if (!now) return;
    void io.write(pathFor(now.vault), opts.serialize(now.data)).catch((e: unknown) => {
      console.warn(`[annotations] ${opts.fileName} flush failed`, e);
    });
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      writeNow();
      return;
    }
    // 还有排队中的 read→mutate:排完再写,别把挂起的改动丢掉。
    if (cache) void queue.then(writeNow);
  }

  return {
    load,
    peek: (vaultRoot) => (cache && cache.vault === vaultRoot ? cache.data : null),
    update,
    flush,
  };
}

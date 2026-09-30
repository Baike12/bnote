import { api } from "@/lib/tauri";
import { joinPath } from "@/lib/path";
import { todayStamp } from "@/editor/ops";
import { useAppStore } from "@/state/appStore";
import {
  diffBlocks,
  footprintsFilePath,
  isAggregatePath,
  type FootprintBlock,
  type StoredFootprints,
} from "./model";

/**
 * 今日足迹的运行期存储:基线落盘(<vault>/.bnote/daily-footprints.json)、
 * 跨天轮转、内存增量索引与变更广播。与 daily/links.ts 同一套约定——
 * 模块级单例、写盘 300ms 防抖、revision+listeners 广播给编辑器装饰。
 *
 * 「今天记了什么」的唯一事实来源:
 *  - 基线 = 天切换时刻的全库快照(轮转一次,每天至多一次全库读);
 *  - 足迹 = 当前盘上内容 diff 基线(只对 watcher 报告的脏路径做,1s 防抖);
 *  - 打开今日日记时全量兜底重建一次(覆盖「应用没开着时改的文件」——
 *    watcher 只报运行期变更,重启后没有脏路径可喂)。
 *
 * 竞争纪律:所有异步回调(writeFile/readFile 之后)先自证「我还是当前仓库、
 * 还是同一天」,过期即放弃,不盲写索引。
 */

// ------------------------------------------------------- 变更通知(库 → 视图)

let revision = 0;
const listeners = new Set<() => void>();

/** 索引版本号,每次内容变化 +1。 */
export function footprintRevision(): number {
  return revision;
}

/** 订阅索引变更(编辑器装饰据此重算);返回退订。 */
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

// ---------------------------------------------------------------- 依赖注入

/** 外部世界:文件 IO。读失败(不存在等)折叠为 null。 */
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

/** watcher 报告的脏路径,攒够 1s 再 diff——足迹不需要 300ms 级的实时。 */
const DIRTY_DELAY = 1000;
const PERSIST_DELAY = 300;
/** 打开日记触发的全量兜底节流:快速来回切文件不重复全库读。 */
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

// ---------------------------------------------------------------- 核心

export class FootprintCore {
  /** 基线归属日(YYYY-MM-DD);空串 = 尚未轮转(首次使用/元数据损坏)。 */
  private day = "";
  private baselines = new Map<string, string>();
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

  /** 载入基线元数据并按需轮转;元数据缺失/损坏按「从未轮转」处理(当天首启
   *  即全库快照——否则空基线会把整个旧库都算成今天的记录)。 */
  async init(): Promise<void> {
    const raw = await this.deps.io.readFile(footprintsFilePath(this.vault));
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoredFootprints>;
        if (parsed.version === 1 && typeof parsed.day === "string" && parsed.baselines) {
          this.day = parsed.day;
          this.baselines = new Map(Object.entries(parsed.baselines));
        }
      } catch {
        // 损坏的元数据当从未轮转:今天立刻重建基线,不影响笔记本体
      }
    }
    await this.rotateIfNeeded();
  }

  /** 实例仍是模块单例(cache === null 只见于测试直建的实例);换仓后旧实例的
   *  在途回调据此放弃,不盲写无人观察的索引。 */
  private stillCurrent(): boolean {
    return cache === null || cache === this;
  }

  // ---- 轮转

  private rotateIfNeeded(): Promise<void> {
    if (this.day === this.deps.today()) return Promise.resolve();
    if (!this.rotating) {
      this.rotating = this.doRotate().finally(() => {
        this.rotating = null;
      });
    }
    return this.rotating;
  }

  /** 天切换:全库快照成为新基线,旧足迹作废。跨零点前几分钟写的内容会被
   *  吞进基线(漏显一次)——分钟级影响,接受;后续可加 mtime 精化。 */
  private async doRotate(): Promise<void> {
    const today = this.deps.today();
    const { files } = await this.deps.io.listFiles();
    if (!this.stillCurrent() || this.deps.today() !== today) return;
    const baselines: Record<string, string> = {};
    await Promise.all(
      files.map(async (rel) => {
        const abs = joinPath(this.vault, rel);
        if (!isAggregatePath(abs, this.vault)) return;
        const text = await this.deps.io.readFile(abs);
        // 回调自证:换仓或又跨了天(理论不可能,守卫一致)就丢弃
        if (!this.stillCurrent() || this.deps.today() !== today) return;
        if (text !== null) baselines[abs] = text;
      }),
    );
    if (!this.stillCurrent() || this.deps.today() !== today) return;
    this.day = today;
    this.baselines = new Map(Object.entries(baselines));
    this.index.clear();
    markFootprintsChanged();
    this.schedulePersist();
  }

  // ---- 索引更新

  /** watcher 喂入口:过滤出可聚合路径,防抖后 diff。非聚合路径零开销。 */
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

  /** 只对脏路径读盘 diff;文件已删除(读不到)则从索引移除。 */
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

  /** 全量兜底重建(打开今日日记时调用):读全库重算索引,覆盖应用未运行
   *  期间改动、且 watcher 从未报告过的文件。带节流。 */
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

  // ---- 查询

  /** 某文件的今日足迹块;无记录返回空数组。 */
  footprintsFor(path: string): FootprintBlock[] {
    return this.index.get(path) ?? [];
  }

  /** 今日全部有足迹的文件(按路径排序,widget 渲染顺序稳定)。 */
  todayEntries(): { path: string; blocks: FootprintBlock[] }[] {
    return [...this.index.entries()]
      .filter(([, blocks]) => blocks.length > 0)
      .map(([path, blocks]) => ({ path, blocks }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  get baselineDay(): string {
    return this.day;
  }

  // ---- 持久化(只有轮转改基线)

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeNow();
    }, PERSIST_DELAY);
  }

  private writeNow(): void {
    const stored: StoredFootprints = {
      version: 1,
      day: this.day,
      baselines: Object.fromEntries(this.baselines),
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

  /** 测试/开发钩子:直接替换内存索引并广播(harness 的 __setFootprints 用)。 */
  installIndexForTest(index: Map<string, FootprintBlock[]>): void {
    this.index = index;
    markFootprintsChanged();
  }
}

// ---------------------------------------------------------------- 模块级单例

let cache: FootprintCore | null = null;

/** 读取(或换仓后重建)足迹库;轮转在后台完成,不阻塞开仓。 */
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

function peekCore(): FootprintCore | null {
  return cache;
}

/** watcher 喂入口;库未加载时静默(ensureFootprints 完成后由全量兜底补齐)。 */
export function noteDirtyPaths(paths: string[]): void {
  cache?.noteDirty(paths);
}

/** 打开今日日记时的全量兜底;库未加载先建(不依赖 ensureFootprints 的时序)。 */
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

/** 当前基线归属日;库未加载返回 null。测试与调试用。 */
export function footprintDay(): string | null {
  return cache?.baselineDay ?? null;
}

export function hasPendingFootprintsPersist(): boolean {
  return cache?.hasPendingPersist() ?? false;
}

/** 退出/隐藏前冲刷基线写盘。 */
export function flushFootprintsPersist(): void {
  cache?.flushPersist();
}

/** harness 调试钩子:注入假索引(harness 的 __setFootprints)。 */
export function setFootprintIndexForTest(vaultRoot: string, index: Map<string, FootprintBlock[]>): void {
  if (cache && cache.vault === vaultRoot) {
    cache.installIndexForTest(index);
  } else {
    const core = new FootprintCore({ io: tauriFootprintIO, today: () => todayStamp() }, vaultRoot);
    cache = core;
    core.installIndexForTest(index);
  }
}

export function peekFootprintCore(): FootprintCore | null {
  return peekCore();
}

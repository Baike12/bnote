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
 * 「某天记了什么」的唯一事实来源:
 *  - 基线 = 天切换时刻的全库快照(轮转一次,每天至多一次全库读);
 *  - 今日足迹 = 当前盘上内容 diff 基线(只对 watcher 报告的脏路径做,1s 防抖);
 *  - 历史足迹 = 轮转时把旧基线日的 diff 固化成档案(history[日期][路径]),
 *    之后只读不重算——打开历史日记据此聚合那一天的足迹;
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
  /** 历史足迹档:日期 → 路径 → 当日足迹块。轮转时固化,之后只读。 */
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

  /** 载入基线元数据并按需轮转;元数据缺失/损坏按「从未轮转」处理(当天首启
   *  即全库快照——否则空基线会把整个旧库都算成今天的记录)。v1(无历史档)
   *  照常载入基线,历史档为空——升级前的日子没有档案,不去编造。 */
  async init(): Promise<void> {
    const raw = await this.deps.io.readFile(footprintsFilePath(this.vault));
    if (raw) {
      try {
        // 磁盘上 v1/v2 并存(v1 无 history 字段),形状守卫逐字段验证
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

  /** 天切换:全库快照成为新基线;旧基线日的足迹 diff 固化成历史档,历史
   *  日记据此聚合。跨零点前几分钟写的内容会被算进旧基线日的档案(漏显一次)
   *  ——分钟级影响,接受;后续可加 mtime 精化。应用多天没开时,中间的日子
   *  没有任何快照可 diff,档案缺失——那天打开就是没有足迹区(不编造)。 */
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
        // 回调自证:换仓或又跨了天(理论不可能,守卫一致)就丢弃
        if (!this.stillCurrent() || this.deps.today() !== today) return;
        if (text !== null) snapshot[abs] = text;
      }),
    );
    if (!this.stillCurrent() || this.deps.today() !== today) return;
    // 旧基线日的足迹 = 旧基线 diff 当前盘面;与换基线共用同一批读盘文本,
    // 零额外 IO。首次使用(无旧基线)没有「那一天」,不产生档案。
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
    return this.entriesOf(this.index);
  }

  /** 某日的足迹条目:今日 → 实时索引;历史日 → 固化档案(只读)。
   *  无记录的日期返回空数组。core 尚未轮转(day 为空串:注入路径/init 空窗)
   *  时唯一可用的数据面是实时索引,任何日期都走它。 */
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

  /** 跨天后首次访问:完成轮转(旧日档案固化 + 基线换日)。幂等,打开任意
   *  日记时调用——历史日记也因此能立即看到刚固化的档案。 */
  async ensureDay(): Promise<void> {
    await this.rotateIfNeeded();
  }

  /** 测试/开发钩子:注入某历史日的档案(harness 的 __setFootprints 用)。 */
  installHistoryForTest(day: string, entries: Map<string, FootprintBlock[]>): void {
    this.history.set(day, entries);
    markFootprintsChanged();
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

/** 某日的足迹条目(今日实时、历史读档);库未加载返回空。 */
export function footprintEntriesFor(day: string): { path: string; blocks: FootprintBlock[] }[] {
  return cache?.entriesFor(day) ?? [];
}

/** 打开任意日记时的轮转值守:跨天后首次访问在这里完成档案固化。幂等。 */
export async function ensureFootprintDay(): Promise<void> {
  await cache?.ensureDay();
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

/** harness 调试钩子:注入某历史日的档案(harness 的 __setFootprints 带 day 时)。 */
export function setFootprintHistoryForTest(
  vaultRoot: string,
  day: string,
  entries: Map<string, FootprintBlock[]>,
): void {
  if (!cache || cache.vault !== vaultRoot) setFootprintIndexForTest(vaultRoot, new Map());
  cache?.installHistoryForTest(day, entries);
}

export function peekFootprintCore(): FootprintCore | null {
  return peekCore();
}

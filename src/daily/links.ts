import { api } from "@/lib/tauri";
import { linksFilePath } from "./model";

/**
 * 跨文件待办映射的持久化存储。一条链接把一个源待办块(项目笔记里)和一个
 * 日记条目绑在一起,两侧通过「待办身份文本」互认(剥 checkbox/✅戳后的行
 * 内容),行号只是就近提示。
 *
 * 持久化在 vault 内 `<vault>/.bnote/daily-links.json`——随仓库走、重启不丢;
 * 写盘 300ms 防抖,退出/隐藏时由 App.tsx 冲刷(与 config 持久化同一套约定)。
 * 多实例同仓并发写是 last-write-wins,与编辑器本身的并发语义一致。
 */

export interface DailyLink {
  id: string;
  /** copied = 快捷键主动发送;recorded = 勾选完成时自动记录 */
  kind: "copied" | "recorded";
  /** 日记归属日(YYYY-MM-DD),记录创建时间 */
  day: string;
  /** 源文件绝对路径(项目笔记) */
  srcPath: string;
  /** 日记文件绝对路径 */
  dailyPath: string;
  /** 两侧共用的待办身份文本(镜像保证两侧文本一致) */
  text: string;
  /** 上次同步时源根行号(就近提示) */
  srcLine: number;
  /** 上次同步时日记条目起始行号(就近提示) */
  dailyLine: number;
}

interface StoredLinks {
  version: 1;
  links: DailyLink[];
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
      // 损坏的元数据当空库用:同步功能从零重建,不影响笔记本体
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

  /** 某个文件(源或日记任一侧)参与的所有链接。 */
  forFile(path: string): DailyLink[] {
    return this.all().filter((l) => l.srcPath === path || l.dailyPath === path);
  }

  /**
   * 按身份文本找链接:限定 `path` 参与(源或日记侧),同文多条时取行号提示
   * 离 `nearLine` 最近者。找不到返回 null。
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
  }

  update(id: string, patch: Partial<Omit<DailyLink, "id">>): void {
    const cur = this.links.get(id);
    if (cur) this.links.set(id, { ...cur, ...patch });
  }

  remove(id: string): void {
    this.links.delete(id);
  }
}

// -------------------------------------------------------- 运行期单例 + 持久化

let cache: { vault: string; store: LinkStore } | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** 读取(或换仓后重读)链接库;失败当空库。 */
export async function ensureLinks(vaultRoot: string): Promise<LinkStore> {
  if (cache && cache.vault === vaultRoot) return cache.store;
  let raw: string | null = null;
  try {
    raw = await api.readFile(linksFilePath(vaultRoot));
  } catch {
    raw = null; // 不存在 = 还没有任何映射
  }
  const store = LinkStore.fromJSON(raw);
  cache = { vault: vaultRoot, store };
  return store;
}

/** 同步取已加载的链接库;尚未加载或换了仓库返回 null(调用方跳过本轮同步)。 */
export function peekLinks(vaultRoot: string): LinkStore | null {
  return cache && cache.vault === vaultRoot ? cache.store : null;
}

export function hasPendingLinksPersist(): boolean {
  return persistTimer !== null;
}

/** 立即写出挂起的链接元数据(退出/隐藏前冲刷)。 */
export function flushLinksPersist(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  writeNow();
}

function writeNow(): void {
  if (!cache) return;
  void api.writeFile(linksFilePath(cache.vault), cache.store.toJSON()).catch((e) =>
    console.warn("daily links persist failed", e),
  );
}

/** 链接库有变更后排程写盘(300ms 防抖)。 */
export function scheduleLinksPersist(): void {
  if (!cache) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeNow();
  }, 300);
}

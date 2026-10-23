import { createVaultJsonStore, vaultDotPath, type JsonIO } from "./vaultJson";

/**
 * 学习模式的阅读位置:PDF 记「第几页 + 页内偏移」,网页记「滚动比例」。
 *
 * PDF 的页码/页内比例在缩放、栏宽变化、裁剪下都成立:重排后同一页仍从
 * 同一处继续读。网页拿不到自己的滚动容器(DOM 在主窗口之外),而且广告/
 * 懒加载会让像素位置失效,所以用「可滚高度里的比例」。
 *
 * 全部落在一个 `<vault>/.bnote/read-positions.json` 里:这条数据是易变的
 * 阅读痕迹,不是用户内容,不需要按 PDF/网址各占一个文件;写入仍由
 * `createVaultJsonStore` 串行化,同一时刻只有一个写入者。
 */
export interface PdfReadPosition {
  /** 1-based 页码。 */
  page: number;
  /** 页内偏移(0..1,页面高度的比例)。 */
  offset: number;
  /** Unix ms,只用于裁剪旧条目。 */
  at: number;
}

export interface WebReadPosition {
  /** 0..1:scrollTop / (scrollHeight - clientHeight)。 */
  ratio: number;
  at: number;
}

export interface ReadPositions {
  version: 1;
  pdfs: Record<string, PdfReadPosition>;
  urls: Record<string, WebReadPosition>;
}

/** 位置会随阅读不断新增;只保留最近的一批,文件不会无限长。 */
export const MAX_TRACKED_POSITIONS = 500;

export function emptyReadPositions(): ReadPositions {
  return { version: 1, pdfs: {}, urls: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function prune<T extends { at: number }>(record: Record<string, T>): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= MAX_TRACKED_POSITIONS) return record;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_POSITIONS));
}

/** 手改/旧版本留下的坏字段一律丢掉,绝不让配置在启动时把阅读器打挂。 */
export function normalizeReadPositions(raw: unknown): ReadPositions {
  const out = emptyReadPositions();
  if (!isRecord(raw)) return out;
  if (isRecord(raw.pdfs)) {
    for (const [key, value] of Object.entries(raw.pdfs)) {
      if (!key || !isRecord(value)) continue;
      const page = Math.floor(num(value.page));
      if (page < 1) continue;
      out.pdfs[key] = {
        page,
        offset: clamp01(num(value.offset)),
        at: num(value.at),
      };
    }
  }
  if (isRecord(raw.urls)) {
    for (const [key, value] of Object.entries(raw.urls)) {
      if (!key || !isRecord(value)) continue;
      out.urls[key] = { ratio: clamp01(num(value.ratio)), at: num(value.at) };
    }
  }
  out.pdfs = prune(out.pdfs);
  out.urls = prune(out.urls);
  return out;
}

export function parseReadPositions(raw: string | null): ReadPositions {
  if (!raw) return emptyReadPositions();
  try {
    return normalizeReadPositions(JSON.parse(raw));
  } catch {
    return emptyReadPositions();
  }
}

/** 页面在滚动内容里的位置(像素)。 */
export interface PageMetric {
  page: number;
  top: number;
  height: number;
}

/**
 * 滚动位置 → 页码 + 页内偏移。取「顶边已经越过视口顶部的最后一页」:
 * 页面之间有间隙时,视口顶部落在间隙里仍算上一页(偏移 > 1 会被夹到 1)。
 */
export function pdfPositionAt(pages: PageMetric[], scrollTop: number): PdfReadPosition | null {
  if (pages.length === 0) return null;
  const sorted = [...pages].sort((a, b) => a.top - b.top);
  let chosen = sorted[0];
  for (const p of sorted) {
    if (p.top <= scrollTop + 2) chosen = p;
    else break;
  }
  const offset = chosen.height > 0 ? (scrollTop - chosen.top) / chosen.height : 0;
  return { page: chosen.page, offset: clamp01(offset), at: 0 };
}

/** 页码 + 页内偏移 → 绝对 scrollTop;页码已不存在(换了文件)时返回 null。 */
export function scrollTopForPdfPosition(
  pages: PageMetric[],
  position: Pick<PdfReadPosition, "page" | "offset">,
): number | null {
  const target = pages.find((p) => p.page === position.page);
  if (!target) return null;
  return Math.max(0, target.top + clamp01(position.offset) * target.height);
}

function createReadPositionStore(io?: JsonIO) {
  return createVaultJsonStore<ReadPositions>({
    pathFor: (vaultRoot) => vaultDotPath(vaultRoot, "read-positions.json"),
    empty: emptyReadPositions,
    parse: parseReadPositions,
    serialize: (data) => JSON.stringify(data),
    io,
  });
}

/** 单例:同一份文件只有一个缓存/写入者。 */
export const readPositionStore = createReadPositionStore();

/** 测试用:注入假 IO 的独立存储。 */
export { createReadPositionStore };

const KEY = "positions";

export async function loadReadPositions(vaultRoot: string): Promise<ReadPositions> {
  return readPositionStore.load(vaultRoot, KEY);
}

export function savePdfReadPosition(
  vaultRoot: string,
  docKey: string,
  position: Pick<PdfReadPosition, "page" | "offset">,
): void {
  readPositionStore.update(vaultRoot, KEY, (data) => ({
    ...data,
    pdfs: prune({
      ...data.pdfs,
      [docKey]: { ...position, at: Date.now() },
    }),
  }));
}

export function saveWebReadPosition(
  vaultRoot: string,
  url: string,
  ratio: number,
): void {
  readPositionStore.update(vaultRoot, KEY, (data) => ({
    ...data,
    urls: prune({
      ...data.urls,
      [url]: { ratio: clamp01(ratio), at: Date.now() },
    }),
  }));
}

export function flushReadPositions(): void {
  readPositionStore.flush();
}

/**
 * Study-mode content history: PDFs and web pages are kept in two separate
 * lists. They are different kinds of material (one lives in the vault, one is
 * a URL that can go stale) and the middle-column menu shows them under
 * separate buttons — interleaving them in one list would make neither easy to
 * find.
 *
 * Entries are newest-first, deduplicated by identity (absolute PDF path /
 * URL), and capped so a long-lived config does not grow without bound.
 */

export interface StudyPdfEntry {
  /** Absolute path inside the vault. */
  path: string;
  /** Vault-relative path (display + portability when the vault moves). */
  relPath: string;
  title: string;
  /** Unix ms of the last open. */
  at: number;
}

export interface StudyUrlEntry {
  url: string;
  title: string;
  at: number;
}

/**
 * 微信读书里打开过的一本书。url 是阅读器路由(origin + pathname,不带
 * query),微信读书的阅读进度在它自己的账号里,这里只记「打开过哪里」。
 */
export interface WereadBookEntry {
  url: string;
  title: string;
  at: number;
}

export interface StudyHistory {
  pdfs: StudyPdfEntry[];
  urls: StudyUrlEntry[];
  weread: WereadBookEntry[];
}

export const STUDY_HISTORY_LIMIT = 30;

export function emptyStudyHistory(): StudyHistory {
  return { pdfs: [], urls: [], weread: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Tolerates a hand-edited or older config.json: whatever does not validate is
 * dropped, never allowed to crash the app at startup.
 */
export function normalizeStudyHistory(raw: unknown): StudyHistory {
  if (!isRecord(raw)) return emptyStudyHistory();
  const pdfs: StudyPdfEntry[] = [];
  const urls: StudyUrlEntry[] = [];
  if (Array.isArray(raw.pdfs)) {
    for (const item of raw.pdfs) {
      if (!isRecord(item)) continue;
      const path = str(item.path);
      const title = str(item.title);
      if (!path || !title) continue;
      pdfs.push({
        path,
        relPath: str(item.relPath) ?? title,
        title,
        at: num(item.at),
      });
    }
  }
  if (Array.isArray(raw.urls)) {
    for (const item of raw.urls) {
      if (!isRecord(item)) continue;
      const url = str(item.url);
      const title = str(item.title);
      if (!url || !title) continue;
      urls.push({ url, title, at: num(item.at) });
    }
  }
  const weread: WereadBookEntry[] = [];
  if (Array.isArray(raw.weread)) {
    for (const item of raw.weread) {
      if (!isRecord(item)) continue;
      const url = str(item.url);
      const title = str(item.title);
      if (!url || !title) continue;
      weread.push({ url, title, at: num(item.at) });
    }
  }
  return {
    pdfs: pdfs.slice(0, STUDY_HISTORY_LIMIT),
    urls: urls.slice(0, STUDY_HISTORY_LIMIT),
    weread: weread.slice(0, STUDY_HISTORY_LIMIT),
  };
}

function cap<T>(list: T[]): T[] {
  return list.length > STUDY_HISTORY_LIMIT ? list.slice(0, STUDY_HISTORY_LIMIT) : list;
}

/** Moves/reinserts the opened PDF at the head of the list. */
export function pushPdfEntry(
  history: StudyHistory,
  entry: Omit<StudyPdfEntry, "at"> & { at?: number },
): StudyHistory {
  const at = entry.at ?? Date.now();
  const next: StudyPdfEntry = {
    path: entry.path,
    relPath: entry.relPath,
    title: entry.title,
    at,
  };
  return {
    ...history,
    pdfs: cap([next, ...history.pdfs.filter((e) => e.path !== next.path)]),
  };
}

/** Moves/reinserts the opened web page at the head of the list. */
export function pushUrlEntry(
  history: StudyHistory,
  entry: Omit<StudyUrlEntry, "at"> & { at?: number },
): StudyHistory {
  const at = entry.at ?? Date.now();
  const next: StudyUrlEntry = { url: entry.url, title: entry.title, at };
  return {
    ...history,
    urls: cap([next, ...history.urls.filter((e) => e.url !== next.url)]),
  };
}

/**
 * Moves/reinserts the opened weread book at the head of the list. The same
 * book is reported twice per session (route change, then title extraction
 * finishing) — dedup by url keeps one row and the later, better title wins.
 */
export function pushWereadBook(
  history: StudyHistory,
  entry: Omit<WereadBookEntry, "at"> & { at?: number },
): StudyHistory {
  const at = entry.at ?? Date.now();
  const next: WereadBookEntry = { url: entry.url, title: entry.title, at };
  return {
    ...history,
    weread: cap([next, ...history.weread.filter((e) => e.url !== next.url)]),
  };
}

// `unknown` on purpose: a hand-edited config.json is normalized at startup,
// but one malformed entry must never take the whole study pane down.
const isUnder = (path: unknown, root: string) =>
  typeof path === "string" &&
  (path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`));

/**
 * PDFs of the currently open vault only: `read_file_base64` is vault-confined,
 * so listing an entry from another vault would only produce a dead row.
 */
export function pdfHistoryForVault(history: StudyHistory, vaultPath: string | null): StudyPdfEntry[] {
  if (!vaultPath) return history.pdfs;
  return history.pdfs.filter((e) => isUnder(e.path, vaultPath));
}

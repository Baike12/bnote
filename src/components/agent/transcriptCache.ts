/**
 * The parse result of a session record, kept warm across re-opens.
 *
 * Opening a long history pays `parseTranscript` and `sessionMetaFromRaw`, and
 * both walk every line of the file (the meta scan is a second full pass). The
 * same session is re-opened often — the sidebar switches back to it — so the
 * parsed lines are cached per file and reused while the file is unchanged.
 *
 * The freshness check is the record's own shape, not a timestamp: the format
 * is append-only, so a different length means new content; a same-length
 * rewrite can only be the metadata line at the head (a title change), which
 * the head fingerprint catches. A hit therefore never serves a stale record.
 */
import {
  parseTranscript,
  sessionMetaFromRaw,
  type TranscriptLine,
  type TranscriptMetaLine,
} from "@/study/transcript";

/** How many parsed records stay warm (Zed's session cache is the same order). */
export const TRANSCRIPT_CACHE_LIMIT = 5;

/** Characters of the head that identify a same-length metadata rewrite. */
const FINGERPRINT_HEAD = 200;

export interface ParsedTranscript {
  fingerprint: string;
  lines: TranscriptLine[];
  meta: TranscriptMetaLine | null;
}

export interface TranscriptCache {
  /** Parse `raw`, or return the previous parse when the file is unchanged. */
  get(path: string, raw: string): ParsedTranscript;
  clear(): void;
}

function fingerprintOf(raw: string): string {
  return `${raw.length}:${raw.slice(0, FINGERPRINT_HEAD)}`;
}

export function createTranscriptCache(limit = TRANSCRIPT_CACHE_LIMIT): TranscriptCache {
  // Insertion order is the LRU order: a hit re-inserts the key.
  const entries = new Map<string, ParsedTranscript>();
  return {
    get(path, raw) {
      const fingerprint = fingerprintOf(raw);
      const hit = entries.get(path);
      if (hit && hit.fingerprint === fingerprint) {
        entries.delete(path);
        entries.set(path, hit);
        return hit;
      }
      const parsed: ParsedTranscript = {
        fingerprint,
        lines: parseTranscript(raw),
        meta: sessionMetaFromRaw(raw),
      };
      entries.delete(path);
      entries.set(path, parsed);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return parsed;
    },
    clear: () => entries.clear(),
  };
}

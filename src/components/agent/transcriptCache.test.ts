import { describe, expect, it } from "vitest";
import { TRANSCRIPT_CACHE_LIMIT, createTranscriptCache } from "./transcriptCache";

const line = (value: unknown) => JSON.stringify(value);

/** A minimal valid record: the meta line first, then one user message. */
function record(title: string, text = "hi"): string {
  return (
    [
      line({
        type: "meta",
        at: 1,
        title,
        model: { provider: "p", model: "m", baseUrl: "u", maxTokens: 1, contextWindow: 2 },
      }),
      line({ type: "user", at: 2, text }),
    ].join("\n") + "\n"
  );
}

describe("createTranscriptCache", () => {
  it("serves the previous parse of an unchanged file", () => {
    const cache = createTranscriptCache();
    const raw = record("a");
    const first = cache.get("/p/a.jsonl", raw);
    const second = cache.get("/p/a.jsonl", raw);
    expect(second).toBe(first);
    expect(first.meta?.title).toBe("a");
    expect(first.lines).toHaveLength(1);
  });

  it("re-parses an appended record", () => {
    const cache = createTranscriptCache();
    const first = cache.get("/p/a.jsonl", record("a"));
    const grown = cache.get(
      "/p/a.jsonl",
      record("a") + line({ type: "user", at: 3, text: "y" }) + "\n",
    );
    expect(grown).not.toBe(first);
    expect(grown.lines).toHaveLength(2);
  });

  it("re-parses a same-length head rewrite (a title change)", () => {
    const cache = createTranscriptCache();
    const first = cache.get("/p/a.jsonl", record("ab"));
    const renamed = cache.get("/p/a.jsonl", record("cd"));
    expect(renamed).not.toBe(first);
    expect(renamed.meta?.title).toBe("cd");
  });

  it("keeps paths apart", () => {
    const cache = createTranscriptCache();
    const a = cache.get("/p/a.jsonl", record("a"));
    const b = cache.get("/p/b.jsonl", record("a"));
    expect(b).not.toBe(a);
  });

  it("evicts the least recently used record past the limit", () => {
    const cache = createTranscriptCache(2);
    const rawA = record("a");
    const rawB = record("b");
    const cachedA = cache.get("a", rawA);
    const cachedB = cache.get("b", rawB);
    cache.get("a", rawA); // a is now the most recent
    cache.get("c", record("c"));
    // a survived the insert (b was the LRU), still the same object.
    expect(cache.get("a", rawA)).toBe(cachedA);
    // Re-inserting the evicted b is a second, newer entry; the check above
    // already ran while a was still cached.
    expect(cache.get("b", rawB)).not.toBe(cachedB);
  });

  it("the default limit is the documented size", () => {
    const cache = createTranscriptCache();
    const first = cache.get("0", record("a"));
    for (let i = 1; i <= TRANSCRIPT_CACHE_LIMIT; i += 1) cache.get(String(i), record("b"));
    expect(cache.get("0", record("a"))).not.toBe(first);
  });

  it("clear drops everything", () => {
    const cache = createTranscriptCache();
    const first = cache.get("a", record("a"));
    cache.clear();
    expect(cache.get("a", record("a"))).not.toBe(first);
  });
});

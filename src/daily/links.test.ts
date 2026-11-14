import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLinks,
  flushLinksPersist,
  hasPendingLinksPersist,
  LinkStore,
  onLinksChanged,
  peekLinks,
  scheduleLinksPersist,
  type DailyLink,
} from "./links";

/**
 * The link store is also the only writer of its metadata file, so the persistence
 * contract is locked here: a 300ms debounce, one flush on quit, and a corrupted or
 * unreadable file never blocks the sync feature (it starts from an empty store).
 */

const api = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<string> => {
    throw new Error("missing");
  }),
  writeFile: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
}));
vi.mock("@/lib/tauri", () => ({ api }));

const link = (patch: Partial<DailyLink>): DailyLink => ({
  id: "l1",
  kind: "copied",
  day: "2026-09-23",
  srcPath: "/vault/proj/a.md",
  dailyPath: "/vault/Daily/2026-09-23.md",
  text: "任务甲",
  srcLine: 3,
  dailyLine: 3,
  ...patch,
});

describe("LinkStore serialization round trip", () => {
  it("upsert → toJSON → fromJSON keeps every field", () => {
    const s = new LinkStore();
    s.upsert(link({ id: "l1" }));
    s.upsert(link({ id: "l2", kind: "recorded", text: "任务乙" }));
    const back = LinkStore.fromJSON(s.toJSON());
    expect(back.all().length).toBe(2);
    expect(back.getById("l2")).toMatchObject({ kind: "recorded", text: "任务乙", srcLine: 3 });
  });

  it("null / broken JSON / wrong version all give an empty store", () => {
    expect(LinkStore.fromJSON(null).all()).toEqual([]);
    expect(LinkStore.fromJSON("{broken").all()).toEqual([]);
    expect(LinkStore.fromJSON(JSON.stringify({ version: 99, links: [] })).all()).toEqual([]);
  });
});

describe("forFile / findByText", () => {
  /** A fresh store per test: one test removes a link, which must not leak into another. */
  function seeded(): LinkStore {
    const store = new LinkStore();
    store.upsert(link({ id: "a" }));
    store.upsert(link({ id: "b", srcPath: "/vault/proj/b.md", text: "任务乙" }));
    store.upsert(
      link({
        id: "c",
        srcPath: "/vault/proj/c.md",
        dailyPath: "/vault/Daily/2026-09-22.md",
        text: "昨天的",
      }),
    );
    return store;
  }

  it("forFile matches on the source side or the daily note side", () => {
    const s = seeded();
    expect(s.forFile("/vault/proj/a.md").map((l) => l.id)).toEqual(["a"]);
    expect(
      s
        .forFile("/vault/Daily/2026-09-23.md")
        .map((l) => l.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(s.forFile("/vault/none.md")).toEqual([]);
  });

  it("findByText restricts to the files that take part and uses the line hint to pick the nearest", () => {
    const s = seeded();
    expect(s.findByText("/vault/proj/a.md", "任务甲", 10)?.id).toBe("a");
    expect(s.findByText("/vault/Daily/2026-09-23.md", "任务乙", 5)?.id).toBe("b");
    expect(s.findByText("/vault/proj/b.md", "任务甲", 3)).toBe(null); // the file does not take part
    expect(s.findByText("/vault/proj/a.md", "不存在", 3)).toBe(null);
  });

  it("update / remove", () => {
    const s = seeded();
    s.update("a", { srcLine: 9, text: "改名了" });
    expect(s.getById("a")).toMatchObject({ srcLine: 9, text: "改名了" });
    s.remove("a");
    expect(s.getById("a")).toBe(null);
  });
});

describe("LinkStore.fromJSON shape guard", () => {
  it("entries without an id or a srcPath are dropped, valid neighbours are kept", () => {
    const raw = JSON.stringify({
      version: 1,
      links: [link({ id: "keep" }), { id: "no-src", text: "x" }, { srcPath: "/v/a.md" }, null],
    });
    const back = LinkStore.fromJSON(raw);
    expect(back.all().map((l) => l.id)).toEqual(["keep"]);
  });
});

describe("the change broadcast", () => {
  it("every writer (upsert, update, remove) notifies; a no-op remove and an update of a missing id stay silent", () => {
    const store = new LinkStore();
    let hits = 0;
    const off = onLinksChanged(() => {
      hits++;
    });
    store.upsert(link({ id: "a" }));
    expect(hits).toBe(1);
    store.update("a", { srcLine: 7 });
    expect(hits).toBe(2);
    store.update("missing", { srcLine: 7 });
    expect(hits).toBe(2);
    store.remove("missing");
    expect(hits).toBe(2);
    store.remove("a");
    expect(hits).toBe(3);
    off();
    store.upsert(link({ id: "b" }));
    expect(hits).toBe(3);
  });
});

describe("runtime singleton and persistence", () => {
  beforeEach(() => {
    api.readFile.mockReset();
    api.readFile.mockRejectedValue(new Error("missing"));
    api.writeFile.mockReset();
    api.writeFile.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the metadata file lives in the vault, the store is cached per vault and a vault swap reads the new one", async () => {
    api.readFile.mockResolvedValueOnce(
      JSON.stringify({ version: 1, links: [link({ id: "cached", text: "旧仓库" })] }),
    );
    const first = await ensureLinks("/vault-a");
    expect(api.readFile).toHaveBeenCalledWith("/vault-a/.bnote/daily-links.json");
    expect(first.all().map((l) => l.id)).toEqual(["cached"]);
    expect(peekLinks("/vault-a")).toBe(first);

    api.readFile.mockResolvedValueOnce(JSON.stringify({ version: 1, links: [] }));
    const second = await ensureLinks("/vault-b");
    expect(api.readFile).toHaveBeenLastCalledWith("/vault-b/.bnote/daily-links.json");
    expect(second).not.toBe(first);
    // The old vault no longer answers: a stale sync round is dropped by the caller
    expect(peekLinks("/vault-a")).toBeNull();
    expect(peekLinks("/vault-b")).toBe(second);
  });

  it("a failed read (first run, deleted file) yields an empty store instead of blocking", async () => {
    const store = await ensureLinks("/vault-empty");
    expect(store.all()).toEqual([]);
  });

  it("a corrupted metadata file is treated as an empty store", async () => {
    api.readFile.mockResolvedValueOnce("{{{not json");
    const store = await ensureLinks("/vault-broken");
    expect(store.all()).toEqual([]);
  });

  it("a change is persisted once after the 300ms debounce, not once per writer call", async () => {
    const store = await ensureLinks("/vault-debounce");
    store.upsert(link({ id: "a" }));
    scheduleLinksPersist();
    store.upsert(link({ id: "b", text: "任务乙" }));
    scheduleLinksPersist();
    expect(hasPendingLinksPersist()).toBe(true);
    expect(api.writeFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(299);
    expect(api.writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(api.writeFile).toHaveBeenCalledWith(
      "/vault-debounce/.bnote/daily-links.json",
      store.toJSON(),
    );
    expect(hasPendingLinksPersist()).toBe(false);
  });

  it("flushLinksPersist writes the pending metadata right away and is a no-op when nothing is pending", async () => {
    const store = await ensureLinks("/vault-flush");
    flushLinksPersist();
    expect(api.writeFile).not.toHaveBeenCalled();

    store.upsert(link({ id: "a" }));
    scheduleLinksPersist();
    flushLinksPersist();
    expect(hasPendingLinksPersist()).toBe(false);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    // The timer was cleared: no second write when the debounce would have fired
    await vi.advanceTimersByTimeAsync(400);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it("a failed write is swallowed with a warning: one failed metadata write never breaks syncing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await ensureLinks("/vault-warn");
    api.writeFile.mockRejectedValueOnce(new Error("disk full"));
    store.upsert(link({ id: "a" }));
    scheduleLinksPersist();
    flushLinksPersist();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith("daily links persist failed", expect.any(Error));
    warn.mockRestore();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vault JSON store's default IO is the real IPC boundary. `vaultJson.test.ts`
 * injects a fake IO for the scheduling rules; this file leaves `io` out, so the
 * store must go through `api.readFile` / `api.writeFile` — a wrong argument or
 * a renamed command fails here.
 */
const boundary = vi.hoisted(() => {
  const files = new Map<string, string>();
  const calls: Array<{ op: "read" | "write"; path: string }> = [];
  let failWrites = 0;
  const api = {
    readFile: async (path: string): Promise<string> => {
      calls.push({ op: "read", path });
      const raw = files.get(path);
      if (raw === undefined) throw new Error(`READ_FAILED: ${path}`);
      return raw;
    },
    writeFile: async (path: string, text: string): Promise<void> => {
      calls.push({ op: "write", path });
      if (failWrites > 0) {
        failWrites -= 1;
        throw new Error("disk full");
      }
      files.set(path, text);
    },
  };
  return {
    files,
    calls,
    api,
    failWrites(times: number) {
      failWrites = times;
    },
  };
});

vi.mock("@/lib/tauri", () => ({ api: boundary.api }));

import { createVaultJsonStore, vaultDotPath } from "./vaultJson";

interface Doc {
  version: 1;
  values: Record<string, string>;
}

const emptyDoc = (): Doc => ({ version: 1, values: {} });

function makeStore() {
  return createVaultJsonStore<Doc>({
    pathFor: (vault, key) => vaultDotPath(vault, `${key}.json`),
    empty: emptyDoc,
    parse: (raw) => {
      if (!raw) return emptyDoc();
      try {
        const parsed = JSON.parse(raw) as Doc;
        return parsed && typeof parsed.values === "object"
          ? { version: 1, values: parsed.values }
          : emptyDoc();
      } catch {
        return emptyDoc();
      }
    },
    serialize: (data) => JSON.stringify(data),
    debounceMs: 5,
  });
}

beforeEach(() => {
  boundary.files.clear();
  boundary.calls.length = 0;
  boundary.failWrites(0);
});

describe("the default IO goes through the typed IPC boundary", () => {
  it("load reads the dot-path file through api.readFile", async () => {
    boundary.files.set("/vault/.bnote/a.json", '{"version":1,"values":{"k":"v"}}');

    const store = makeStore();
    await expect(store.load("/vault", "a")).resolves.toEqual({
      version: 1,
      values: { k: "v" },
    });
    expect(boundary.calls).toEqual([{ op: "read", path: "/vault/.bnote/a.json" }]);
  });

  it("flush writes through api.writeFile to the same path", async () => {
    const store = makeStore();
    await store.load("/vault", "b");
    store.update("/vault", "b", (d) => ({ ...d, values: { k: "v" } }));
    store.flush();
    await vi.waitFor(() =>
      expect(boundary.calls).toContainEqual({ op: "write", path: "/vault/.bnote/b.json" }),
    );

    expect(JSON.parse(boundary.files.get("/vault/.bnote/b.json") ?? "{}").values).toEqual({
      k: "v",
    });
  });

  it("a failed write keeps the change and the next flush retries it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = makeStore();
    await store.load("/vault", "c");
    boundary.failWrites(1);
    store.update("/vault", "c", (d) => ({ ...d, values: { kept: "yes" } }));
    store.flush();
    // The failed write leaves the file absent; the dirty entry is still there.
    await vi.waitFor(() => expect(boundary.calls.filter((c) => c.op === "write")).toHaveLength(1));
    expect(boundary.files.has("/vault/.bnote/c.json")).toBe(false);

    // The next flush tries again, without any further update.
    store.flush();
    await vi.waitFor(() => expect(boundary.files.has("/vault/.bnote/c.json")).toBe(true));
    expect(JSON.parse(boundary.files.get("/vault/.bnote/c.json") ?? "{}").values).toEqual({
      kept: "yes",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("concurrent loads and queued updates", () => {
  it("several load calls share one read (no duplicate IPC for the same file)", async () => {
    boundary.files.set("/vault/.bnote/d.json", '{"version":1,"values":{}}');
    const store = makeStore();

    await Promise.all([
      store.load("/vault", "d"),
      store.load("/vault", "d"),
      store.load("/vault", "d"),
    ]);

    expect(boundary.calls.filter((c) => c.op === "read")).toHaveLength(1);
  });

  it("a flush issued while an update waits behind the read does not lose the change", async () => {
    boundary.files.set("/vault/.bnote/e.json", '{"version":1,"values":{"seed":"1"}}');
    const store = makeStore();

    // No load first: update queues behind the read, so `entries` is still empty
    // when this flush runs — it cannot write yet.
    store.update("/vault", "e", (d) => ({ ...d, values: { ...d.values, add: "2" } }));
    store.flush();

    // The queued change applies once the read lands ...
    await vi.waitFor(() =>
      expect(store.peek("/vault", "e")?.values).toEqual({ seed: "1", add: "2" }),
    );
    // ... and reaches disk, so the flush did not drop it.
    store.flush();
    await vi.waitFor(() =>
      expect(JSON.parse(boundary.files.get("/vault/.bnote/e.json") ?? "{}").values).toEqual({
        seed: "1",
        add: "2",
      }),
    );
  });

  it("two queued updates run in order, so neither value is lost", async () => {
    const store = makeStore();

    store.update("/vault", "f", (d) => ({ ...d, values: { ...d.values, first: "1" } }));
    store.update("/vault", "f", (d) => ({ ...d, values: { ...d.values, second: "2" } }));
    store.flush();

    await vi.waitFor(() =>
      expect(JSON.parse(boundary.files.get("/vault/.bnote/f.json") ?? "{}").values).toEqual({
        first: "1",
        second: "2",
      }),
    );
  });
});

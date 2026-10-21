import { afterEach, describe, expect, it, vi } from "vitest";
import { createVaultJsonStore, vaultDotPath, type JsonIO } from "./vaultJson";

interface Doc {
  version: 1;
  values: Record<string, string>;
}

interface FakeIO extends JsonIO {
  files: Map<string, string>;
  writes: string[];
}

function makeIO(seed: Record<string, string> = {}): FakeIO {
  const files = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    files,
    writes,
    read: async (path) => {
      const raw = files.get(path);
      if (raw === undefined) throw new Error("not found");
      return raw;
    },
    write: async (path, text) => {
      writes.push(path);
      files.set(path, text);
    },
  };
}

function makeStore(io: FakeIO) {
  return createVaultJsonStore<Doc>({
    fileName: "test-annotations.json",
    empty: () => ({ version: 1, values: {} }),
    parse: (raw) => {
      if (!raw) return { version: 1, values: {} };
      try {
        const parsed = JSON.parse(raw) as Doc;
        return parsed && typeof parsed.values === "object"
          ? { version: 1, values: parsed.values }
          : { version: 1, values: {} };
      } catch {
        return { version: 1, values: {} };
      }
    },
    serialize: (data) => JSON.stringify(data),
    io,
    debounceMs: 20,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("vault JSON 存储", () => {
  it("文件不存在时返回空库;路径落在 .bnote 下", async () => {
    const io = makeIO();
    const store = makeStore(io);
    await expect(store.load("/vault")).resolves.toEqual({ version: 1, values: {} });
    expect(vaultDotPath("/vault/", "x.json")).toBe("/vault/.bnote/x.json");
  });

  it("改数据后排程写盘,flush 立即写出", async () => {
    vi.useFakeTimers();
    const io = makeIO({ "/vault/.bnote/test-annotations.json": '{"version":1,"values":{"a":"1"}}' });
    const store = makeStore(io);
    await store.load("/vault");
    store.update("/vault", (d) => ({ ...d, values: { ...d.values, b: "2" } }));
    await vi.advanceTimersByTimeAsync(30);
    expect(io.writes).toEqual(["/vault/.bnote/test-annotations.json"]);
    expect(JSON.parse(io.files.get("/vault/.bnote/test-annotations.json")!)).toEqual({
      version: 1,
      values: { a: "1", b: "2" },
    });
    store.update("/vault", (d) => ({ ...d, values: {} }));
    store.flush();
    expect(io.writes).toHaveLength(2);
  });

  it("加载期间换了仓库,旧仓库的结果不落进当前缓存", async () => {
    const io = makeIO({
      "/a/.bnote/test-annotations.json": '{"version":1,"values":{"vault":"a"}}',
      "/b/.bnote/test-annotations.json": '{"version":1,"values":{"vault":"b"}}',
    });
    const store = makeStore(io);
    const a = store.load("/a");
    const b = store.load("/b");
    await Promise.all([a, b]);
    expect(store.peek("/a")).toBeNull();
    expect(store.peek("/b")?.values.vault).toBe("b");
  });

  it("update 在文件尚未加载时先读盘再改,不会丢已有条目", async () => {
    const io = makeIO({ "/vault/.bnote/test-annotations.json": '{"version":1,"values":{"keep":"yes"}}' });
    const store = makeStore(io);
    store.update("/vault", (d) => ({ ...d, values: { ...d.values, add: "x" } }));
    await new Promise((r) => setTimeout(r, 60));
    expect(store.peek("/vault")?.values).toEqual({ keep: "yes", add: "x" });
  });
});

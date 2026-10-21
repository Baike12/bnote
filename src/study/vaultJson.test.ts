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

const emptyDoc = (): Doc => ({ version: 1, values: {} });

function makeStore(io: FakeIO) {
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
    io,
    debounceMs: 20,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("vault JSON 按文件存储", () => {
  it("文件不存在时返回空数据;路径落在 .bnote 下", async () => {
    const io = makeIO();
    const store = makeStore(io);
    await expect(store.load("/vault", "pdf-annotations/a.pdf")).resolves.toEqual(emptyDoc());
    expect(vaultDotPath("/vault/", "x.json")).toBe("/vault/.bnote/x.json");
  });

  it("一份文件一个缓存:改 A 不碰 B,flush 各写各的", async () => {
    const io = makeIO({
      "/vault/.bnote/a.json": '{"version":1,"values":{"a":"1"}}',
      "/vault/.bnote/b.json": '{"version":1,"values":{"b":"1"}}',
    });
    const store = makeStore(io);
    await Promise.all([store.load("/vault", "a"), store.load("/vault", "b")]);
    store.update("/vault", "a", (d) => ({ ...d, values: { ...d.values, a2: "2" } }));
    store.update("/vault", "b", (d) => ({ ...d, values: { ...d.values, b2: "2" } }));
    store.flush();
    expect(io.writes.sort()).toEqual(["/vault/.bnote/a.json", "/vault/.bnote/b.json"]);
    expect(JSON.parse(io.files.get("/vault/.bnote/a.json")!).values).toEqual({ a: "1", a2: "2" });
    expect(JSON.parse(io.files.get("/vault/.bnote/b.json")!).values).toEqual({ b: "1", b2: "2" });
  });

  it("写盘防抖,flush 立即写出", async () => {
    vi.useFakeTimers();
    const io = makeIO({ "/vault/.bnote/a.json": '{"version":1,"values":{"a":"1"}}' });
    const store = makeStore(io);
    await store.load("/vault", "a");
    store.update("/vault", "a", (d) => ({ ...d, values: { ...d.values, b: "2" } }));
    expect(io.writes).toEqual([]);
    store.flush();
    expect(io.writes).toEqual(["/vault/.bnote/a.json"]);
    expect(JSON.parse(io.files.get("/vault/.bnote/a.json")!).values).toEqual({ a: "1", b: "2" });
  });

  it("update 在文件尚未加载时先读盘再改,不会丢已有条目", async () => {
    const io = makeIO({ "/vault/.bnote/a.json": '{"version":1,"values":{"keep":"yes"}}' });
    const store = makeStore(io);
    store.update("/vault", "a", (d) => ({ ...d, values: { ...d.values, add: "x" } }));
    await new Promise((r) => setTimeout(r, 60));
    expect(store.peek("/vault", "a")?.values).toEqual({ keep: "yes", add: "x" });
  });

  it("读盘在途时排队的修改在结果落地后应用", async () => {
    let release: (raw: string) => void = () => {};
    const files = new Map<string, string>();
    const io: FakeIO = {
      files,
      writes: [],
      read: () =>
        new Promise<string>((resolve) => {
          release = (raw) => {
            files.set("/vault/.bnote/a.json", raw);
            resolve(raw);
          };
        }),
      write: async (path, text) => {
        io.writes.push(path);
        files.set(path, text);
      },
    };
    const store = makeStore(io);
    const pending = store.load("/vault", "a");
    store.update("/vault", "a", (d) => ({ ...d, values: { ...d.values, add: "x" } }));
    release('{"version":1,"values":{"keep":"yes"}}');
    await pending;
    await new Promise((r) => setTimeout(r, 40));
    expect(store.peek("/vault", "a")?.values).toEqual({ keep: "yes", add: "x" });
  });

  it("不同仓库的同名 key 各自独立", async () => {
    const io = makeIO({
      "/a/.bnote/x.json": '{"version":1,"values":{"vault":"a"}}',
      "/b/.bnote/x.json": '{"version":1,"values":{"vault":"b"}}',
    });
    const store = makeStore(io);
    await Promise.all([store.load("/a", "x"), store.load("/b", "x")]);
    expect(store.peek("/a", "x")?.values.vault).toBe("a");
    expect(store.peek("/b", "x")?.values.vault).toBe("b");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fallback implementations in `pdfjsCompat` only run on an engine that
 * lacks the proposal (macOS 15's WebKit is the target). This file removes the
 * native methods, re-imports the module with a fresh registry, and asserts the
 * installed fallbacks follow the spec — that is the code path the app actually
 * depends on.
 *
 * The natives are restored after every test: other files in the worker share
 * the same realm.
 */

type UpsertProto = {
  getOrInsert?: (key: unknown, value: unknown) => unknown;
  getOrInsertComputed?: (key: unknown, compute: (key: unknown) => unknown) => unknown;
};

type StreamProto = {
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  values?: () => AsyncIterator<unknown>;
};

type ReaderProto = {
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
};

const originals = {
  mapInsert: Object.getOwnPropertyDescriptor(Map.prototype, "getOrInsert"),
  mapInsertComputed: Object.getOwnPropertyDescriptor(Map.prototype, "getOrInsertComputed"),
  weakInsert: Object.getOwnPropertyDescriptor(WeakMap.prototype, "getOrInsert"),
  weakInsertComputed: Object.getOwnPropertyDescriptor(WeakMap.prototype, "getOrInsertComputed"),
  streamIterator: Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator),
  streamValues: Object.getOwnPropertyDescriptor(ReadableStream.prototype, "values"),
  readerIterator: Object.getOwnPropertyDescriptor(
    ReadableStreamDefaultReader.prototype,
    Symbol.asyncIterator,
  ),
};

function restore(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  // An engine without the proposals, exactly like WebKit 18.x.
  Reflect.deleteProperty(Map.prototype, "getOrInsert");
  Reflect.deleteProperty(Map.prototype, "getOrInsertComputed");
  Reflect.deleteProperty(WeakMap.prototype, "getOrInsert");
  Reflect.deleteProperty(WeakMap.prototype, "getOrInsertComputed");
  Reflect.deleteProperty(ReadableStream.prototype, Symbol.asyncIterator);
  Reflect.deleteProperty(ReadableStream.prototype, "values");
  Reflect.deleteProperty(ReadableStreamDefaultReader.prototype, Symbol.asyncIterator);
  vi.resetModules();
});

afterEach(() => {
  restore(Map.prototype, "getOrInsert", originals.mapInsert);
  restore(Map.prototype, "getOrInsertComputed", originals.mapInsertComputed);
  restore(WeakMap.prototype, "getOrInsert", originals.weakInsert);
  restore(WeakMap.prototype, "getOrInsertComputed", originals.weakInsertComputed);
  restore(ReadableStream.prototype, Symbol.asyncIterator, originals.streamIterator);
  restore(ReadableStream.prototype, "values", originals.streamValues);
  restore(ReadableStreamDefaultReader.prototype, Symbol.asyncIterator, originals.readerIterator);
  vi.resetModules();
});

describe("the upsert fallback installed on an engine without it", () => {
  it("adds getOrInsert to Map with the spec's keep-existing behavior", async () => {
    expect(Object.prototype.hasOwnProperty.call(Map.prototype, "getOrInsert")).toBe(false);
    await import("./pdfjsCompat");

    const m = new Map<string, number>();
    const proto = m as unknown as UpsertProto;
    expect(proto.getOrInsert?.("a", 1)).toBe(1);
    expect(proto.getOrInsert?.("a", 2)).toBe(1);
    expect(m.get("a")).toBe(1);
  });

  it("adds getOrInsertComputed and computes only on a miss", async () => {
    await import("./pdfjsCompat");

    const m = new Map<string, string>();
    const proto = m as unknown as UpsertProto;
    const compute = vi.fn((key: unknown) => `v-${String(key)}`);

    expect(proto.getOrInsertComputed?.("k", compute)).toBe("v-k");
    expect(proto.getOrInsertComputed?.("k", compute)).toBe("v-k");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("treats a stored undefined as present (has(), not truthiness)", async () => {
    await import("./pdfjsCompat");

    const m = new Map<string, undefined>();
    m.set("present", undefined);
    const compute = vi.fn(() => "computed");
    expect((m as unknown as UpsertProto).getOrInsertComputed?.("present", compute)).toBeUndefined();
    expect(compute).not.toHaveBeenCalled();
    // getOrInsert also keeps the existing undefined.
    expect((m as unknown as UpsertProto).getOrInsert?.("present", "new")).toBeUndefined();
  });

  it("patches WeakMap too, since pdf.js memoizes page methods on objects", async () => {
    await import("./pdfjsCompat");

    const wm = new WeakMap<object, string>();
    const key = {};
    expect((wm as unknown as UpsertProto).getOrInsert?.(key, "v1")).toBe("v1");
    expect((wm as unknown as UpsertProto).getOrInsert?.(key, "v2")).toBe("v1");
  });

  it("the installed methods are configurable and writable, so a later engine upgrade can replace them", async () => {
    await import("./pdfjsCompat");

    const desc = Object.getOwnPropertyDescriptor(Map.prototype, "getOrInsert");
    expect(desc).toBeDefined();
    expect(desc?.configurable).toBe(true);
    expect(desc?.writable).toBe(true);
  });
});

describe("the stream iterator fallback", () => {
  it("makes a stream async-iterable and yields the chunks in order", async () => {
    await import("./pdfjsCompat");

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.close();
      },
    });

    const chunks: string[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<string>) chunks.push(chunk);
    expect(chunks).toEqual(["a", "b"]);
  });

  it("values() is installed as the same named form", async () => {
    await import("./pdfjsCompat");

    const proto = ReadableStream.prototype as unknown as StreamProto;
    expect(typeof proto.values).toBe("function");

    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.close();
      },
    });
    const iterator = proto.values?.call(stream);
    if (!iterator) throw new Error("values() was not installed");
    const values: unknown[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      values.push(next.value);
    }
    expect(values).toEqual([1]);
  });

  it("a reader is async-iterable and stops at the end of the stream", async () => {
    await import("./pdfjsCompat");

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("only");
        controller.close();
      },
    });
    const reader = stream.getReader() as unknown as ReaderProto & {
      read(): Promise<{ done: boolean; value: unknown }>;
    };

    expect(typeof reader[Symbol.asyncIterator]).toBe("function");
    const iterator = reader[Symbol.asyncIterator]?.();
    expect(await iterator?.next()).toEqual({ done: false, value: "only" });
    expect(await iterator?.next()).toEqual({ done: true, value: undefined });
  });

  it("break in a for-await cancels the underlying read and releases the lock", async () => {
    await import("./pdfjsCompat");

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
      },
    });
    const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const releaseLock = vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock");

    const seen: unknown[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
      seen.push(chunk);
      break;
    }

    expect(seen).toEqual(["a"]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    cancel.mockRestore();
    releaseLock.mockRestore();
  });

  it("a stream error propagates as a rejected iteration", async () => {
    await import("./pdfjsCompat");

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.error(new Error("boom"));
      },
    });

    await expect(async () => {
      for await (const _chunk of stream as unknown as AsyncIterable<unknown>) {
        // No chunk can arrive.
      }
    }).rejects.toThrow("boom");
  });

  it("install is idempotent: a second import keeps the same function identity", async () => {
    await import("./pdfjsCompat");
    const first = ReadableStream.prototype[Symbol.asyncIterator];
    vi.resetModules();
    await import("./pdfjsCompat");

    expect(ReadableStream.prototype[Symbol.asyncIterator]).toBe(first);
  });
});

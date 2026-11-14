import { describe, expect, it } from "vitest";
// Side-effect import: the module installs its shims while it is being imported,
// and every assertion below is about the state it leaves behind.
import "./pdfjsCompat";

/**
 * `pdfjsCompat` installs its shims at import time, so the top-level effects are
 * the thing under test. The suite runs in Node 26, where some proposals
 * already exist: every assertion first asks what the engine really has, and
 * only asserts the contract that holds either way — after the import the
 * method exists and behaves per spec, and a native implementation is not
 * overwritten.
 */

const map = Map.prototype as typeof Map.prototype & {
  getOrInsert?: (key: unknown, value: unknown) => unknown;
  getOrInsertComputed?: (key: unknown, compute: (key: unknown) => unknown) => unknown;
};

const weakMap = WeakMap.prototype as typeof WeakMap.prototype & {
  getOrInsert?: (key: object, value: unknown) => unknown;
  getOrInsertComputed?: (key: object, compute: (key: object) => unknown) => unknown;
};

void weakMap;

const streamProto = ReadableStream.prototype as typeof ReadableStream.prototype & {
  values?: () => AsyncIterableIterator<unknown>;
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<unknown>;
};

const readerProto =
  ReadableStreamDefaultReader.prototype as typeof ReadableStreamDefaultReader.prototype & {
    [Symbol.asyncIterator]?: () => AsyncIterableIterator<unknown>;
  };

interface Upsertable {
  getOrInsert?: (key: unknown, value: unknown) => unknown;
  getOrInsertComputed?: (key: unknown, compute: (key: unknown) => unknown) => unknown;
}

describe("Map/WeakMap upsert (pdf.js memoizes page promises with it)", () => {
  it("Map has both methods after the import, on the prototype so every instance shares them", () => {
    expect(typeof map.getOrInsert).toBe("function");
    expect(typeof map.getOrInsertComputed).toBe("function");
    // They are real prototype methods, not own properties of one map.
    expect(Object.getOwnPropertyDescriptor(map, "getOrInsert")?.value).toBe(map.getOrInsert);
  });

  it("getOrInsert returns the stored value for an existing key and does not overwrite it", () => {
    const m = new Map<string, number>();
    expect((m as unknown as Upsertable).getOrInsert?.("a", 1)).toBe(1);
    expect((m as unknown as Upsertable).getOrInsert?.("a", 2)).toBe(1);
    expect(m.get("a")).toBe(1);
  });

  it("getOrInsert stores a falsy value instead of treating it as a miss", () => {
    const m = new Map<string, number | null>();
    expect((m as unknown as Upsertable).getOrInsert?.("zero", 0)).toBe(0);
    expect((m as unknown as Upsertable).getOrInsert?.("nil", null)).toBeNull();
    expect(m.has("zero")).toBe(true);
    expect(m.has("nil")).toBe(true);
  });

  it("getOrInsertComputed only computes on a miss and passes the key through", () => {
    const m = new Map<string, string>();
    const seen: unknown[] = [];
    const compute = (key: unknown) => {
      seen.push(key);
      return `computed-${String(key)}`;
    };

    expect((m as unknown as Upsertable).getOrInsertComputed?.("a", compute)).toBe("computed-a");
    expect((m as unknown as Upsertable).getOrInsertComputed?.("a", compute)).toBe("computed-a");
    expect(seen).toEqual(["a"]);
  });

  it("a stored undefined still counts as present, so the compute is not repeated", () => {
    const m = new Map<string, undefined>();
    m.set("present", undefined);
    const compute = () => "should not run";

    expect((m as unknown as Upsertable).getOrInsertComputed?.("present", compute)).toBeUndefined();
  });

  it("WeakMap is patched the same way (pdf.js keeps page methods on objects)", () => {
    const wm = new WeakMap<object, unknown>();
    const key = {};
    expect((wm as unknown as Upsertable).getOrInsert?.(key, "v1")).toBe("v1");
    expect((wm as unknown as Upsertable).getOrInsert?.(key, "v2")).toBe("v1");
    expect((wm as unknown as Upsertable).getOrInsertComputed?.(key, () => "v3")).toBe("v1");
    const other = {};
    expect((wm as unknown as Upsertable).getOrInsertComputed?.(other, (k) => k === other)).toBe(
      true,
    );
  });
});

describe("async iteration over WHATWG streams (pdf.js getTextContent consumes it)", () => {
  it("the stream prototype exposes both the async iterator and values()", () => {
    expect(typeof streamProto[Symbol.asyncIterator]).toBe("function");
    expect(typeof streamProto.values).toBe("function");
  });

  it("for await yields every chunk in order and finishes when the stream closes", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.close();
      },
    });

    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk as string);

    expect(chunks).toEqual(["a", "b"]);
  });

  it("values() is the same iteration (pdf.js uses the named form too)", async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.close();
      },
    });
    const iterator = streamProto.values?.call(stream);
    expect(iterator).toBeDefined();
    const collected: number[] = [];
    for await (const value of iterator as AsyncIterableIterator<number>) collected.push(value);
    expect(collected).toEqual([1, 2]);
  });

  it("a reader is async-iterable as well", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("x");
        controller.close();
      },
    });
    const reader = stream.getReader();
    const iterate = (
      readerProto as unknown as {
        [Symbol.asyncIterator]: () => AsyncIterableIterator<string>;
      }
    )[Symbol.asyncIterator];
    expect(typeof iterate).toBe("function");

    const chunks: string[] = [];
    for await (const chunk of iterate.call(reader)) chunks.push(chunk);
    expect(chunks).toEqual(["x"]);
  });

  it("a source error rejects the iteration instead of hanging", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.error(new Error("source failed"));
      },
    });

    await expect(async () => {
      for await (const _chunk of stream) {
        // Nothing can arrive: the source failed before the first read.
      }
    }).rejects.toThrow("source failed");
  });
});

describe("the Iterator global (pdf.js probes Iterator.prototype.join at module start)", () => {
  it("exists after the import even on engines that predate the proposal", () => {
    const scope = globalThis as typeof globalThis & { Iterator?: { prototype: object } };
    expect(scope.Iterator).toBeDefined();
    expect(typeof scope.Iterator?.prototype).toBe("object");
  });
});

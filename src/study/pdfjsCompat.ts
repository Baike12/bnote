/**
 * WebKit compatibility shims for pdf.js 6. macOS 15's WKWebView (Safari 18.x)
 * predates two proposals pdf.js already relies on:
 *
 * - Iterator Helpers: pdf.js probes `Iterator.prototype.join` while its module
 *   and worker start. Missing Iterator throws `ReferenceError`, the lazy PDF
 *   chunk rejects, and React unmounts the whole window (blank app, looks
 *   frozen). pdf.js uses nothing else from Iterator.
 * - Map/WeakMap upsert: `getOrInsertComputed` is used to memoize page method
 *   promises; without it the canvas still draws but the text/selection layer
 *   throws.
 * - ReadableStream async iteration: `getTextContent` consumes
 *   `streamTextContent()` with `for await`, so text selection breaks when the
 *   stream has no `[Symbol.asyncIterator]`.
 *
 * Import this *before* pdfjs-dist, in both the window and the worker.
 * public/pdfjs-boot.js carries the same shims for the production window (it
 * runs before the module graph, independent of chunk ordering).
 */
type UpsertProto = {
  has(key: unknown): boolean;
  get(key: unknown): unknown;
  set(key: unknown, value: unknown): unknown;
  getOrInsert?: unknown;
  getOrInsertComputed?: unknown;
};

function installUpsert(proto: object): void {
  const p = proto as UpsertProto;
  if (typeof p.getOrInsert !== "function") {
    Object.defineProperty(p, "getOrInsert", {
      configurable: true,
      writable: true,
      value: function getOrInsert(this: UpsertProto, key: unknown, value: unknown) {
        const existing = this.get(key);
        if (this.has(key)) return existing;
        this.set(key, value);
        return value;
      },
    });
  }
  if (typeof p.getOrInsertComputed !== "function") {
    Object.defineProperty(p, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value: function getOrInsertComputed(
        this: UpsertProto,
        key: unknown,
        compute: (key: unknown) => unknown,
      ) {
        const existing = this.get(key);
        if (this.has(key)) return existing;
        const value = compute(key);
        this.set(key, value);
        return value;
      },
    });
  }
}

type ReadResult = { done: boolean; value: unknown };

type ReaderLike = {
  read(): Promise<ReadResult>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<unknown>;
};

type StreamLike = {
  getReader(): ReaderLike;
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<unknown>;
  values?: () => AsyncIterableIterator<unknown>;
};

/** Async iteration over WHATWG streams (`for await (const x of stream)`) is a
 *  newer proposal than the streams themselves; pdf.js's getTextContent uses
 *  it, and WebKit 18.3 lacks it. */
function readerIterator(this: ReaderLike): AsyncIterableIterator<unknown> {
  const iterator: AsyncIterableIterator<unknown> = {
    next: () =>
      this.read().then(({ done, value }) =>
        done ? { done: true, value: undefined } : { done: false, value },
      ),
    return: () =>
      this.cancel()
        .catch(() => {})
        .then(() => {
          this.releaseLock();
          return { done: true, value: undefined };
        }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

function streamIterator(this: StreamLike): AsyncIterableIterator<unknown> {
  return readerIterator.call(this.getReader());
}

function installStreamIterators(): void {
  if (typeof Symbol.asyncIterator === "undefined") return;
  const g = globalThis as {
    ReadableStream?: { prototype: StreamLike };
    ReadableStreamDefaultReader?: { prototype: ReaderLike };
  };
  const streamProto = g.ReadableStream?.prototype;
  const readerProto = g.ReadableStreamDefaultReader?.prototype;
  if (streamProto && typeof streamProto[Symbol.asyncIterator] !== "function") {
    Object.defineProperty(streamProto, Symbol.asyncIterator, {
      configurable: true,
      writable: true,
      value: streamIterator,
    });
  }
  if (streamProto && typeof streamProto.values !== "function") {
    Object.defineProperty(streamProto, "values", {
      configurable: true,
      writable: true,
      value: streamIterator,
    });
  }
  if (readerProto && typeof readerProto[Symbol.asyncIterator] !== "function") {
    Object.defineProperty(readerProto, Symbol.asyncIterator, {
      configurable: true,
      writable: true,
      value: readerIterator,
    });
  }
}

const scope = globalThis as typeof globalThis & {
  Iterator?: { prototype: Record<string, unknown> };
};

if (typeof scope.Iterator === "undefined") {
  scope.Iterator = { prototype: {} };
}

installUpsert(Map.prototype);
installUpsert(WeakMap.prototype);
installStreamIterators();

export {};

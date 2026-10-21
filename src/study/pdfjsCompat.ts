/**
 * WebKit compatibility shims for pdf.js 6. macOS 15's WKWebView (Safari 18.x)
 * predates the proposals pdf.js already relies on:
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
 * - `Math.sumPrecise`: pdf.js 6 compiles embedded Type1/CFF fonts into
 *   OpenType and sizes the resulting tables with it. Every `Font.convert()`
 *   throws on the missing function, and its catch block only calls `warn` —
 *   which lands in the worker's own console — then silently swaps the real
 *   font for a system one. Symptom: a whole paper drawn in Helvetica with
 *   correct line breaks, while the same file is serif in Chrome.
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

/**
 * `Math.sumPrecise(items)` — the TC39 proposal sums an iterable with exact
 * rounding. This is the Shewchuk expansion the spec algorithm is built on,
 * without the overflow bookkeeping: pdf.js only asks for table lengths and
 * glyph widths, so partials never approach 2**1024.
 */
export function sumPrecise(items: Iterable<number>): number {
  const partials: number[] = [];
  let special: "nan" | "infinity" | "-infinity" | null = null;
  let positiveZeroSeen = false;

  for (const value of items) {
    if (typeof value !== "number") throw new TypeError("Value is not a number");
    if (Number.isNaN(value)) {
      special = "nan";
      continue;
    }
    if (value === Infinity) {
      special = special === "-infinity" ? "nan" : "infinity";
      continue;
    }
    if (value === -Infinity) {
      special = special === "infinity" ? "nan" : "-infinity";
      continue;
    }
    if (value === 0) {
      if (!Object.is(value, -0)) positiveZeroSeen = true;
      continue;
    }
    let x = value;
    let used = 0;
    for (let i = 0; i < partials.length; i++) {
      let y = partials[i];
      if (Math.abs(x) < Math.abs(y)) {
        const swap = x;
        x = y;
        y = swap;
      }
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) partials[used++] = lo;
      x = hi;
    }
    partials.length = used;
    partials.push(x);
  }

  if (special === "nan") return NaN;
  if (special === "infinity") return Infinity;
  if (special === "-infinity") return -Infinity;
  if (partials.length === 0) return positiveZeroSeen ? 0 : -0;

  // Fold the expansion back from the largest partial; `lo` is the error of the
  // step that first stops cancelling, i.e. the part below the rounding point.
  let index = partials.length - 1;
  let hi = partials[index--];
  while (index >= 0) {
    const y = partials[index--];
    const sum = hi + y;
    const lo = y - (sum - hi);
    hi = sum;
    if (lo !== 0) break;
  }
  return hi;
}

type MathWithSumPrecise = typeof Math & {
  sumPrecise?: (items: Iterable<number>) => number;
};

/** Installs the fallback only where the engine lacks it. Returns whether it did. */
export function installSumPrecise(): boolean {
  const math = Math as MathWithSumPrecise;
  if (typeof math.sumPrecise === "function") return false;
  Object.defineProperty(Math, "sumPrecise", {
    configurable: true,
    writable: true,
    value: sumPrecise,
  });
  return true;
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
installSumPrecise();

export {};

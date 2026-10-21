/*
 * WebKit compatibility shims for pdf.js 6. macOS 15's WKWebView (Safari 18.x)
 * has neither Iterator Helpers, the Map/WeakMap upsert proposal nor async
 * iteration over WHATWG streams, all of which pdf.js reads during startup or
 * while building the text layer:
 *
 *   - no Iterator        -> ReferenceError while the lazy PDF chunk loads,
 *                           React unmounts the whole window (blank app)
 *   - no upsert          -> text layer cannot memoize page methods
 *   - no stream iterator -> getTextContent throws, no text selection
 *
 * This external script runs before the module graph, so the shims exist no
 * matter how the bundler orders the pdf.js chunk. The worker gets the same
 * shims from src/study/pdfjsCompat.ts via src/study/pdfWorker.ts.
 */
(function () {
  if (typeof globalThis.Iterator === "undefined") {
    globalThis.Iterator = { prototype: {} };
  }
  function installUpsert(proto) {
    if (typeof proto.getOrInsert !== "function") {
      Object.defineProperty(proto, "getOrInsert", {
        configurable: true,
        writable: true,
        value: function (key, value) {
          if (this.has(key)) return this.get(key);
          this.set(key, value);
          return value;
        },
      });
    }
    if (typeof proto.getOrInsertComputed !== "function") {
      Object.defineProperty(proto, "getOrInsertComputed", {
        configurable: true,
        writable: true,
        value: function (key, compute) {
          if (this.has(key)) return this.get(key);
          var value = compute(key);
          this.set(key, value);
          return value;
        },
      });
    }
  }
  installUpsert(Map.prototype);
  installUpsert(WeakMap.prototype);

  if (typeof Symbol.asyncIterator !== "undefined") {
    var ReaderProto = globalThis.ReadableStreamDefaultReader &&
      globalThis.ReadableStreamDefaultReader.prototype;
    var StreamProto = globalThis.ReadableStream && globalThis.ReadableStream.prototype;
    function readerIterator() {
      return {
        next: () => {
          return this.read().then(function (result) {
            return result.done
              ? { done: true, value: undefined }
              : { done: false, value: result.value };
          });
        },
        return: () => {
          return this.cancel().catch(function () {}).then(() => {
            this.releaseLock();
            return { done: true, value: undefined };
          });
        },
        [Symbol.asyncIterator]: function () {
          return this;
        },
      };
    }
    function streamIterator() {
      return readerIterator.call(this.getReader());
    }
    if (ReaderProto && typeof ReaderProto[Symbol.asyncIterator] !== "function") {
      Object.defineProperty(ReaderProto, Symbol.asyncIterator, {
        configurable: true,
        writable: true,
        value: readerIterator,
      });
    }
    if (StreamProto && typeof StreamProto[Symbol.asyncIterator] !== "function") {
      Object.defineProperty(StreamProto, Symbol.asyncIterator, {
        configurable: true,
        writable: true,
        value: streamIterator,
      });
    }
    if (StreamProto && typeof StreamProto.values !== "function") {
      Object.defineProperty(StreamProto, "values", {
        configurable: true,
        writable: true,
        value: streamIterator,
      });
    }
  }
})();

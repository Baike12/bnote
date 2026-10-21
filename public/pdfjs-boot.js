/*
 * WebKit compatibility shims for pdf.js 6. macOS 15's WKWebView (Safari 18.x)
 * has neither Iterator Helpers, the Map/WeakMap upsert proposal, async
 * iteration over WHATWG streams nor Math.sumPrecise, all of which pdf.js uses
 * during startup, while building the text layer or while compiling the fonts
 * it embeds:
 *
 *   - no Iterator        -> ReferenceError while the lazy PDF chunk loads,
 *                           React unmounts the whole window (blank app)
 *   - no upsert          -> text layer cannot memoize page methods
 *   - no stream iterator -> getTextContent throws, no text selection
 *   - no Math.sumPrecise -> every embedded font fails to compile and pdf.js
 *                           silently falls back to system fonts
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

  // pdf.js sizes the OpenType tables it builds for embedded fonts with
  // Math.sumPrecise; without it every font conversion throws and pdf.js
  // silently substitutes a system font (whole documents render in Helvetica).
  if (typeof Math.sumPrecise !== "function") {
    Object.defineProperty(Math, "sumPrecise", {
      configurable: true,
      writable: true,
      value: function sumPrecise(items) {
        var partials = [];
        for (var value of items) {
          if (typeof value !== "number") throw new TypeError("Value is not a number");
          if (value !== value) return NaN;
          if (value === Infinity || value === -Infinity) return value;
          if (value === 0) continue;
          var x = value;
          var used = 0;
          for (var i = 0; i < partials.length; i++) {
            var y = partials[i];
            if (Math.abs(x) < Math.abs(y)) {
              var swap = x;
              x = y;
              y = swap;
            }
            var hi = x + y;
            var lo = y - (hi - x);
            if (lo !== 0) partials[used++] = lo;
            x = hi;
          }
          partials.length = used;
          partials.push(x);
        }
        var index = partials.length - 1;
        if (index < 0) return 0;
        var result = partials[index--];
        while (index >= 0) {
          var next = partials[index--];
          var sum = result + next;
          var error = next - (sum - result);
          result = sum;
          if (error !== 0) break;
        }
        return result;
      },
    });
  }

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

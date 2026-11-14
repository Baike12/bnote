import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { ancestorDirs, buildTree, naturalCompare, searchFilesByName, visibleRows } from "./tree";
import { detectIndent } from "./store";
import { alignHunk, parseUnifiedDiff } from "./diff";
import { planGoto, type GotoTarget } from "./editor/gotoPlan";
import { cmToLspPosition, lspRangeToCm, lspToCmOffset } from "./editor/positions";
import { decodeFileUri, encodeFileUri } from "./editor/uri";
import type { CodeEntry, LspPosition } from "./types";

/**
 * The performance gate of the code module.
 *
 * The budgets are calibrated at ~6-10x the measured median on this machine:
 * an order-of-magnitude regression (an accidental full-text scan, a degraded
 * sort) is caught from 10x on, while the jitter of the machine does not
 * produce a false positive.
 *
 * What is measured is pure logic (no DOM): the decision points on the way of
 * **opening a project** and of **every keystroke** — folding the file tree
 * once, parsing the diff once, guessing the indent once. The DOM updates of
 * the view layer are verified in the browser instead and are not simulated
 * here.
 */

/** The size of a decent repository: a few levels of directories, thousands of files. */
function repoEntries(files: number): CodeEntry[] {
  const out: CodeEntry[] = [];
  for (let i = 0; i < files; i++) {
    const dir = `src/pkg${i % 40}/mod${i % 7}`;
    out.push({
      path: `${dir}/file${i}.ts`,
      name: `file${i}.ts`,
      isDir: false,
      size: 1024,
    });
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Median of a measurement closure over `times` runs (same protocol as the editor gate: warmup is the caller's job, the median of the samples is the number). */
function medianOfRun(run: () => number, times: number): number {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) samples.push(run());
  samples.sort((a, b) => a - b);
  return samples[Math.floor(times / 2)];
}

/** Count every directory level that appears in the entries as "expanded" (the largest possible flattening). */
function allDirPaths(entries: readonly CodeEntry[]): Set<string> {
  const dirs = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return dirs;
}

describe("code module order-of-magnitude gate", () => {
  it("folding the project tree of 2000 files < 10ms", () => {
    const entries = repoEntries(2000);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      buildTree(entries);
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    expect(med, `折树中位数 ${med.toFixed(1)}ms`).toBeLessThan(10);
  });

  it("20000 natural comparisons < 45ms", () => {
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      for (let k = 0; k < 20000; k++) {
        naturalCompare(`file${k}.ts`, `file${k + 1}.ts`);
      }
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    expect(med, `比较中位数 ${med.toFixed(1)}ms`).toBeLessThan(45);
  });

  it("parsing a 2000-line diff < 2.5ms", () => {
    const hunk = Array.from({ length: 2000 }, (_, i) => ` line ${i}`).join("\n");
    const text = `--- a/x\n+++ b/x\n@@ -1,2000 +1,2000 @@\n${hunk}\n`;
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      parseUnifiedDiff(text);
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    expect(med, `diff 解析中位数 ${med.toFixed(1)}ms`).toBeLessThan(2.5);
  });

  it("side-by-side alignment of a 2000-line hunk < 1ms", () => {
    const hunk = {
      oldStart: 1,
      oldLines: 2000,
      newStart: 1,
      newLines: 2000,
      section: "",
      lines: Array.from({ length: 2000 }, (_, i) => ({
        type: "context" as const,
        text: ` line ${i}`,
        oldLine: i + 1,
        newLine: i + 1,
      })),
    };
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      alignHunk(hunk);
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    expect(med, `对齐中位数 ${med.toFixed(1)}ms`).toBeLessThan(1);
  });

  it("detecting the indent < 2.5ms (once per file, it must not grow linearly with the file length)", () => {
    const big = Array.from({ length: 20000 }, (_, i) => `    line ${i}`).join("\n");
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      detectIndent(big);
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    expect(med, `猜缩进中位数 ${med.toFixed(1)}ms`).toBeLessThan(2.5);
  });

  it("flattening the file tree (20000 files) < 6ms (virtual scrolling flattens it on every scroll)", () => {
    const entries = repoEntries(20000);
    const roots = buildTree(entries);
    const expanded = allDirPaths(entries);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      visibleRows(roots, expanded);
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    console.warn(`[perf] flatten file tree median ${med.toFixed(2)}ms`);
    expect(med, `拍平文件树中位数 ${med.toFixed(2)}ms`).toBeLessThan(6);
  });

  it("quick open: filtering 20000 files < 8ms (once per keystroke, it must not rescan the repository over IPC)", () => {
    const entries = repoEntries(20000);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      searchFilesByName(entries, "file199");
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    console.warn(`[perf] quick-open filtering median ${med.toFixed(2)}ms`);
    expect(med, `快速打开过滤中位数 ${med.toFixed(2)}ms`).toBeLessThan(8);
  });
});

// ---- opening a file: tree → editor ----
// Opening a file runs a fixed chain in the frontend: the tree is folded from
// the scanned entries (memoized on the entry array), flattened into the visible
// rows for virtual scrolling, the target row is revealed by expanding its
// ancestor chain, and only then the buffer is read over IPC. What this gate
// measures is that entire frontend leg except the IPC read itself (disk-bound,
// verified end-to-end, not a CPU cost) — all of it pure logic. The remaining
// buffer-side step after the read, `detectIndent`, is already locked by the
// "detecting the indent" gate above, so the whole open path is covered.
//
// Sub-millisecond operations are timed as a fixed batch and the batch total is
// budgeted, the same shape as the existing "20000 natural comparisons" gate: a
// single sub-microsecond call is below timer resolution, and a batch total is
// what a budget can honestly describe. Every budget below is the measured
// median × 6–10 on this machine.

describe("code perf gate: opening a file from the tree", () => {
  /** A repository of a few thousand files in nested directories (the size the tree has to stay fast at). */
  function repoDirs(dirs: number, filesPerDir: number): CodeEntry[] {
    const out: CodeEntry[] = [];
    for (let d = 0; d < dirs; d++) {
      const dir = `src/feature${d}/internal`;
      out.push({ path: dir, name: "internal", isDir: true, size: 0 });
      for (let f = 0; f < filesPerDir; f++) {
        out.push({ path: `${dir}/module${f}.ts`, name: `module${f}.ts`, isDir: false, size: 1024 });
      }
    }
    return out;
  }

  const entries = repoDirs(120, 25); // 3,000 files; allDirPaths yields 241 directories (src + 2 levels)
  const allDirs = allDirPaths(entries);
  const roots = buildTree(entries);

  it("opening a file (fold + flatten + row lookup) median < 12 ms", () => {
    // One click in the file tree: `entries` arrives from the store, FileTree
    // memoizes buildTree/visibleRows on it, and the reveal effect looks the
    // path up in the flattened rows. The fold and the flatten both run over
    // the whole repository, so this is the per-open upper bound.
    const paths = ["src/feature7/internal/module3.ts", "src/feature77/internal/module13.ts"];
    const median = medianOfRun(() => {
      const t0 = performance.now();
      const folded = buildTree(entries);
      const rows = visibleRows(folded, allDirs);
      const index = new Map<string, number>();
      rows.forEach((row, i) => index.set(row.node.path, i));
      if (!index.has(paths[0]) || !index.has(paths[1]))
        throw new Error("a target row is not on the tree");
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] file open (fold+flatten+lookup) median ${median.toFixed(2)}ms`);
    // Silent ~1.1ms (3,000 files folded + flattened); 12ms is the ~10x band
    // (the 15-sample median absorbs the GC spikes a larger single sample sees).
    expect(median).toBeLessThan(12);
  });

  it("2000 re-opens of an already-open file (tab switch, no disk read, no refold) total < 4 ms", () => {
    // The second click on a file that is already in `files`: the store only
    // touches tabs/activePath, and the tree rows are memoized. The whole cost
    // is the tabs membership test plus the row lookup.
    const tabs = Array.from({ length: 40 }, (_, i) => `src/feature${i}/internal/module0.ts`);
    const rows = visibleRows(roots, allDirs);
    const index = new Map<string, number>();
    rows.forEach((row, i) => index.set(row.node.path, i));
    const target = "src/feature7/internal/module0.ts";
    const median = medianOfRun(() => {
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) {
        const nextTabs = tabs.includes(target) ? tabs : [...tabs, target];
        if (!nextTabs.includes(target) || !index.has(target))
          throw new Error("tab switch lost its target");
      }
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] 2000 tab switches total ${median.toFixed(4)}ms`);
    // Silent ~0.45ms per 2000 (~0.0002ms each); 4ms is the ~9x band.
    expect(median).toBeLessThan(4);
  });

  it("2000 reveals of a deep file (expandTo with every directory already expanded) total < 20 ms", () => {
    // `expandTo` runs ancestorDirs(path) and unions the chain into a copy of the
    // expanded set (single writer: a new Set, never a mutation). The cost is the
    // path depth plus the current expansion size — this runs the worst case:
    // all 241 directories of the repository already expanded.
    const target = "src/feature119/internal/module24.ts";
    const median = medianOfRun(() => {
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) {
        const chain = ancestorDirs(target);
        const next = new Set(allDirs);
        for (const dir of chain) next.add(dir);
        if (chain.length !== 3) throw new Error("the ancestor chain lost a level");
      }
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] 2000 expand-to total ${median.toFixed(4)}ms`);
    // Silent ~2.6ms per 2000 (a 241-entry Set copy per reveal, the worst case);
    // 20ms is the ~8x band.
    expect(median).toBeLessThan(20);
  });
});

// ---- go to definition: plan + position mapping on a large file ----
// A jump is: the server answers with locations → planGoto picks one → the
// editor converts the LSP position into a document offset and dispatches a
// selection. The IPC round trip and the server are not a CPU cost; the
// frontend leg is the plan plus the conversion, both pure. Measured on a
// 20,000-line file, where a line lookup that degraded to a linear scan shows
// up immediately.

describe("code perf gate: goto plan and position mapping (20,000-line file)", () => {
  const LINES = Array.from(
    { length: 20000 },
    (_, i) => `  const value${i} = compute(${i}, "name_${i}"); // 第 ${i} 行`,
  );
  const doc = Text.of(LINES);
  const midLine = Math.floor(LINES.length / 2);

  /** The locations a language server really returns: a typeshed stub first, then the source. */
  const targets: GotoTarget[] = [
    { path: "/Users/me/.cache/ty/vendored/typeshed/stdlib/builtins.pyi", external: true },
    { path: "src/core/model.py", external: false },
    { path: "src/core/model.py", external: false },
  ];

  it("100000 goto plans (server answer → jump/none) total < 6 ms", () => {
    const median = medianOfRun(() => {
      const t0 = performance.now();
      for (let i = 0; i < 100000; i++) {
        if (planGoto(targets).kind !== "jump") throw new Error("the plan found nothing to jump to");
      }
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] 100000 planGoto total ${median.toFixed(3)}ms`);
    // Silent ~0.74ms per 100000 (~0.000007ms each: one scan over three
    // locations); 6ms is the ~8x band.
    expect(median).toBeLessThan(6);
  });

  it("10000 jump landings (LSP position ↔ document offset, 20,000 lines) total < 16 ms", () => {
    const position: LspPosition = { line: midLine, character: 12 };
    const median = medianOfRun(() => {
      const t0 = performance.now();
      for (let i = 0; i < 10000; i++) {
        const offset = lspToCmOffset(doc, position);
        if (cmToLspPosition(doc, offset).line !== midLine) throw new Error("the position moved");
      }
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] 10000 position round trips total ${median.toFixed(3)}ms`);
    // Silent ~2.0ms per 10000 (~0.0002ms each, two binary line lookups); 16ms
    // is the ~8x band.
    expect(median).toBeLessThan(16);
  });

  it("10000 range landings (LSP range → from/to) total < 14 ms", () => {
    const range = {
      start: { line: midLine, character: 8 },
      end: { line: midLine, character: 8 + "const value".length },
    };
    const median = medianOfRun(() => {
      const t0 = performance.now();
      for (let i = 0; i < 10000; i++) {
        const { from, to } = lspRangeToCm(doc, range);
        if (to <= from) throw new Error("the range collapsed");
      }
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] 10000 range landings total ${median.toFixed(3)}ms`);
    // Silent ~1.7ms per 10000 (~0.00017ms each: two line lookups per range);
    // 14ms is the ~8x band.
    expect(median).toBeLessThan(14);
  });

  it("a batch of 500 diagnostic ranges maps into the document (the publish-diagnostics leg) median < 1 ms", () => {
    // Every publishDiagnostics rebuilds the whole list and each entry converts
    // its range; a conversion that scanned the document per entry is caught here.
    const ranges = Array.from({ length: 500 }, (_, i) => ({
      start: { line: (i * 37) % LINES.length, character: 4 },
      end: { line: (i * 37) % LINES.length, character: 12 },
    }));
    const median = medianOfRun(() => {
      const t0 = performance.now();
      let acc = 0;
      for (const r of ranges) acc += lspRangeToCm(doc, r).to;
      if (acc <= 0) throw new Error("no diagnostic mapped");
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] 500 diagnostic ranges median ${median.toFixed(3)}ms`);
    // Silent ~0.11ms; 1ms is the ~9x band.
    expect(median).toBeLessThan(1);
  });

  it("1000 external target round trips (file:// URI encode → decode, the read-only-open leg) total < 11 ms", () => {
    // A jump can land outside the project; `toTarget` decodes the server's
    // file:// URI for every location, and encodeFileUri is its inverse. The path
    // is the long vendored-type-stub shape, the worst realistic case.
    const path = "/Users/me/.cache/ty/vendored/typeshed/stdlib/site-packages/torch/_C/_nn.pyi";
    const median = medianOfRun(() => {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) {
        if (decodeFileUri(encodeFileUri(path)) !== path)
          throw new Error("the URI round trip lost the path");
      }
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] 1000 URI round trips total ${median.toFixed(3)}ms`);
    // Silent ~1.3ms per 1000 (~0.0013ms each; the TextEncoder/TextDecoder pair
    // dominates); 11ms is the ~8x band.
    expect(median).toBeLessThan(11);
  });
});

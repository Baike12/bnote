import { describe, expect, it } from "vitest";
import { buildTree, naturalCompare, searchFilesByName, visibleRows } from "./tree";
import { detectIndent } from "./store";
import { alignHunk, parseUnifiedDiff } from "./diff";
import type { CodeEntry } from "./types";

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

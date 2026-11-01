import { describe, expect, it } from "vitest";
import { buildTree, naturalCompare, searchFilesByName, visibleRows } from "./tree";
import { detectIndent } from "./store";
import { alignHunk, parseUnifiedDiff } from "./diff";
import type { CodeEntry } from "./types";

/**
 * 代码模块的性能门禁。
 *
 * 预算按本机实测中位数放大 ~6–10 倍标定:量级回归(意外的全文扫描、排序
 * 退化)从 10 倍起必被拦下,而机器抖动不会误报。
 *
 * 测的是纯逻辑(无 DOM):这些是**打开项目**与**每次按键**路上的决定项——
 * 文件树折一次、diff 解析一次、缩进猜一次。视图层的 DOM 更新另有浏览器
 * 验证,不在这里模拟。
 */

/** 一个像样的仓库规模:若干层目录、上千个文件。 */
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

describe("代码模块量级门禁", () => {
  it("折 2000 个文件的项目树 < 10ms", () => {
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

  it("自然序比较 20000 次 < 45ms", () => {
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

  it("解析 2000 行的 diff < 2.5ms", () => {
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

  it("并排对齐 2000 行的 hunk < 1ms", () => {
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

  it("猜缩进 < 2.5ms(每个文件一次,不该随文件长度线性涨)", () => {
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

  it("拍平文件树(2 万个文件) < 6ms(虚拟滚动每次都拍一次)", () => {
    const roots = buildTree(repoEntries(20000));
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      visibleRows(roots, new Set());
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    console.warn(`[perf] 拍平文件树 中位 ${med.toFixed(2)}ms`);
    expect(med, `拍平文件树中位数 ${med.toFixed(2)}ms`).toBeLessThan(6);
  });

  it("快速打开:2 万个文件里过滤 < 8ms(每键一次,不许走 IPC 重扫仓库)", () => {
    const entries = repoEntries(20000);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      searchFilesByName(entries, "file199");
      samples.push(performance.now() - t0);
    }
    const med = median(samples);
    console.warn(`[perf] 快速打开过滤 中位 ${med.toFixed(2)}ms`);
    expect(med, `快速打开过滤中位数 ${med.toFixed(2)}ms`).toBeLessThan(8);
  });
});

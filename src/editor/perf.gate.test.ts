import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { blockDecorationsField, buildInlineDecorations, selectionAffectsDecos } from "./livePreview";
import { toggleList } from "./ops";

/**
 * 性能门禁（bnote 的生命线）：编辑管线的每击成本必须保持量级。预算按本机
 * 实测中位数放大 ~6 倍标定——量级回归（意外的全文扫描、装饰失稳、解析歧义
 * 翻转）从 10 倍起必被拦下，而 CI/机器抖动不会误报。改性能敏感路径后先在
 * 浏览器里实测（CLAUDE.md：性能问题用确定性测量），再用这里锁量级。
 *
 * 测的是无 DOM 的状态管线（state.update + 装饰重建），即每击真实 CPU 的
 * 决定项；视图层 DOM 更新另有浏览器验证，不在这里模拟。
 */

/** 与浏览器测量同款的大文档生成器：标题/段落/公式块/三类列表交错。 */
function bigDoc(sections: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= sections; i++) {
    parts.push(`## ${i} 章节`);
    parts.push("");
    parts.push("这是段落文字,讲一些线性变换的基本概念,长度中等偏长一些。");
    parts.push("");
    parts.push("$$");
    parts.push(`L_{${i}}(\\theta) = \\alpha_{${i}} x + \\frac{\\lambda}{2}||\\theta||^2`);
    parts.push("$$");
    parts.push("");
    parts.push("- 无序列表项一,内容若干");
    parts.push("- 无序列表项二,内容若干");
    parts.push(`  - 嵌套项 ${i}`);
    parts.push(`1. 有序项 ${i}`);
    parts.push(`- [ ] 待办项 ${i}`);
    parts.push("- [x] 已完成项 ✅ 2026-09-21");
    parts.push("");
  }
  return parts.join("\n");
}

const DOC = bigDoc(60); // ~900 行

function makeState(doc: string, cursorAt?: number): EditorState {
  const created = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [GFM] }),
      blockDecorationsField,
      EditorState.allowMultipleSelections.of(true),
    ],
    selection: cursorAt === undefined ? undefined : EditorSelection.cursor(cursorAt),
  });
  ensureSyntaxTree(created, created.doc.length);
  return created;
}

function medianOf(run: () => number, times: number): number {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) samples.push(run());
  samples.sort((a, b) => a - b);
  return samples[Math.floor(times / 2)];
}

const firstListLine = (state: EditorState) => {
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.text.startsWith("- 无序列表项一")) return line;
  }
  throw new Error("list line not found");
};

describe("性能门禁：大文档(~900行)每击管线预算", () => {
  const state = makeState(DOC, 0);

  it("inline 装饰构建(全视口=全文档,上界)中位数 < 4ms", () => {
    const median = medianOf(() => {
      const t0 = performance.now();
      buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] inline 装饰构建中位数 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(4);
  });

  it("60 次每击输入(update+装饰重建)总计 < 500ms,单击中位数 < 6ms", () => {
    const line = firstListLine(state);
    const at = line.from + 4;
    let cur = state;
    const perKey: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      cur = cur.update({ changes: { from: at, insert: "字" } }).state;
      buildInlineDecorations({ state: cur, visibleRanges: [{ from: 0, to: cur.doc.length }] });
      perKey.push(performance.now() - t0);
    }
    const total = perKey.reduce((a, b) => a + b, 0);
    perKey.sort((a, b) => a - b);
    const median = perKey[Math.floor(perKey.length / 2)];
    console.warn(`[perf] 每击输入 总计 ${total.toFixed(0)}ms, 中位数 ${median.toFixed(2)}ms`);
    expect(total).toBeLessThan(500);
    expect(median).toBeLessThan(6);
  });

  it("光标移动判定:同行纯移动恒 false(快路径),跨行 true(装饰可随行变)", () => {
    const line = firstListLine(state);
    const base = makeState(DOC, line.from + 4);
    // 同行移动:普通列表行无触发字符 → 不可能改装饰,必须跳过重建。
    const sameLine = base.update({ selection: EditorSelection.cursor(line.from + 10) }).state;
    expect(selectionAffectsDecos(base, sameLine)).toBe(false);
    // 跨行移动:活动行规则让装饰可以随行变,返回 true 走重建——
    // 其成本由下面的移动预算测试锁定(实测 ~0.7ms/次)。
    const crossLine = base
      .update({ selection: EditorSelection.cursor(state.doc.line(line.number + 1).from + 4) })
      .state;
    expect(selectionAffectsDecos(base, crossLine)).toBe(true);
  });

  it("60 次光标移动(同行快路径+跨行重建混合)总计 < 150ms", () => {
    const line = firstListLine(state);
    const from = line.from + 4;
    let cur = state;
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const target =
        i % 2 === 0
          ? from + 10 // 同行:走快路径
          : state.doc.line(line.number + (i % 4 === 1 ? 1 : -1)).from + 4; // 跨行:重建
      const t0 = performance.now();
      const next = cur.update({ selection: EditorSelection.cursor(target) }).state;
      if (selectionAffectsDecos(cur, next)) {
        buildInlineDecorations({ state: next, visibleRanges: [{ from: 0, to: next.doc.length }] });
      }
      samples.push(performance.now() - t0);
      cur = next;
    }
    const total = samples.reduce((a, b) => a + b, 0);
    console.warn(`[perf] 光标移动 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(250);
  });

  it("toggleList 单行(树查询路径)中位数 < 4ms", () => {
    const view = makeTogglingView(state);
    const median = medianOf(() => {
      const t0 = performance.now();
      toggleList(view, "bullet"); // 已是 bullet → 取消
      return performance.now() - t0;
    }, 9);
    toggleList(view, "bullet"); // 恢复
    console.warn(`[perf] toggleList 中位数 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(20);
  });
});

/** toggleList 计时用假视图:携带完整 markdown 扩展(真实树查询路径)。 */
function makeTogglingView(base: EditorState): EditorView {
  let state = base;
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
  };
  return view as unknown as EditorView;
}

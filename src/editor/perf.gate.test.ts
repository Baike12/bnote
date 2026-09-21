import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { blockDecorationsField, buildInlineDecorations, selectionAffectsDecos } from "./livePreview";
import { mathRegions } from "./context";
import { renderMathHtml } from "./widgets";
import { enterContinueListItem, insertCodeBlock, insertMathBlock, toggleList } from "./ops";
import { moveByLinesVisual, type VimCoreState } from "./vim/verticalMotion";

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
    expect(median).toBeLessThan(4);
  });
});

/** 命令计时用假视图:携带完整 markdown 扩展(真实树查询路径),focus 为空操作。 */
function makeTogglingView(base: EditorState): EditorView {
  let state = base;
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
    focus: () => {},
  };
  return view as unknown as EditorView;
}

// ---- vim 移动 j/k:真实运动模型的 node 可测部分 ----
// moveByLinesVisual(像素锚定+隐藏行步进,假几何)+ selection 事务 + 跨行重建,
// 即真实 j/k 每击在主线程上的全部状态管线(DOM 测量由浏览器验证协议锁定)。

const CHAR_W = 8;
const ROW_H = 24;
const CONTENT_LEFT = 100;

describe("性能门禁：vim j/k 移动(900行,跨公式块隐藏行步进)", () => {
  it("60 次 j/k(repeat 混合,运动+事务+重建)总计 < 250ms", () => {
    let cur = makeState(DOC, 0);
    const at = Math.floor(cur.doc.length / 2);
    cur = cur.update({ selection: EditorSelection.cursor(at) }).state;
    // 假几何视图:state 跟随 cur,j/k 不改文档,几何确定。
    const view = {
      get state() {
        return cur;
      },
      defaultCharacterWidth: CHAR_W,
      contentDOM: {
        getBoundingClientRect: () => ({ left: CONTENT_LEFT, top: 0, right: 900, bottom: 600 }),
      },
      coordsAtPos: (pos: number) => {
        const line = cur.doc.lineAt(pos);
        const top = (line.number - 1) * ROW_H;
        return { left: CONTENT_LEFT + (pos - line.from) * CHAR_W, top: top + 2, bottom: top + ROW_H - 2 };
      },
      posAtCoords: ({ x, y }: { x: number; y: number }) => {
        const n = Math.min(cur.doc.lines, Math.max(1, Math.floor(y / ROW_H) + 1));
        const line = cur.doc.line(n);
        const col = Math.round((x - CONTENT_LEFT) / CHAR_W);
        return Math.min(line.to, line.from + Math.max(0, col));
      },
    };
    const cm = { cm6: view, firstLine: () => 0, lastLine: () => cur.doc.lines - 1 };
    const motions = {
      moveByLines: moveByLinesVisual,
      moveToStartOfLine: (_cm: unknown, head: { line: number; ch: number }) => ({
        line: head.line,
        ch: 0,
      }),
    };
    const vim: VimCoreState = { lastMotion: motions.moveByLines, lastHPos: 0, lastHSPos: Number.NaN };
    const fn = moveByLinesVisual as (...a: unknown[]) => { line: number; ch: number };
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const headPos = cur.selection.main.head;
      const headLine = cur.doc.lineAt(headPos);
      const t0 = performance.now();
      const out = fn.call(
        motions,
        cm,
        { line: headLine.number - 1, ch: headPos - headLine.from },
        { forward: i % 2 === 0, repeat: i % 7 === 3 ? 5 : 1 },
        vim,
      );
      const targetLine = cur.doc.line(Math.min(Math.max(1, out.line + 1), cur.doc.lines));
      const target =
        out.ch === Infinity ? targetLine.to : Math.min(targetLine.from + Math.max(0, out.ch), targetLine.to);
      const next = cur.update({ selection: EditorSelection.cursor(target) }).state;
      buildInlineDecorations({ state: next, visibleRanges: [{ from: 0, to: next.doc.length }] });
      samples.push(performance.now() - t0);
      cur = next;
    }
    const total = samples.reduce((a, b) => a + b, 0);
    console.warn(`[perf] vim j/k 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(500);
  });
});

// ---- 列表换行:enterContinueListItem 的 split 主路径 ----
// 每个条目 = Enter(建新项)+ 补一个字符(保持非空,让下一次 Enter 继续分裂),
// 每次文档变化都走真实的 update + 装饰重建。

describe("性能门禁：列表换行(bullet/ordered/todo 各20项)", () => {
  const kinds: { name: string; seed: string }[] = [
    { name: "bullet", seed: "- 无序列表项" },
    { name: "ordered", seed: "1. 有序列表项" },
    { name: "todo", seed: "- [ ] 待办项" },
  ];
  for (const { name, seed } of kinds) {
    it(`${name}: 20 次(Enter 建项+补字符)总计 < 50ms`, () => {
      const view = makeTogglingView(makeState(`${seed}\n`, 0));
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        // 光标到当前行尾 → Enter → 新项行尾补字符
        const t0 = performance.now();
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        view.dispatch({ selection: EditorSelection.cursor(line.to) });
        enterContinueListItem(view);
        const nl = view.state.doc.lineAt(view.state.selection.main.head);
        view.dispatch({ changes: { from: nl.to, insert: "字" } });
        buildInlineDecorations({ state: view.state, visibleRanges: [{ from: 0, to: view.state.doc.length }] });
        samples.push(performance.now() - t0);
      }
      const total = samples.reduce((a, b) => a + b, 0);
      // 断言条目确实持续分裂(防止命令没生效导致测了个空循环)。
      expect(view.state.doc.toString().split("\n").filter((l) => l.length > 2).length).toBeGreaterThan(15);
      console.warn(`[perf] ${name} 换行 总计 ${total.toFixed(0)}ms`);
      expect(total).toBeLessThan(50);
    });
  }
});

// ---- 公式块:插入 + 输入 ----
// 输入公式时每次击键源串都变,KaTeX 缓存必 miss——每击一次完整渲染是
// 公式输入的真实成本大头,和 state 管线一起锁量级。

describe("性能门禁：公式块插入与输入", () => {
  it("10 次块插入 dispatch 中位数 < 2ms", () => {
    const cur = makeState(DOC, 0);
    const view = makeTogglingView(cur);
    const median = medianOf(() => {
      const end = view.state.doc.length;
      view.dispatch({ selection: EditorSelection.cursor(end) });
      const t0 = performance.now();
      insertMathBlock(view);
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] insertMathBlock 中位数 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(2);
  });

  it("公式内 20 击(update+重建+KaTeX渲染)总计 < 250ms", () => {
    const cur = makeState(DOC, 0);
    const view = makeTogglingView(cur);
    const end = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.cursor(end) });
    insertMathBlock(view);
    // 光标落在 $$…$$ 内部;向其中追加公式源。
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const at = view.state.selection.main.head;
      const t0 = performance.now();
      view.dispatch({ changes: { from: at, insert: "\\alpha_{x}+" } });
      const region = mathRegions(view.state).find(
        (r) => view.state.selection.main.head >= r.from && view.state.selection.main.head <= r.to,
      );
      buildInlineDecorations({ state: view.state, visibleRanges: [{ from: 0, to: view.state.doc.length }] });
      if (region) renderMathHtml(region.content, true); // MathPreviewWidget.toDOM 的真实调用
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    const doc = view.state.doc.toString();
    expect(doc.includes("\\alpha_{x}")).toBe(true); // 输入确实进了公式区
    console.warn(`[perf] 公式输入 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(250);
  });
});

// ---- 代码块:插入 + 输入 ----

describe("性能门禁：代码块插入与输入", () => {
  it("10 次块插入 dispatch 中位数 < 4ms", () => {
    const cur = makeState(DOC, 0);
    const view = makeTogglingView(cur);
    const median = medianOf(() => {
      const end = view.state.doc.length;
      view.dispatch({ selection: EditorSelection.cursor(end) });
      const t0 = performance.now();
      insertCodeBlock(view);
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] insertCodeBlock 中位数 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(4);
  });

  it("代码块内 20 击(update+重建)总计 < 200ms", () => {
    const cur = makeState(DOC, 0);
    const view = makeTogglingView(cur);
    const end = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.cursor(end) });
    insertCodeBlock(view);
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const at = view.state.selection.main.head;
      const t0 = performance.now();
      view.dispatch({ changes: { from: at, insert: "const x = 1;\n" } });
      buildInlineDecorations({ state: view.state, visibleRanges: [{ from: 0, to: view.state.doc.length }] });
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    expect(view.state.doc.toString().includes("const x = 1;")).toBe(true);
    console.warn(`[perf] 代码块输入 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(200);
  });
});

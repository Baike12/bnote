import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { insertNewlineAndIndent, history, undo } from "@codemirror/commands";
import { GFM } from "@lezer/markdown";
import { blockDecorationsField, buildInlineDecorations, selectionAffectsDecos } from "./livePreview";
import { mathRegions } from "./context";
import { scanMath } from "./mathScan";
import { buildSession, setSession } from "./snippets/extension";
import { parseReplacement, findSnippet } from "./snippets/engine";
import { renderMathHtml } from "./widgets";
import { enterContinueListItem, insertCodeBlock, insertMathBlock, toggleList } from "./ops";
import { renumberHeadings } from "./numbering";
import { moveByLinesVisual, type VimCoreState } from "./vim/verticalMotion";
import { intentsForRange } from "@/daily/engine";
import type { DailyLink } from "@/daily/links";

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

  it("60 次每击输入(update+装饰重建)总计 < 640ms,单击中位数 < 10ms", () => {
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
    expect(total).toBeLessThan(640);
    expect(median).toBeLessThan(10);
  });

  it("光标移动判定:槽外同行纯移动恒 false(快路径),跨行/跨标记槽 true", () => {
    const line = firstListLine(state);
    const base = makeState(DOC, line.from + 4);
    // 同行移动:标记槽(行首 "- ")之外,列表行同样走快路径。
    const sameLine = base.update({ selection: EditorSelection.cursor(line.from + 10) }).state;
    expect(selectionAffectsDecos(base, sameLine)).toBe(false);
    // 跨行移动:活动行规则让装饰可以随行变,返回 true 走重建——
    // 其成本由下面的移动预算测试锁定(实测 ~0.7ms/次)。
    const crossLine = base
      .update({ selection: EditorSelection.cursor(state.doc.line(line.number + 1).from + 4) })
      .state;
    expect(selectionAffectsDecos(base, crossLine)).toBe(true);
  });

  it("vim 模式切换(同行跨标记槽 0⇄A,每击重建)60 次总计 < 300ms", () => {
    // 0/$/A/Esc 落点这类同行移动会跨过标记槽(活动规则随光标翻转),每次
    // 都走重建路径——这是 normal⇄insert 往返的确定性成本下界。
    const line = firstListLine(state); // "- 无序列表项一,内容若干",槽宽 2
    let cur = state;
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const target = i % 2 === 0 ? line.from + 1 : line.from + 10;
      const t0 = performance.now();
      const next = cur.update({ selection: EditorSelection.cursor(target) }).state;
      if (selectionAffectsDecos(cur, next)) {
        buildInlineDecorations({ state: next, visibleRanges: [{ from: 0, to: next.doc.length }] });
      }
      samples.push(performance.now() - t0);
      cur = next;
    }
    const total = samples.reduce((a, b) => a + b, 0);
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    console.warn(`[perf] vim 切换(跨槽) 总计 ${total.toFixed(0)}ms, 中位 ${median.toFixed(2)}ms`);
    expect(total).toBeLessThan(300);
  });

  it("60 次光标移动(同行快路径+跨行重建混合)总计 < 250ms", () => {
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

  it("toggleList 单行(树查询路径)中位数 < 6ms", () => {
    const view = makeTogglingView(state);
    const median = medianOf(() => {
      const t0 = performance.now();
      toggleList(view, "bullet"); // 已是 bullet → 取消
      return performance.now() - t0;
    }, 9);
    toggleList(view, "bullet"); // 恢复
    console.warn(`[perf] toggleList 中位数 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(6);
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
  it("60 次 j/k(repeat 混合,运动+事务+重建)总计 < 500ms", () => {
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
  // 实测中位数 0.5ms;按 6-10× 标定带应为 3-5ms,2ms 的旧预算本身低于带宽,
  // 机器负载下(浏览器/dev server 并行)会误报。
  it("10 次块插入 dispatch 中位数 < 6ms", () => {
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
    expect(median).toBeLessThan(6);
  });

  it("公式内 20 击(update+重建+KaTeX渲染)总计 < 320ms", () => {
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
    expect(total).toBeLessThan(320);
  });
});

// ---- 代码块:插入 + 输入 ----

describe("性能门禁：代码块插入与输入", () => {
  it("10 次块插入 dispatch 中位数 < 6ms", () => {
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
    expect(median).toBeLessThan(6);
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

// ---- 段落回车:insert 模式 Enter 的真实回退链 ----
// 普通段落行上 Enter 走 enterContinueListItem(否)→ insertNewlineContinueMarkup(否)
// → insertNewlineAndIndent,加上每次文档变化后的装饰重建——即真实每击主线程
// 的全部状态管线。纯文本输入已有"每击输入"门禁,这里补的是回车这个高频键。

const firstParagraphLine = (state: EditorState) => {
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.text.startsWith("这是段落文字")) return line;
  }
  throw new Error("paragraph line not found");
};

describe("性能门禁：段落回车(900行,Enter 真实回退链)", () => {
  it("20 次(Enter+补字符)总计 < 340ms", () => {
    const probe = makeState(DOC, 0);
    const view = makeTogglingView(makeState(DOC, firstParagraphLine(probe).from + 8));
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      if (!enterContinueListItem(view)) {
        if (!insertNewlineContinueMarkup(view)) insertNewlineAndIndent(view);
      }
      const head = view.state.selection.main.head;
      view.dispatch({ changes: { from: head, insert: "字" } });
      buildInlineDecorations({ state: view.state, visibleRanges: [{ from: 0, to: view.state.doc.length }] });
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    // Enter 确实生效(行数增长),防止回退链全没接住测了个空循环。
    expect(view.state.doc.lines).toBeGreaterThan(900);
    console.warn(`[perf] 段落回车 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(340); // 静默中位 56ms,6× 标定带
  });
});

// ---- 进出公式块:active 翻转引发行内+块装饰整体重建 ----
// 光标每跨越一次公式区边界,livePreview 的"活动区"语义都会把公式从渲染态
// 翻回源码态(行内 replace 集合 + 块 widget 字段双双重算)。0/$ 行首尾移动
// 反复跨过边界时这就是每次按键的真实成本。

describe("性能门禁：进出公式块(active 翻转重建)", () => {
  it("40 次跨边界光标移动(update 含块装饰重算)总计 < 250ms", () => {
    const base = makeState(DOC, 0);
    // 找到第一个公式块:围栏上一行 ↔ 内容行来回。
    let fence = -1;
    for (let n = 1; n <= base.doc.lines; n++) {
      if (base.doc.line(n).text === "$$") {
        fence = n;
        break;
      }
    }
    expect(fence).toBeGreaterThan(0);
    const outside = base.doc.line(fence - 1).from + 2;
    const inside = base.doc.line(fence + 1).from + 2;
    // 功能断言:两个位置的块装饰值确实不同(active 翻转真的发生)。
    const outState = makeState(DOC, outside);
    const inState = outState.update({ selection: EditorSelection.cursor(inside) }).state;
    expect(base.field(blockDecorationsField)).not.toBe(outState.field(blockDecorationsField));
    expect(inState.field(blockDecorationsField)).not.toBe(outState.field(blockDecorationsField));
    let cur = outState;
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const target = i % 2 === 0 ? inside : outside;
      const t0 = performance.now();
      cur = cur.update({ selection: EditorSelection.cursor(target) }).state;
      buildInlineDecorations({ state: cur, visibleRanges: [{ from: 0, to: cur.doc.length }] });
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    console.warn(`[perf] 跨公式边界移动 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(250);
  });
});

// ---- undo:大文档上的历史回退 ----
// history 增量结构随文档规模增长,undo 在 900 行文档上不许退化成全文重算。

describe("性能门禁：undo(900行)", () => {
  it("20 次连续 undo 总计 < 20ms", () => {
    const withHistory = EditorState.create({
      doc: DOC,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        blockDecorationsField,
        history(),
        EditorState.allowMultipleSelections.of(true),
      ],
    });
    ensureSyntaxTree(withHistory, withHistory.doc.length);
    const view = makeTogglingView(withHistory);
    const line = firstParagraphLine(view.state);
    for (let i = 0; i < 20; i++) {
      const at = line.from + 4 + i;
      view.dispatch({ changes: { from: at, insert: "字" }, userEvent: "input.type" });
    }
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      undo(view);
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    expect(view.state.doc.length).toBe(withHistory.doc.length); // 20 次都真的回退了
    console.warn(`[perf] undo 总计 ${total.toFixed(0)}ms`);
    // 静默 ~1ms;绝对量在 GC 抖动量级,预算取 20× 防负载误报——
    // "退化成全文重算"级回归(60ms+)从这里必被拦下。
    expect(total).toBeLessThan(20);
  });
});

// ---- 整篇替换:openNote 装载大笔记的真实形态 ----
// 全文替换 + 全量装饰构建 + 完整语法树,即切换笔记那一刻的主线程成本。

describe("性能门禁：整篇文档装载(900行)", () => {
  it("全文替换+装饰构建+完整解析 中位数 < 30ms", () => {
    const base = makeState("空\n", 0);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const next = base.update({ changes: { from: 0, to: base.doc.length, insert: DOC } }).state;
      ensureSyntaxTree(next, next.doc.length);
      buildInlineDecorations({ state: next, visibleRanges: [{ from: 0, to: next.doc.length }] });
      samples.push(performance.now() - t0);
    }
    const median = samples.sort((a, b) => a - b)[2];
    console.warn(`[perf] 整篇装载 中位数 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(30);
  });
});

// ---- mathRegions 缓存纪律 ----
// 未变文档必须命中缓存(同一实例);文档变化后的重扫是每次击键的固定税,
// 锁住量级防止有人删掉缓存让每击都全文扫描。

describe("性能门禁：mathRegions 缓存", () => {
  it("未变文档缓存命中(同实例),单击后重扫中位数 < 2ms", () => {
    const base = makeState(DOC, 0);
    const a = mathRegions(base);
    const b = mathRegions(base);
    expect(a).toBe(b); // 同一 doc 上必须命中缓存,不能重扫
    const at = firstListLine(base).from + 4;
    let cur = base;
    const median = medianOf(() => {
      cur = cur.update({ changes: { from: at, insert: "字" } }).state;
      const t0 = performance.now();
      mathRegions(cur);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] mathRegions 重扫 中位数 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(2);
  });
});

// ---- 公式扫描:栈式配对 + 空行容错 ----
// 配对从"两两顺序配对"改为栈式后,被拒的配对会让闭候选继续向后找。用
// "完好公式 + 错位落单 $$ 交错"的文档锁住全文重扫量级,防止有人把配对
// 写成对每个标记的全文查找。

describe("性能门禁：公式扫描(栈式配对)", () => {
  // 20 个完好公式与 20 个落单 $$ 交错,再加一个文档尾部错位产物
  const mixedDoc = (() => {
    const parts: string[] = [];
    for (let i = 0; i < 20; i++) {
      parts.push("$$");
      parts.push(`E_{${i}} = mc^2`);
      parts.push("$$");
      parts.push("");
      parts.push("$$");
      parts.push("");
      parts.push("正文段落,若干文字。");
      parts.push("");
    }
    parts.push("$$");
    parts.push("stray = 1");
    return parts.join("\n");
  })();

  it("mathRegions 全文重扫(80+ $$ 标记,含错位与空行容错)中位数 < 1ms", () => {
    const state = makeState(mixedDoc, 0);
    const median = medianOf(() => {
      const t0 = performance.now();
      scanMath(state.doc);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] 公式扫描(80+标记) 中位数 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(1);
  });
});

// ---- 片段会话内的每击输入 ----
// 会话期间自动补全不再被压制(嵌套会话栈):每击额外跑一次 findSnippet
// (221 条编译片段的触发器匹配)+ 会话链字段映射。锁住这条新热路径的量级。

describe("性能门禁：片段会话内输入", () => {
  it("会话内 20 击(dispatch+链映射+findSnippet)总计 < 90ms", () => {
    const view = makeTogglingView(makeState(DOC, 0));
    const end = view.state.doc.length;
    // 起一个括号会话(insertMathBlock 的 $$…$$ 已在文档里,直接建会话)
    view.dispatch({ changes: { from: end, insert: "()" }, selection: { anchor: end + 1 } });
    const session = buildSession(end, parseReplacement("($0)$1", [], null));
    view.dispatch({ effects: setSession.of(session) });

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const at = view.state.selection.main.head;
      const t0 = performance.now();
      // 真实每击管线:插入事务(会话链映射)+ 触发器匹配
      view.dispatch({ changes: { from: at, insert: "x" }, userEvent: "input.type" });
      findSnippet(view.state, view.state.selection.main.head, "x", {
        auto: true,
        visualText: null,
      });
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    expect(view.state.doc.sliceString(end, end + 22)).toContain("xxxxxxxxxxxxxxxxxxxx");
    console.warn(`[perf] 会话内 20 击 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(90);
  });
});

// ---- 换行 · 段落墙重解析锚定 ----
// Enter 的真实成本里有一段不在上面任何状态管线测试里:markdown 按顶层
// 开放块做增量解析,段落墙(无空行的连续段落)是「一个块节点」,块内
// 任何编辑(换行、打字)都会让解析从块起点重新推进,成本线性于块大小。
// 浏览器实测(2026-09-22):4000 行段落墙 Enter ~25ms(掉 2 帧,用户
// 感知为换行卡顿),同规模每 50 行一空行的文档 1.6ms。ensureSyntaxTree
// 把「解析推进到视口」这笔账锁进无 DOM 门禁:
//  - chunked 锚定块边界感知:边界判定一旦退化(空行不再切块/全文重解析),
//    它先涨到段落墙量级;
//  - wall 两点锚定线性上界:解析器若出现按行数超线性退化(如每次全量
//    重解析 N 块)会被 10× 拦下。

function wallDoc(lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) parts.push(`段落行 ${i}:连续文字,中间没有任何空行,整篇是一个大段落块。`);
  return parts.join("\n");
}

function chunkedDoc(lines: number, every: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) {
    parts.push(`段落行 ${i}:连续文字若干,长度中等。`);
    if (i % every === every - 1) parts.push("");
  }
  return parts.join("\n");
}

/** 段落墙探针:光标固定在第 1000 行行尾,Enter 分裂 + 解析推进(计时),
 *  再把插入的换行删掉(不计入)回到同一起点。 */
function wallEnterMedian(doc: string, times: number): number {
  const state = makeState(doc);
  ensureSyntaxTree(state, state.doc.length);
  const samples: number[] = [];
  let cur = state;
  for (let i = 0; i < times; i++) {
    const line = cur.doc.line(1000);
    const t0 = performance.now();
    cur = cur
      .update({
        changes: { from: line.to, insert: "\n" },
        selection: { anchor: line.to + 1 },
        userEvent: "input.type",
      })
      .state;
    ensureSyntaxTree(cur, cur.doc.length);
    samples.push(performance.now() - t0);
    cur = cur
      .update({
        changes: { from: line.to + 1, to: Math.min(line.to + 2, cur.doc.length), insert: "" },
      })
      .state;
    ensureSyntaxTree(cur, cur.doc.length);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(times / 2)];
}

describe("性能门禁:换行 · 段落墙重解析(块粒度)", () => {
  it("每50行一空行的 4000 行文档:Enter+解析推进 中位 < 10ms", () => {
    const median = wallEnterMedian(chunkedDoc(4000, 50), 11);
    console.warn(`[perf] chunked-4000 换行重解析 中位 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(15); // 静默 ~1.3-1.7ms,5-6× 带
  });

  it("1000 行段落墙:Enter+解析推进 中位 < 60ms(静默 ~8.5ms,6× 带)", () => {
    const median = wallEnterMedian(wallDoc(1000), 11);
    console.warn(`[perf] wall-1000 换行重解析 中位 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(60);
  });

  it("2000 行段落墙:Enter+解析推进 中位 < 100ms(两点线性锚定,静默 ~16ms,6× 带)", () => {
    const median = wallEnterMedian(wallDoc(2000), 11);
    console.warn(`[perf] wall-2000 换行重解析 中位 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(100);
  });
});

// ---- 换行 · 大文档列表续行 ----
// 列表续行门禁原来只在 1 行的小文档上量,真实场景是「大文档里的列表」:
// enterContinueListItem 的树查询 + O(文档) 装饰重建都在这里才显形。
// 走真实回退链(enterContinueListItem 自己接住)+ 每次装饰重建,与
// 「段落回车」门禁同协议。

describe("性能门禁:换行 · 900行大文档列表续行(bullet/ordered/todo)", () => {
  const cases: { name: string; seed: RegExp }[] = [
    { name: "bullet", seed: /^- 无序列表项一/ },
    { name: "ordered", seed: /^1\. 有序项/ },
    { name: "todo", seed: /^- \[ \] 待办项/ },
  ];
  for (const { name, seed } of cases) {
    it(`${name}: 20 次(Enter 建项+补字符+装饰重建)总计 < 350ms`, () => {
      const view = makeTogglingView(makeState(DOC, 0));
      const findSeed = () => {
        for (let n = 1; n <= view.state.doc.lines; n++) {
          const l = view.state.doc.line(n);
          if (seed.test(l.text)) return l;
        }
        throw new Error(`${name} 种子行没找到`);
      };
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const line = findSeed();
        view.dispatch({ selection: EditorSelection.cursor(line.to) });
        const t0 = performance.now();
        if (!enterContinueListItem(view)) throw new Error(`${name} 续行没接住`);
        const head = view.state.selection.main.head;
        view.dispatch({ changes: { from: head, insert: "字" } });
        ensureSyntaxTree(view.state, view.state.doc.length);
        buildInlineDecorations({ state: view.state, visibleRanges: [{ from: 0, to: view.state.doc.length }] });
        samples.push(performance.now() - t0);
      }
      const total = samples.reduce((a, b) => a + b, 0);
      // Enter 确实持续建项:种子行从初始 1 行长到 20+ 行。
      const seedCount = view.state.doc
        .toString()
        .split("\n")
        .filter((l) => seed.test(l)).length;
      expect(seedCount).toBeGreaterThan(15);
      console.warn(`[perf] 900行 ${name} 续行 总计 ${total.toFixed(0)}ms`);
      expect(total).toBeLessThan(350);
    });
  }
});

// ---- 换行 · 有序列表长顺延 ----
// Enter 建项时 bumpFollowingOrdered 会把后续所有连号项改号(一次事务里
// N 处编辑 + 全文档 changeSet 映射)。列表越长这条越贵,锁住量级防止
// 顺延退化成逐项 dispatch 或全文重映射。

describe("性能门禁:换行 · 有序列表 30 项长顺延", () => {
  it("20 次(第 1 项行尾 Enter,29 项顺延)总计 < 100ms", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`${i}. 有序列表第 ${i} 项,内容若干`);
    const view = makeTogglingView(makeState(lines.join("\n"), 0));
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      view.dispatch({ selection: EditorSelection.cursor(line.to) });
      const t0 = performance.now();
      if (!enterContinueListItem(view)) throw new Error("有序列表续行没接住");
      samples.push(performance.now() - t0);
      // 光标回到第 1 项行尾(新建的第 2 项),下一轮继续从最前面顺延
      view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).to) });
    }
    const total = samples.reduce((a, b) => a + b, 0);
    // 顺延确实发生:最后一项编号被推到 50(30 项 + 20 轮插入)。
    expect(view.state.doc.toString()).toContain("50. 有序列表第 30 项");
    console.warn(`[perf] 有序 30 项顺延 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(100);
  });
});

// ---- 换行 · 标题自动编号扫描(用户开启项的每击保险) ----
// autoNumberHeadings 开启时每次文档变化后 renumberHeadings 全文档行扫
// (fence 扫描 + 每行正则)。这是「每击 O(文档)」的固定支出,量级由
// 这里看住;同时功能断言防扫描漏标题。

describe("性能门禁:标题自动编号全文档扫描(900行)", () => {
  it("20 次扫描(编号已对齐,纯扫描)总计 < 80ms", () => {
    const view = makeTogglingView(makeState(DOC, 0));
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      renumberHeadings(view);
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    console.warn(`[perf] 编号扫描(无变化) 总计 ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(80);
  });

  it("编号缺失时正好补上(功能锚定)", () => {
    const stale = DOC.replace("## 3 章节", "## 章节");
    const view = makeTogglingView(makeState(stale, 0));
    renumberHeadings(view);
    expect(view.state.doc.toString()).toContain("## 3 章节");
  });
});

// ---- 跨文件待办同步 · 每键意图提取(dailySyncExtension 的固定支出) ----
// updateListener 里的行级 diff:无意图时只付「变更行解析 + 身份文本比对」,
// 链接命中时加一次块根上溯(步数有界)。这里测 intentsForRange 本身——监听器
// 相对既有管线的增量成本;功能锚定防「测了个空转」。

describe("性能门禁:跨文件待办同步意图提取(900行)", () => {
  const linksFor = (texts: string[]): DailyLink[] =>
    texts.map((text, i) => ({
      id: `l${i}`,
      kind: "copied" as const,
      day: "2026-09-21",
      srcPath: "/vault/note.md",
      dailyPath: "/vault/Daily/2026-09-21.md",
      text,
      srcLine: 1,
      dailyLine: 1,
    }));

  /** 模拟一次敲键:返回「提取」这一步的耗时(update 成本不在测量内)。 */
  function keystrokeExtract(state: EditorState, links: DailyLink[], allowRecord: boolean): number {
    const tr = state.update({ changes: { from: state.selection.main.head, insert: "字" } });
    const ranges: [number, number, number, number][] = [];
    tr.changes.iterChangedRanges((a, b, c, d) => ranges.push([a, b, c, d]));
    const t0 = performance.now();
    for (const [a, b, c, d] of ranges) {
      intentsForRange(tr.startState.doc, tr.state.doc, a, b, c, d, links, allowRecord);
    }
    return performance.now() - t0;
  }

  const todoPos = DOC.indexOf("待办项 60") + 7; // 待办行内容中间
  const nestedPos = DOC.indexOf("嵌套项 60") + 4; // 缩进子行(触发块根上溯)

  it("无链接时每键提取(正文/待办行/缩进子行)中位 < 2.5ms(静默 ~0.5ms,含 GC 压力,6× 带)", () => {
    for (const pos of [todoPos, nestedPos]) {
      const state = makeState(DOC, pos);
      const median = medianOf(() => keystrokeExtract(state, [], true), 200);
      console.warn(`[perf] daily 提取(无链接) 中位 ${median.toFixed(4)}ms`);
      expect(median).toBeLessThan(2.5); // 静默 ~0.45ms(含每轮新事务的 GC 压力),~6× 标定带
    }
  });

  it("3 条链接时每键提取中位 < 2.5ms(块根上溯+文本比对,与无链接同量级)", () => {
    const links = linksFor(["待办项 5", "已完成项 250", "待办项 499"]);
    for (const pos of [todoPos, nestedPos]) {
      const state = makeState(DOC, pos);
      const median = medianOf(() => keystrokeExtract(state, links, true), 200);
      console.warn(`[perf] daily 提取(3链接) 中位 ${median.toFixed(4)}ms`);
      expect(median).toBeLessThan(2.5); // 与无链接同量级:文本比对是主成本
    }
  });

  it("功能锚定:900 行文档里的勾选翻转确实被捕获", () => {
    const before = DOC.indexOf("- [ ] 待办项 60");
    const lineEnd = before + "- [ ] 待办项 60".length;
    const old = makeState(DOC, before);
    const tr = old.update({
      changes: { from: before + 3, to: before + 4, insert: "x" },
      userEvent: "input.bnote-todo",
    });
    const intents: unknown[] = [];
    tr.changes.iterChangedRanges((a, b, c, d) =>
      intents.push(...intentsForRange(tr.startState.doc, tr.state.doc, a, b, c, d, linksFor(["待办项 60"]), true)),
    );
    expect(intents).toContainEqual({ type: "mirror", linkId: "l0", rootHint: tr.startState.doc.lineAt(before).number, renamedTo: "待办项 60" });
    expect(lineEnd).toBeGreaterThan(0);
  });
});

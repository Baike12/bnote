import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { insertNewlineAndIndent, history, undo } from "@codemirror/commands";
import { GFM } from "@lezer/markdown";
import {
  blockDecorationsField,
  buildInlineDecorations,
  selectionAffectsDecos,
} from "./livePreview";
import { buildEmphasisMarks } from "./emphasisMarks";
import { projectTodos } from "@/projects/model";
import { fenceStateScan, mathRegions, mathRegionsField } from "./context";
import { calloutRegions, calloutRegionsField, computeCalloutRegions } from "./callout";
import { clearPerf, perfStats } from "@/perf/trace";
import { planTabout } from "./snippets/tabout";
import { scanMath } from "./mathScan";
import { buildSession, setSession } from "./snippets/extension";
import { parseReplacement, findSnippet } from "./snippets/engine";
import { renderMathHtml } from "./widgets";
import { enterContinueListItem, insertCodeBlock, insertMathBlock, toggleList } from "./ops";
import { renumberHeadings } from "./numbering";
import { moveByLinesVisual, type VimCoreState } from "./vim/verticalMotion";
import { visualSelectionDecos } from "./vim/vim";
import { intentsForRange } from "@/daily/engine";
import type { DailyLink } from "@/daily/links";
import { buildDailyMarks } from "@/daily/marks";
import { diffBlocks } from "@/footprint/model";
import { buildFootprintMarks } from "@/footprint/extension";
import { renderBlockHtml } from "@/footprint/render";

/**
 * Perf gate (bnote's lifeline): the per-keystroke cost of the editing pipeline
 * must stay within an order of magnitude. Budgets are calibrated at ~6x the
 * locally measured median — order-of-magnitude regressions (an accidental
 * full-document scan, unstable decorations, a parser-ambiguity flip) are caught
 * from 10x on, while CI/machine jitter does not cause false positives. After
 * touching a perf-sensitive path, measure it in the browser first (AGENTS.md:
 * performance work uses deterministic measurement), then lock the order of
 * magnitude here.
 *
 * What is measured is the DOM-free state pipeline (state.update + decoration
 * rebuild), i.e. the deciding part of the real per-keystroke CPU cost; view-layer
 * DOM updates are verified in the browser instead, not simulated here.
 */

/** Big-document generator of the same shape as the browser measurement: interleaved headings/paragraphs/math blocks/three list kinds. */
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

const DOC = bigDoc(60); // ~900 lines

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

describe("perf gate: big document (~900 lines) per-keystroke pipeline budget", () => {
  const state = makeState(DOC, 0);

  it("inline decoration build (whole viewport = whole document, the upper bound) median < 4ms", () => {
    const median = medianOf(() => {
      const t0 = performance.now();
      buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] inline decoration build median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(4);
  });

  // Emphasis styling moved from syntax-highlight tags to decorations (see
  // emphasisMarks.ts): it walks the visible range's syntax tree on every
  // document change. Building over the whole document (the upper bound) must
  // stay within an order of magnitude, otherwise every keystroke pays an extra
  // full-document tree traversal.
  it("emphasis mark build (whole document = the upper bound, rebuilt per keystroke) median < 2ms", () => {
    const emphState = makeState(
      bigDoc(60).replace(/这是段落文字/g, "这是 _斜体_ 与 **加粗** 段落文字"),
      0,
    );
    const median = medianOf(() => {
      const t0 = performance.now();
      buildEmphasisMarks(emphState, [{ from: 0, to: emphState.doc.length }]);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] emphasis mark build median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(2);
  });

  it("60 per-keystroke inputs (update + decoration rebuild) total < 640ms, single keystroke median < 10ms", () => {
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
    console.warn(
      `[perf] per-keystroke input total ${total.toFixed(0)}ms, median ${median.toFixed(2)}ms`,
    );
    expect(total).toBeLessThan(640);
    expect(median).toBeLessThan(10);
  });

  it("caret move decision: a same-line move outside the slot is always false (the fast path), a cross-line or cross-slot move is true", () => {
    const line = firstListLine(state);
    const base = makeState(DOC, line.from + 4);
    // Same-line move: outside the marker slot (the leading "- "), list lines
    // take the fast path too.
    const sameLine = base.update({ selection: EditorSelection.cursor(line.from + 10) }).state;
    expect(selectionAffectsDecos(base, sameLine)).toBe(false);
    // Cross-line move: the active-line rule lets decorations follow the line,
    // so it returns true and takes the rebuild path — its cost is locked by the
    // motion budget test below (measured ~0.7ms/move).
    const crossLine = base.update({
      selection: EditorSelection.cursor(state.doc.line(line.number + 1).from + 4),
    }).state;
    expect(selectionAffectsDecos(base, crossLine)).toBe(true);
  });

  it("vim mode switch (same-line move across the marker slot 0⇄A, rebuild per keystroke) 60 times total < 300ms", () => {
    // Same-line moves to 0/$/A/Esc targets cross the marker slot (the active
    // rule flips with the cursor), so each one takes the rebuild path — this is
    // the deterministic cost floor of a normal⇄insert round trip.
    const line = firstListLine(state); // "- unordered list item one, some content", slot width 2
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
    console.warn(
      `[perf] vim switch (across slots) total ${total.toFixed(0)}ms, median ${median.toFixed(2)}ms`,
    );
    expect(total).toBeLessThan(300);
  });

  it("60 caret moves (mixed same-line fast path + cross-line rebuild) total < 250ms", () => {
    const line = firstListLine(state);
    const from = line.from + 4;
    let cur = state;
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const target =
        i % 2 === 0
          ? from + 10 // same line: fast path
          : state.doc.line(line.number + (i % 4 === 1 ? 1 : -1)).from + 4; // cross line: rebuild
      const t0 = performance.now();
      const next = cur.update({ selection: EditorSelection.cursor(target) }).state;
      if (selectionAffectsDecos(cur, next)) {
        buildInlineDecorations({ state: next, visibleRanges: [{ from: 0, to: next.doc.length }] });
      }
      samples.push(performance.now() - t0);
      cur = next;
    }
    const total = samples.reduce((a, b) => a + b, 0);
    console.warn(`[perf] caret moves total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(250);
  });

  it("toggleList on a single line (the tree query path) median < 6ms", () => {
    const view = makeTogglingView(state);
    const median = medianOf(() => {
      const t0 = performance.now();
      toggleList(view, "bullet"); // already a bullet → toggles off
      return performance.now() - t0;
    }, 9);
    toggleList(view, "bullet"); // restore
    console.warn(`[perf] toggleList median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(6);
  });
});

/** Fake view for command timing: carries the full markdown extensions (the real tree-query path), focus is a no-op. */
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

// ---- vim motion j/k: the node-testable part of the real motion model ----
// moveByLinesVisual (pixel anchoring + hidden-line stepping, fake geometry) +
// selection transaction + cross-line rebuild, i.e. the entire state pipeline a
// real j/k keystroke runs on the main thread (DOM measurement is locked by the
// browser verification protocol).

const CHAR_W = 8;
const ROW_H = 24;
const CONTENT_LEFT = 100;

describe("perf gate: vim j/k motion (900 lines, hidden-line stepping across math blocks)", () => {
  it("60 j/k moves (mixed repeat counts, motion + transaction + rebuild) total < 500ms", () => {
    let cur = makeState(DOC, 0);
    const at = Math.floor(cur.doc.length / 2);
    cur = cur.update({ selection: EditorSelection.cursor(at) }).state;
    // Fake geometry view: state follows cur, j/k does not change the document,
    // geometry is deterministic.
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
        return {
          left: CONTENT_LEFT + (pos - line.from) * CHAR_W,
          top: top + 2,
          bottom: top + ROW_H - 2,
        };
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
    const vim: VimCoreState = {
      lastMotion: motions.moveByLines,
      lastHPos: 0,
      lastHSPos: Number.NaN,
    };
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
        out.ch === Infinity
          ? targetLine.to
          : Math.min(targetLine.from + Math.max(0, out.ch), targetLine.to);
      const next = cur.update({ selection: EditorSelection.cursor(target) }).state;
      buildInlineDecorations({ state: next, visibleRanges: [{ from: 0, to: next.doc.length }] });
      samples.push(performance.now() - t0);
      cur = next;
    }
    const total = samples.reduce((a, b) => a + b, 0);
    console.warn(`[perf] vim j/k total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(500);
  });
});

// ---- visual selection painting: the per-keystroke rebuild of visualSelectionDecos ----
// In visual mode every j/k/l is a selection change → vimVisualHighlight
// rebuilds the decoration set. Linewise select-all (900 line bands, via the
// ordered builder) and the blockwise block (per-line slicing + sorting) are the
// two cost upper bounds; budgets are calibrated from locally measured medians.

describe("perf gate: visual selection paint rebuild (900 lines)", () => {
  it("linewise select-all (900 line bands) 60 rebuilds total < 150ms", () => {
    const doc = makeState(DOC).doc;
    const vimState = {
      visualMode: true,
      visualLine: true,
      sel: { anchor: { line: 0, ch: 0 }, head: { line: doc.lines - 1, ch: 0 } },
    };
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      const set = visualSelectionDecos(doc, vimState, []);
      if (set.size !== doc.lines) throw new Error(`expected ${doc.lines} bands, got ${set.size}`);
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    samples.sort((a, b) => a - b);
    console.warn(
      `[perf] visual linewise select-all total ${total.toFixed(0)}ms, median ${samples[30].toFixed(2)}ms`,
    );
    expect(total).toBeLessThan(150);
  });

  it("blockwise (60 lines × 20 columns, per-line slicing + sorting) 60 rebuilds total < 60ms", () => {
    const doc = makeState(DOC).doc;
    const vimState = {
      visualMode: true,
      visualBlock: true,
      sel: { anchor: { line: 200, ch: 4 }, head: { line: 259, ch: 24 } },
    };
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      const set = visualSelectionDecos(doc, vimState, []);
      if (set.size < 60) throw new Error(`expected >= 60 decos, got ${set.size}`);
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    samples.sort((a, b) => a - b);
    console.warn(
      `[perf] visual blockwise 60 lines total ${total.toFixed(0)}ms, median ${samples[30].toFixed(2)}ms`,
    );
    expect(total).toBeLessThan(60);
  });
});

// ---- list continuation on Enter: the split main path of enterContinueListItem ----
// Each item = Enter (create a new item) + one filler character (keeps it
// non-empty so the next Enter keeps splitting), and every document change goes
// through a real update + decoration rebuild.

describe("perf gate: list continuation (bullet/ordered/todo, 20 items each)", () => {
  const kinds: { name: string; seed: string }[] = [
    { name: "bullet", seed: "- 无序列表项" },
    { name: "ordered", seed: "1. 有序列表项" },
    { name: "todo", seed: "- [ ] 待办项" },
  ];
  for (const { name, seed } of kinds) {
    it(`${name}: 20 times (Enter creates an item + filler char) total < 50ms`, () => {
      const view = makeTogglingView(makeState(`${seed}\n`, 0));
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        // caret to end of current line → Enter → append a character at the end of the new item
        const t0 = performance.now();
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        view.dispatch({ selection: EditorSelection.cursor(line.to) });
        enterContinueListItem(view);
        const nl = view.state.doc.lineAt(view.state.selection.main.head);
        view.dispatch({ changes: { from: nl.to, insert: "字" } });
        buildInlineDecorations({
          state: view.state,
          visibleRanges: [{ from: 0, to: view.state.doc.length }],
        });
        samples.push(performance.now() - t0);
      }
      const total = samples.reduce((a, b) => a + b, 0);
      // Assert the items really keep splitting (guards against measuring an
      // empty loop because the command did not fire).
      expect(
        view.state.doc
          .toString()
          .split("\n")
          .filter((l) => l.length > 2).length,
      ).toBeGreaterThan(15);
      console.warn(`[perf] ${name} newline total ${total.toFixed(0)}ms`);
      expect(total).toBeLessThan(50);
    });
  }
});

// ---- math blocks: insertion + typing ----
// Every keystroke inside a formula changes the source string, so the KaTeX
// cache always misses — one full render per keystroke is the dominant cost of
// formula input, and is locked together with the state pipeline.

describe("perf gate: math block insertion and typing", () => {
  // Measured median 0.5ms; at a 6-10x calibration band it should be 3-5ms, so
  // the old 2ms budget sat below the band and fired false positives under
  // machine load (browser/dev server running in parallel).
  it("10 block insertions, dispatch median < 6ms", () => {
    const cur = makeState(DOC, 0);
    const view = makeTogglingView(cur);
    const median = medianOf(() => {
      const end = view.state.doc.length;
      view.dispatch({ selection: EditorSelection.cursor(end) });
      const t0 = performance.now();
      insertMathBlock(view);
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] insertMathBlock median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(6);
  });

  it("20 keystrokes inside a formula (update + rebuild + KaTeX render) total < 320ms", () => {
    const cur = makeState(DOC, 0);
    const view = makeTogglingView(cur);
    const end = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.cursor(end) });
    insertMathBlock(view);
    // The caret lands inside the $$…$$; append formula source to it.
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const at = view.state.selection.main.head;
      const t0 = performance.now();
      view.dispatch({ changes: { from: at, insert: "\\alpha_{x}+" } });
      const region = mathRegions(view.state).find(
        (r) => view.state.selection.main.head >= r.from && view.state.selection.main.head <= r.to,
      );
      buildInlineDecorations({
        state: view.state,
        visibleRanges: [{ from: 0, to: view.state.doc.length }],
      });
      if (region) renderMathHtml(region.content, true); // the real call of MathPreviewWidget.toDOM
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    const doc = view.state.doc.toString();
    expect(doc.includes("\\alpha_{x}")).toBe(true); // the input really entered the formula region
    console.warn(`[perf] formula input total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(320);
  });

  // Inline formula editing shows only the source (no rendered copy is
  // inserted), so each keystroke costs just update + decoration rebuild — the
  // KaTeX cost is gone. The budget stays in the same band; what it guards is
  // decoration-rebuild regression.
  it("20 keystrokes inside an inline formula (update + decoration rebuild) total < 320ms", () => {
    const insert = "\\alpha_{x}+";
    let state = makeState("前文 $f(x)$ 后文\n", 6);
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const at = state.selection.main.head;
      const t0 = performance.now();
      state = state.update({
        changes: { from: at, insert },
        selection: EditorSelection.cursor(at + insert.length),
      }).state;
      buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    expect(state.doc.toString().includes("\\alpha_{x}")).toBe(true); // the input really entered the formula region
    console.warn(`[perf] inline formula input total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(320);
  });
});

// ---- code blocks: insertion + typing ----

describe("perf gate: code block insertion and typing", () => {
  it("10 block insertions, dispatch median < 6ms", () => {
    const cur = makeState(DOC, 0);
    const view = makeTogglingView(cur);
    const median = medianOf(() => {
      const end = view.state.doc.length;
      view.dispatch({ selection: EditorSelection.cursor(end) });
      const t0 = performance.now();
      insertCodeBlock(view);
      return performance.now() - t0;
    }, 9);
    console.warn(`[perf] insertCodeBlock median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(6);
  });

  it("20 keystrokes inside a code block (update + rebuild) total < 200ms", () => {
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
      buildInlineDecorations({
        state: view.state,
        visibleRanges: [{ from: 0, to: view.state.doc.length }],
      });
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    expect(view.state.doc.toString().includes("const x = 1;")).toBe(true);
    console.warn(`[perf] code block input total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(200);
  });
});

// ---- paragraph Enter: the real fallback chain of Enter in insert mode ----
// On a plain paragraph line Enter goes enterContinueListItem (no) →
// insertNewlineContinueMarkup (no) → insertNewlineAndIndent, plus the
// decoration rebuild after every document change — the entire real
// per-keystroke main-thread state pipeline. Plain text typing already has the
// "per-keystroke input" gate; this adds the high-frequency Enter key.

const firstParagraphLine = (state: EditorState) => {
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.text.startsWith("这是段落文字")) return line;
  }
  throw new Error("paragraph line not found");
};

describe("perf gate: paragraph Enter (900 lines, the real fallback chain)", () => {
  it("20 times (Enter + filler char) total < 340ms", () => {
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
      buildInlineDecorations({
        state: view.state,
        visibleRanges: [{ from: 0, to: view.state.doc.length }],
      });
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    // Enter really fired (the line count grew), guarding against measuring an
    // empty loop when the fallback chain caught nothing.
    expect(view.state.doc.lines).toBeGreaterThan(900);
    console.warn(`[perf] paragraph enter total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(340); // silent median 56ms, 6x calibration band
  });
});

// ---- entering/leaving math blocks: the active flip forces a full rebuild of inline + block decorations ----
// Every time the caret crosses a math region boundary, livePreview's "active
// region" semantics flip the formula from rendered state back to source state
// (inline replace set + block widget field, both recomputed). Repeated 0/$
// line-start/end motion across the boundary is exactly the real per-keypress
// cost.

describe("perf gate: entering and leaving math blocks (active flip rebuild)", () => {
  it("40 caret moves across the boundary (the update includes the block decoration recompute) total < 250ms", () => {
    const base = makeState(DOC, 0);
    // Find the first math block: bounce between the fence line and the content line.
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
    // Functional assertion: the block decoration values at the two positions
    // really differ (the active flip really happened).
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
    console.warn(`[perf] movement across a formula boundary total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(250);
  });
});

// ---- undo: history rewind on a big document ----
// The history incremental structure grows with document size, so undo on a
// 900-line document must not degenerate into a full recomputation.

describe("perf gate: undo (900 lines)", () => {
  it("20 consecutive undos total < 20ms", () => {
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
    expect(view.state.doc.length).toBe(withHistory.doc.length); // all 20 really rewound
    console.warn(`[perf] undo total ${total.toFixed(0)}ms`);
    // Silent ~1ms; the absolute amount sits at the GC-jitter level, so the
    // budget takes 20x to avoid load-induced false positives — a
    // "degenerated into a full recompute" regression (60ms+) is caught here.
    expect(total).toBeLessThan(20);
  });
});

// ---- whole-document replacement: the real shape of openNote loading a big note ----
// Full-text replacement + full decoration build + complete syntax tree, i.e.
// the main-thread cost of the moment a note is switched.

describe("perf gate: whole-document load (900 lines)", () => {
  it("full-text replacement + decoration build + complete parse median < 30ms", () => {
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
    console.warn(`[perf] full document load median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(30);
  });
});

// ---- mathRegions cache discipline ----
// An unchanged document must hit the cache (the same instance); the rescan
// after a document change is a fixed per-keystroke tax, so its order of
// magnitude is locked to stop someone from deleting the cache and making
// every keystroke scan the whole document.

describe("perf gate: the mathRegions cache", () => {
  it("an unchanged document hits the cache (the same instance), the rescan after one keystroke has median < 2ms", () => {
    const base = makeState(DOC, 0);
    const a = mathRegions(base);
    const b = mathRegions(base);
    expect(a).toBe(b); // the same doc must hit the cache, no rescan
    const at = firstListLine(base).from + 4;
    let cur = base;
    const median = medianOf(() => {
      cur = cur.update({ changes: { from: at, insert: "字" } }).state;
      const t0 = performance.now();
      mathRegions(cur);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] mathRegions rescan median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(2);
  });
});

// ---- formula scanning: stack-based pairing + blank-line tolerance ----
// After pairing switched from "pair up in sequence" to a stack, a rejected
// pair makes the closing candidate keep searching forward. A document of
// "intact formulas + misaligned stray $$ interleaved" locks the order of
// magnitude of the full rescan, so nobody can rewrite the pairing as a
// full-document search per marker.

describe("perf gate: formula scanning (stack-based pairing)", () => {
  // 20 intact formulas interleaved with 20 stray $$, plus one misaligned
  // artifact at the end of the document
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

  it("mathRegions full rescan (80+ $$ markers, including misaligned ones and blank-line tolerance) median < 1ms", () => {
    const state = makeState(mixedDoc, 0);
    const median = medianOf(() => {
      const t0 = performance.now();
      scanMath(state.doc);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] formula scan (80+ markers) median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(1);
  });
});

// ---- Tab out of brackets (tabout) ----
// The last layer after Tab has walked the snippet and the tab stops: scan
// backward to the first closing bracket between the caret and the end of the
// formula content. Lock the order of magnitude of this path — the scan must
// only look at that slice, never pull the whole document into a string (on a
// 900-line document that is an O(n) allocation per Tab).

describe("perf gate: Tab out of brackets (tabout)", () => {
  const mathLine = (state: EditorState) => {
    for (let n = 1; n <= state.doc.lines; n++) {
      if (state.doc.line(n).text.startsWith("L_{1}")) return state.doc.line(n);
    }
    throw new Error("block math line not found");
  };

  it("each Tab in a 900-line document (including the mathRegions rescan) has median < 2ms", () => {
    const base = makeState(DOC, 0);
    const cursor = mathLine(base).to - 2;
    let cur = base;
    const median = medianOf(() => {
      // Every iteration has a document change before it (a real typing
      // stream): the mathRegions cache necessarily misses
      cur = cur.update({ changes: { from: cur.doc.length, insert: "字" } }).state;
      const at = Math.min(cursor, cur.doc.length);
      const t0 = performance.now();
      planTabout(cur, at);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] tabout (900 lines) median ${median.toFixed(3)}ms`);
    expect(median).toBeLessThan(2);
  });

  it("the scan inside long formula content only looks at a slice: the closing delimiter is only met 2000+ characters later, median < 1ms", () => {
    // Really scan a long content run (instead of hitting a closer after two or
    // three characters): the scan length is bounded by the content length, so
    // if someone changes it to "toString the whole document + search it
    // fully", this case drops out of budget.
    const doc = `$$\n${"x".repeat(2000)} \\right)\n$$\n下一段`;
    const state = makeState(doc, 0);
    const cursor = 3; // start of the content, the closer is 2000+ characters away
    const plan = planTabout(state, cursor);
    expect(plan?.pos).toBe(doc.indexOf("\\right)") + "\\right)".length);
    const median = medianOf(() => {
      const t0 = performance.now();
      planTabout(state, cursor);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] tabout (long-content slice) median ${median.toFixed(3)}ms`);
    expect(median).toBeLessThan(1);
  });
});

// ---- per-keystroke input inside a snippet session ----
// Auto-completion is no longer suppressed during a session (nested session
// stack): each keystroke additionally runs findSnippet (trigger matching over
// 221 compiled snippets) + session chain field mapping. Lock the order of
// magnitude of this new hot path.

describe("perf gate: typing inside a snippet session", () => {
  it("20 keystrokes inside the session (dispatch + chain mapping + findSnippet) total < 90ms", () => {
    const view = makeTogglingView(makeState(DOC, 0));
    const end = view.state.doc.length;
    // Start a bracket session (the $$…$$ of insertMathBlock is already in the
    // document, so build the session directly)
    view.dispatch({ changes: { from: end, insert: "()" }, selection: { anchor: end + 1 } });
    const session = buildSession(end, parseReplacement("($0)$1", [], null));
    view.dispatch({ effects: setSession.of(session) });

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const at = view.state.selection.main.head;
      const t0 = performance.now();
      // The real per-keystroke pipeline: insert transaction (session chain mapping) + trigger matching
      view.dispatch({ changes: { from: at, insert: "x" }, userEvent: "input.type" });
      findSnippet(view.state, view.state.selection.main.head, "x", {
        auto: true,
        visualText: null,
      });
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    expect(view.state.doc.sliceString(end, end + 22)).toContain("xxxxxxxxxxxxxxxxxxxx");
    console.warn(`[perf] 20 keystrokes in a session total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(90);
  });
});

// ---- Enter · paragraph wall reparse anchoring ----
// One part of the real cost of Enter is covered by none of the state pipeline
// tests above: markdown parses incrementally over top-level open blocks, and a
// paragraph wall (consecutive paragraphs without blank lines) is "one block
// node", so any edit inside the block (a newline, a keystroke) makes the
// parser advance again from the block start, at a cost linear in the block
// size.
// Browser measurement (2026-09-22): Enter in a 4000-line paragraph wall ~25ms
// (2 dropped frames, felt by the user as a newline hiccup), while a document of
// the same size with a blank line every 50 lines takes 1.6ms. ensureSyntaxTree
// locks this "parse advance to the viewport" bill into the DOM-free gate:
//  - chunked anchoring is block-boundary aware: if boundary detection
//    regresses (blank lines no longer split blocks / full reparse), it first
//    grows to paragraph-wall magnitude;
//  - wall two-point anchoring is a linear upper bound: a parser that degrades
//    super-linearly in line count (e.g. fully reparsing N blocks every time)
//    is caught at 10x.

function wallDoc(lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++)
    parts.push(`段落行 ${i}:连续文字,中间没有任何空行,整篇是一个大段落块。`);
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

/** Paragraph-wall probe: the caret is fixed at the end of line 1000, Enter splits + parse advance (timed),
 *  then the inserted newline is removed again (not counted) to return to the same starting point. */
function wallEnterMedian(doc: string, times: number): number {
  const state = makeState(doc);
  ensureSyntaxTree(state, state.doc.length);
  const samples: number[] = [];
  let cur = state;
  for (let i = 0; i < times; i++) {
    const line = cur.doc.line(1000);
    const t0 = performance.now();
    cur = cur.update({
      changes: { from: line.to, insert: "\n" },
      selection: { anchor: line.to + 1 },
      userEvent: "input.type",
    }).state;
    ensureSyntaxTree(cur, cur.doc.length);
    samples.push(performance.now() - t0);
    cur = cur.update({
      changes: { from: line.to + 1, to: Math.min(line.to + 2, cur.doc.length), insert: "" },
    }).state;
    ensureSyntaxTree(cur, cur.doc.length);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(times / 2)];
}

describe("perf gate: Enter · paragraph-wall reparse (block granularity)", () => {
  it("4000-line document with a blank line every 50 lines: Enter + parse advance median < 10ms", () => {
    const median = wallEnterMedian(chunkedDoc(4000, 50), 11);
    console.warn(`[perf] chunked-4000 newline reparse median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(15); // silent ~1.3-1.7ms, 5-6x band
  });

  it("1000-line paragraph wall: Enter + parse advance median < 60ms (silent ~8.5ms, 6× band)", () => {
    const median = wallEnterMedian(wallDoc(1000), 11);
    console.warn(`[perf] wall-1000 newline reparse median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(60);
  });

  it("2000-line paragraph wall: Enter + parse advance median < 100ms (two-point linear anchoring, silent ~16ms, 6× band)", () => {
    const median = wallEnterMedian(wallDoc(2000), 11);
    console.warn(`[perf] wall-2000 newline reparse median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(100);
  });
});

// ---- Enter · list continuation in a big document ----
// The list-continuation gate used to measure only on a 1-line document, but
// the real scenario is "lists inside a big document": the tree query of
// enterContinueListItem and the O(document) decoration rebuild only show up
// there. It runs the real fallback chain (enterContinueListItem catches it
// itself) + a decoration rebuild on every iteration, same protocol as the
// "paragraph Enter" gate.

describe("perf gate: Enter · list continuation in a 900-line big document (bullet/ordered/todo)", () => {
  const cases: { name: string; seed: RegExp }[] = [
    { name: "bullet", seed: /^- 无序列表项一/ },
    { name: "ordered", seed: /^1\. 有序项/ },
    { name: "todo", seed: /^- \[ \] 待办项/ },
  ];
  for (const { name, seed } of cases) {
    it(`${name}: 20 times (Enter creates an item + filler char + decoration rebuild) total < 350ms`, () => {
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
        buildInlineDecorations({
          state: view.state,
          visibleRanges: [{ from: 0, to: view.state.doc.length }],
        });
        samples.push(performance.now() - t0);
      }
      const total = samples.reduce((a, b) => a + b, 0);
      // Enter really keeps creating items: the seed line grows from the
      // initial 1 line to 20+ lines.
      const seedCount = view.state.doc
        .toString()
        .split("\n")
        .filter((l) => seed.test(l)).length;
      expect(seedCount).toBeGreaterThan(15);
      console.warn(`[perf] 900 lines ${name} continuation total ${total.toFixed(0)}ms`);
      expect(total).toBeLessThan(350);
    });
  }
});

// ---- Enter · long ordered-list renumbering ----
// When Enter creates an item, bumpFollowingOrdered renumbers all following
// consecutive items (N edits in one transaction + a whole-document changeSet
// mapping). The longer the list, the more expensive this is, so the order of
// magnitude is locked to prevent the renumbering from degenerating into
// per-item dispatch or a full-document remap.

describe("perf gate: Enter · long renumbering of a 30-item ordered list", () => {
  it("20 times (Enter at the end of item 1, 29 items renumbered) total < 100ms", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`${i}. 有序列表第 ${i} 项,内容若干`);
    const view = makeTogglingView(makeState(lines.join("\n"), 0));
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      view.dispatch({ selection: EditorSelection.cursor(line.to) });
      const t0 = performance.now();
      if (!enterContinueListItem(view))
        throw new Error("the ordered list continuation was not picked up");
      samples.push(performance.now() - t0);
      // Put the caret back at the end of item 1 (the newly created item 2), so
      // the next round keeps renumbering from the front
      view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).to) });
    }
    const total = samples.reduce((a, b) => a + b, 0);
    // The renumbering really happened: the last item's number was pushed to 50
    // (30 items + 20 inserted items).
    expect(view.state.doc.toString()).toContain("50. 有序列表第 30 项");
    console.warn(`[perf] ordered list of 30 items renumbering total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(100);
  });
});

// ---- Enter · automatic heading renumbering scan (per-keystroke insurance for an opt-in feature) ----
// When autoNumberHeadings is on, renumberHeadings does a whole-document line
// scan (fence scan + a regex per line) after every document change. This is a
// fixed "O(document) per keystroke" cost, whose order of magnitude is watched
// here; a functional assertion also guards against the scan missing headings.

describe("perf gate: whole-document scan for automatic heading numbering (900 lines)", () => {
  it("20 scans (the numbering is already aligned, a pure scan) total < 80ms", () => {
    const view = makeTogglingView(makeState(DOC, 0));
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      renumberHeadings(view);
      samples.push(performance.now() - t0);
    }
    const total = samples.reduce((a, b) => a + b, 0);
    console.warn(`[perf] numbering scan (no change) total ${total.toFixed(0)}ms`);
    expect(total).toBeLessThan(80);
  });

  it("a missing number is filled in exactly (functional anchor)", () => {
    const stale = DOC.replace("## 3 章节", "## 章节");
    const view = makeTogglingView(makeState(stale, 0));
    renumberHeadings(view);
    expect(view.state.doc.toString()).toContain("## 3 章节");
  });
});

// ---- Callout blocks · fixed per-keystroke cost ----
// calloutRegions does one O(lines) line scan per document generation (math
// regions go through the shared memo, the fence scan is the same as
// renumber's); with dense blocks the line decorations are assembled linearly
// per block × line. Two things are locked here: the constant of the pure scan,
// and the end-to-end per-keystroke pipeline of typing inside a block (the
// collectBlockStatics state field on first build + a full inline viewport
// rebuild).

/** Callout-dense document: one titled block per section (containing a heading/paragraph/math block) + one section of body text. */
function calloutDoc(sections: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= sections; i++) {
    parts.push(`::: 参考 ${i}`);
    parts.push(`## ${i} 定理`);
    parts.push("块内段落,讲一些泛函分析的基本概念,长度中等偏长一些。");
    parts.push("$$");
    parts.push(`T_{${i}}(x) = \\int_K x(y)\\,d\\mu(y)`);
    parts.push("$$");
    parts.push(":::");
    parts.push("");
    parts.push(`## ${i} 正文节`);
    parts.push("");
    parts.push("正文段落,与块内内容互不隶属。");
    parts.push("");
  }
  return parts.join("\n");
}

describe("perf gate: callout scanning (60 blocks, ~500 lines)", () => {
  const CALLOUT_DOC = calloutDoc(60);
  const state = makeState(CALLOUT_DOC, 0);

  it("region scan (a pure line scan, reusing the already-computed fences/math) median < 0.5ms", () => {
    const fences = fenceStateScan(state.doc);
    const maths = mathRegions(state);
    const median = medianOf(() => {
      const t0 = performance.now();
      computeCalloutRegions(state.doc, fences, maths);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] callout region scan median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(0.5);
  });

  it("20 keystrokes typing inside a block (state field + full inline rebuild) total < 100ms, single keystroke median < 4ms", () => {
    const line = state.doc.line(3); // the content paragraph line of the first block
    const at = line.from + 4;
    let cur = makeState(CALLOUT_DOC, at);
    const perKey: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      cur = cur.update({ changes: { from: at, insert: "字" } }).state;
      buildInlineDecorations({ state: cur, visibleRanges: [{ from: 0, to: cur.doc.length }] });
      perKey.push(performance.now() - t0);
    }
    const total = perKey.reduce((a, b) => a + b, 0);
    perKey.sort((a, b) => a - b);
    const median = perKey[Math.floor(perKey.length / 2)];
    console.warn(
      `[perf] typing inside a callout block total ${total.toFixed(0)}ms, median ${median.toFixed(2)}ms`,
    );
    expect(total).toBeLessThan(100);
    expect(median).toBeLessThan(4);
  });
});

// ---- callout anchor scanning (the anchor inserted by the ⌘⇧B select-insert: elastic matching of heading × viewport) ----
// Every titled callout has to find an occurrence of "the same text" in the
// viewport text — cost = number of headings × viewport text, and a hit still
// has to pass the callout region/exclusion filter. Here the stress shape is
// "the body text repeats the heading text" (hits maximized) to lock the
// order of magnitude; viewport = whole document is the upper bound.

/** Anchor-dense document: one titled block per section; the heading text repeats in the body paragraphs. */
function anchorDoc(sections: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= sections; i++) {
    parts.push(`::: 参考 ${i}`);
    parts.push(`## ${i} 定理`);
    parts.push("块内段落,讲一些泛函分析的基本概念,长度中等偏长一些。");
    parts.push(":::");
    parts.push("");
    parts.push(`## ${i} 正文节`);
    parts.push("");
    parts.push(`正文段落提到 参考 ${i} 这个说法,并在别处又提 参考 ${i} 一次。`);
    parts.push("");
  }
  return parts.join("\n");
}

describe("perf gate: callout anchor scanning (60 titled blocks, the body text hits repeatedly)", () => {
  const ANCHOR_DOC = anchorDoc(60);
  const state = makeState(ANCHOR_DOC, 0);

  it("whole-document viewport inline decoration rebuild (the anchor scan is included) median < 5ms", () => {
    const median = medianOf(() => {
      const t0 = performance.now();
      buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] anchored document inline decoration median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(5);
  });

  it("20 per-keystroke inputs (update + decoration rebuild) total < 150ms, single keystroke median < 6ms", () => {
    const line = state.doc.line(8); // the first body-text hit line
    const at = line.from + 6;
    let cur = makeState(ANCHOR_DOC, at);
    const perKey: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      cur = cur.update({ changes: { from: at, insert: "字" } }).state;
      buildInlineDecorations({ state: cur, visibleRanges: [{ from: 0, to: cur.doc.length }] });
      perKey.push(performance.now() - t0);
    }
    const total = perKey.reduce((a, b) => a + b, 0);
    perKey.sort((a, b) => a - b);
    const median = perKey[Math.floor(perKey.length / 2)];
    console.warn(
      `[perf] anchored document per-keystroke total ${total.toFixed(0)}ms, median ${median.toFixed(2)}ms`,
    );
    expect(total).toBeLessThan(150);
    expect(median).toBeLessThan(6);
  });
});

// ---- cross-file todo sync · per-key intent extraction (the fixed cost of dailySyncExtension) ----
// The line-level diff in the updateListener: with no intent it only pays
// "parse the changed line + compare the identity text", and a link hit adds
// one block-root walk-up (bounded step count). What is measured here is
// intentsForRange itself — the incremental cost of the listener over the
// existing pipeline; a functional anchor guards against "measuring a no-op".

describe("perf gate: cross-file todo sync intent extraction (900 lines)", () => {
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

  /** Simulate one keystroke: return the time of the "extraction" step (the update cost is not measured). */
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

  const todoPos = DOC.indexOf("待办项 60") + 7; // middle of the todo line content
  const nestedPos = DOC.indexOf("嵌套项 60") + 4; // the indented child line (triggers the block-root walk-up)

  it("per-key extraction without links (body / todo line / indented child line) median < 2.5ms (silent ~0.5ms, including GC pressure, 6× band)", () => {
    for (const pos of [todoPos, nestedPos]) {
      const state = makeState(DOC, pos);
      const median = medianOf(() => keystrokeExtract(state, [], true), 200);
      console.warn(`[perf] daily extraction (no links) median ${median.toFixed(4)}ms`);
      expect(median).toBeLessThan(2.5); // silent ~0.45ms (including the GC pressure of a fresh transaction per round), ~6x calibration band
    }
  });

  it("per-key extraction with 3 links median < 2.5ms (block-root walk-up + text comparison, the same magnitude as without links)", () => {
    const links = linksFor(["待办项 5", "已完成项 250", "待办项 499"]);
    for (const pos of [todoPos, nestedPos]) {
      const state = makeState(DOC, pos);
      const median = medianOf(() => keystrokeExtract(state, links, true), 200);
      console.warn(`[perf] daily extraction (3 links) median ${median.toFixed(4)}ms`);
      expect(median).toBeLessThan(2.5); // same magnitude as with no links: the text comparison is the main cost
    }
  });

  it("functional anchor: a checkbox flip in the 900-line document is really captured", () => {
    const before = DOC.indexOf("- [ ] 待办项 60");
    const lineEnd = before + "- [ ] 待办项 60".length;
    const old = makeState(DOC, before);
    const tr = old.update({
      changes: { from: before + 3, to: before + 4, insert: "x" },
      userEvent: "input.bnote-todo",
    });
    const intents: unknown[] = [];
    tr.changes.iterChangedRanges((a, b, c, d) =>
      intents.push(
        ...intentsForRange(
          tr.startState.doc,
          tr.state.doc,
          a,
          b,
          c,
          d,
          linksFor(["待办项 60"]),
          true,
        ),
      ),
    );
    expect(intents).toContainEqual({
      type: "mirror",
      linkId: "l0",
      rootHint: tr.startState.doc.lineAt(before).number,
      renamedTo: "待办项 60",
    });
    expect(lineEnd).toBeGreaterThan(0);
  });
});

// ---- cross-file todo sync · visual markers for linked todos (the fixed cost of dailyMarksExtension) ----
// The decorations are rebuilt only on two signals (document/viewport change,
// link store change), and each rebuild scans the viewport line by line. The
// gate is calibrated at the upper bound: viewport = whole document (~900
// lines), 120 links (the real vault has 6).

describe("perf gate: visual marker build for todo links (900 lines, 120 links)", () => {
  const DAILY = "/vault/Daily/2026-09-21.md";
  const links: DailyLink[] = Array.from({ length: 120 }, (_, i) => ({
    id: `m${i}`,
    kind: "copied" as const,
    day: "2026-09-21",
    srcPath: "/vault/note.md",
    dailyPath: DAILY,
    text: i < 60 ? `待办项 ${i + 1}` : `不存在的待办 ${i}`,
    srcLine: 1,
    dailyLine: 1,
  }));
  const state = makeState(DOC, 0);
  const view = { state, visibleRanges: [{ from: 0, to: state.doc.length }] };
  const ctx = { path: "/vault/note.md", links, todayDailyPath: DAILY };

  it("whole-document viewport rebuild median < 1.5ms", () => {
    const median = medianOf(() => {
      const t0 = performance.now();
      buildDailyMarks(view, ctx);
      return performance.now() - t0;
    }, 30);
    console.warn(`[perf] daily mark build median ${median.toFixed(3)}ms`);
    // Silent ~0.15ms, the budget is calibrated at ~10x. The per-line text
    // comparison is the entire cost — if it ever degenerates into "search
    // the whole document for each link's root" (an O(lines) scan like
    // resolveRootLine), the order of magnitude is caught here.
    expect(median).toBeLessThan(1.5);
  });

  it("functional anchor: all 60 matching todo lines in the document are marked", () => {
    const set = buildDailyMarks(view, ctx);
    let marked = 0;
    set.between(0, state.doc.length, () => {
      marked++;
    });
    expect(marked).toBe(60);
  });
});

// ---- today's footprint · block diff and inclusion markers (the fixed cost of footprint) ----
// diffBlocks does a "split into blocks + compare identity sets" pass over the
// whole file on every dirty refresh; buildFootprintMarks is isomorphic to
// dailyMarks (viewport line by line + set hits). The budget is calibrated the
// same way at ~10x.

describe("perf gate: today's footprint block diff (900 lines)", () => {
  it("whole-file diff (the baseline = an old version in which half the blocks already exist) median < 3ms", () => {
    const lines = DOC.split("\n");
    // Baseline: every other paragraph is removed (creating the real work
    // surface of ~300 "added today" blocks)
    const baselineLines = lines.filter((l, i) => i % 2 === 0 || l === "");
    const baseline = baselineLines.join("\n");
    const median = medianOf(() => {
      const t0 = performance.now();
      diffBlocks(baseline, DOC);
      return performance.now() - t0;
    }, 30);
    console.warn(`[perf] footprint diff median ${median.toFixed(3)}ms`);
    // Silent ~0.5ms, the budget is calibrated at ~6x. Block splitting is O(lines)
    // and the identity is a Map hit — if it ever degenerates into "a linear
    // search of the whole baseline per block", the order of magnitude is
    // caught here.
    expect(median).toBeLessThan(3);
  });

  it("functional anchor: the removed blocks really come out of the diff (todo blocks do not count)", () => {
    const baselineLines = DOC.split("\n").filter((l, i) => i % 2 === 0 || l === "");
    const added = diffBlocks(baselineLines.join("\n"), DOC);
    // 4 blocks per section, the list cluster (with todos) is excluded, and half
    // of the single-line blocks share a key with the baseline — ~90 blocks are
    // the baseline.
    expect(added.length).toBeGreaterThan(60);
  });
});

describe("perf gate: today's footprint inclusion marker build (900 lines, ~180 blocks)", () => {
  const state = makeState(DOC, 0);
  const view = { state, visibleRanges: [{ from: 0, to: state.doc.length }] };
  const blocks = diffBlocks("", DOC); // all document blocks as "added today"

  it("whole-document viewport rebuild median < 1.5ms", () => {
    const median = medianOf(() => {
      const t0 = performance.now();
      buildFootprintMarks(view, blocks);
      return performance.now() - t0;
    }, 30);
    console.warn(`[perf] footprint mark build median ${median.toFixed(3)}ms`);
    expect(median).toBeLessThan(1.5);
  });

  it("functional anchor: every block's first line is marked", () => {
    const set = buildFootprintMarks(view, blocks);
    let marked = 0;
    set.between(0, state.doc.length, () => {
      marked++;
    });
    expect(marked).toBe(blocks.length);
  });
});

describe("perf gate: today's footprint block markdown rendering (the block-level widget rebuild surface)", () => {
  // The footprint region repaints completely on every revision/collapse change
  // (lezer parsing + KaTeX in render.ts); the frequency is at the watcher
  // debounce level (seconds), not per keystroke. What is locked here is the
  // order of magnitude of a full-region render, to prevent the renderer from
  // degenerating into something like rebuilding a parser per line.
  it("a full render of every block in the document (including KaTeX) median < 12ms", () => {
    const blocks = diffBlocks("", DOC);
    const median = medianOf(() => {
      const t0 = performance.now();
      for (const b of blocks) renderBlockHtml(b.text);
      return performance.now() - t0;
    }, 15);
    console.warn(`[perf] footprint markdown render median ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(12);
  });

  it("functional anchor: headings and lists render with the editor's own class names", () => {
    const html = renderBlockHtml("## 章节\n\n- 列表项\n");
    expect(html).toContain("md-h2");
    expect(html).toContain("md-list-line");
  });
});

// ---- project cards: todo parsing (runs on every card preview render) ----

describe("perf gate: project card todo parsing", () => {
  it("parsing a 1000-line project document median < 1.5ms", () => {
    // The left and right preview cards scan the whole project document on
    // every render; project files are calibrated at a 1000-line cap (in
    // practice only a few dozen lines), so order-of-magnitude regressions
    // (per-character regexes, a second traversal) are caught.
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`- [ ] 任务 ${i}`, "普通正文行");
    const text = lines.join("\n");
    const median = medianOf(() => {
      const t0 = performance.now();
      const todos = projectTodos(text);
      if (todos.length !== 500) throw new Error("the parser missed an entry");
      return performance.now() - t0;
    }, 30);
    console.warn(`[perf] project todo parsing median ${median.toFixed(3)}ms`);
    expect(median).toBeLessThan(1.5);
  });
});

// ---- incremental math / callout fields: the no-O(document) keystroke rule ----

describe("perf gate: incremental math/callout fields", () => {
  // 600 sections × 2 inline formulas = 1200 regions, 2400 lines. A per-keystroke
  // full scan here is the class of regression this gate exists for.
  const parts: string[] = [];
  for (let i = 0; i < 600; i++) {
    parts.push(`## 章节 ${i}`);
    parts.push("段落文字,讲一些线性变换的基本概念,长度中等偏长一些。");
    parts.push(`公式 $a_{${i}} = \\frac{x}{y}$ 与 $b_{${i}} = \\sqrt{z}$。`);
    parts.push("");
  }
  const FORMULA_DOC = parts.join("\n");
  const caret = FORMULA_DOC.indexOf("$a_{300}") + 3;

  function formulaState(): EditorState {
    const state = EditorState.create({
      doc: FORMULA_DOC,
      extensions: [mathRegionsField, calloutRegionsField],
      selection: EditorSelection.cursor(caret),
    });
    // Force the initial scans outside any measured window.
    state.field(mathRegionsField);
    state.field(calloutRegionsField);
    return state;
  }

  it("30 ordinary keystrokes inside a formula never rescan math or callouts", () => {
    let state = formulaState();
    clearPerf();
    for (let i = 0; i < 30; i++) {
      const head = state.selection.main.head;
      state = state.update({
        changes: { from: head, insert: "x" },
        selection: { anchor: head + 1 },
      }).state;
    }
    expect(state.field(mathRegionsField).length).toBe(1200);
    const scans = perfStats().filter((s) => s.name === "math.scan" || s.name === "callout.scan");
    expect(scans).toEqual([]);
  });

  it("a dollar keystroke rescans exactly once per field", () => {
    let state = formulaState();
    clearPerf();
    const head = state.selection.main.head;
    state = state.update({
      changes: { from: head, insert: "$" },
      selection: { anchor: head + 1 },
    }).state;
    expect(perfStats().find((s) => s.name === "math.scan")?.n).toBe(1);
    expect(perfStats().find((s) => s.name === "callout.scan")?.n).toBe(1);
  });

  it("mapping 1200 regions through one edit median < 2ms", () => {
    const state = formulaState();
    const median = medianOf(() => {
      const t0 = performance.now();
      const next = state.update({
        changes: { from: state.selection.main.head, insert: "x" },
        selection: { anchor: state.selection.main.head + 1 },
      }).state;
      if (next.field(mathRegionsField).length !== 1200) throw new Error("regions lost");
      return performance.now() - t0;
    }, 30);
    console.warn(`[perf] incremental math field map median ${median.toFixed(3)}ms`);
    expect(median).toBeLessThan(2);
  });

  it("the callout field maps a body edit without rebuilding the region list", () => {
    const doc = "::: 标题\n" + "正文行\n".repeat(100) + ":::";
    let state = EditorState.create({
      doc,
      extensions: [mathRegionsField, calloutRegionsField],
      selection: EditorSelection.cursor(10),
    });
    const before = state.field(calloutRegionsField);
    clearPerf();
    const head = state.selection.main.head;
    state = state.update({
      changes: { from: head, insert: "字" },
      selection: { anchor: head + 1 },
    }).state;
    expect(state.field(calloutRegionsField)[0].to).toBe(before[0].to + 1);
    expect(calloutRegions(state)[0].title).toBe("标题");
    expect(perfStats().find((s) => s.name === "callout.scan")).toBeUndefined();
  });
});

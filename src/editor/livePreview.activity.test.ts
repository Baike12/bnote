import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  buildInlineDecorations,
  blockDecorationsField,
  selectionAffectsDecos,
} from "./livePreview";
import {
  ListBulletWidget,
  MathInlinePreviewWidget,
  MathPreviewWidget,
  MathWidget,
  TaskCheckboxWidget,
} from "./widgets";

const DOC = [
  "- [ ] task item",
  "- [x] done item",
  "- bullet item",
  "  - nested item",
  "1. ordered item",
].join("\n");

function decosAt(state: EditorState, from: number, to: number) {
  const view = { state, visibleRanges: [{ from: 0, to: state.doc.length }] };
  const set = buildInlineDecorations(view);
  const out: { from: number; to: number; deco: unknown }[] = [];
  set.between(from, to, (f, t, deco) => {
    out.push({ from: f, to: t, deco });
  });
  return out;
}

function widgetOf(entry: { deco: unknown }): unknown {
  const spec = (entry.deco as { spec?: { widget?: unknown } }).spec;
  return spec?.widget;
}

function makeState(selectionCol: { line: number; col: number }): EditorState {
  const created = EditorState.create({
    doc: DOC,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
  ensureSyntaxTree(created, created.doc.length);
  const line = created.doc.line(selectionCol.line);
  return created
    .update({ selection: EditorSelection.cursor(line.from + selectionCol.col) })
    .state;
}

/**
 * 锁住 live preview 的「token 范围活动规则」：列表标记只在光标落进标记
 * 字符本身时才翻回源码，光标在行上其他位置时保持渲染态。j/k 的像素锚定
 * 落点（verticalMotion）依赖这条规则的几何稳定性。
 */
describe("livePreview 列表标记的 token 活动规则", () => {
  const line1 = () => DOC.split("\n")[0];

  it("光标在正文上（标记范围外）：任务行保持渲染态（checkbox + 隐藏 `- `）", () => {
    const state = makeState({ line: 1, col: 6 });
    const entries = decosAt(state, 0, line1().length + 1);
    const widgets = entries.map(widgetOf);
    expect(widgets.some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    // `- ` 被空替换隐藏（li-t 的 mark 槽收进 checkbox 前的空间）。
    expect(
      entries.some(
        (e) => e.from === 0 && widgetOf(e) === undefined && e.to === 2,
      ),
    ).toBe(true);
  });

  it("光标在 `[ ]` 内：checkbox 翻回源码，`- ` 仍隐藏", () => {
    const state = makeState({ line: 1, col: 3 });
    const entries = decosAt(state, 0, line1().length + 1);
    expect(entries.map(widgetOf).some((w) => w instanceof TaskCheckboxWidget)).toBe(false);
    expect(entries.some((e) => e.from === 0 && e.to === 2 && widgetOf(e) === undefined)).toBe(
      true,
    );
  });

  it("光标在行首：`-` 翻回源码，checkbox 保持渲染态", () => {
    const state = makeState({ line: 1, col: 0 });
    const entries = decosAt(state, 0, line1().length + 1);
    expect(entries.map(widgetOf).some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    expect(entries.some((e) => e.from === 0 && e.to === 2 && widgetOf(e) === undefined)).toBe(
      false,
    );
  });

  it("无序列表：光标在标记外渲染 bullet，压在 `-` 上翻回源码", () => {
    const line3From = DOC.split("\n").slice(0, 2).join("\n").length + 1;
    const rendered = makeState({ line: 3, col: 5 });
    expect(
      decosAt(rendered, line3From, line3From + 15)
        .map(widgetOf)
        .some((w) => w instanceof ListBulletWidget),
    ).toBe(true);
    const active = makeState({ line: 3, col: 0 });
    expect(
      decosAt(active, line3From, line3From + 15)
        .map(widgetOf)
        .some((w) => w instanceof ListBulletWidget),
    ).toBe(false);
  });

  it("嵌套项：前导缩进空格在活动行也被隐藏（布局不随光标位移的另一半）", () => {
    const state = makeState({ line: 4, col: 6 });
    const nestedFrom = DOC.split("\n").slice(0, 3).join("\n").length + 1;
    const entries = decosAt(state, nestedFrom, nestedFrom + 4);
    // 行首两个空格被 replace 隐藏，li-i2 行装饰负责缩进。
    expect(entries.some((e) => e.from === nestedFrom && e.to === nestedFrom + 2)).toBe(true);
  });

  it("有序列表：数字标记两种状态下都保留原文（无几何翻转）", () => {
    const orderedFrom = DOC.split("\n").slice(0, 4).join("\n").length + 1;
    // 不变量：任何状态下都没有 replace 装饰盖住数字标记——有序行的几何
    // 在光标进出时稳定（这也是 .li-o 槽宽恒定的前提）。
    const bareReplaceOverMark = (state: EditorState) =>
      decosAt(state, orderedFrom, orderedFrom + 2).filter(
        (e) =>
          e.from !== e.to &&
          e.from < orderedFrom + 2 &&
          e.to > orderedFrom &&
          !(e.deco as { spec?: { widget?: unknown } }).spec?.widget &&
          !(e.deco as { spec?: { class?: string } }).spec?.class,
      );
    expect(bareReplaceOverMark(makeState({ line: 5, col: 0 }))).toEqual([]);
    expect(bareReplaceOverMark(makeState({ line: 5, col: 4 }))).toEqual([]);
    // 渲染态下数字标记带 md-listmark 着色。
    const rendered = decosAt(makeState({ line: 5, col: 6 }), orderedFrom, orderedFrom + 2);
    expect(rendered.some((e) => e.from === orderedFrom && e.to === orderedFrom + 2)).toBe(true);
  });
});

/**
 * 空列表项的「文本锚点」规则：marker 的替换装饰若吞掉行尾空白，整行就没有
 * 任何文本节点，WebKit 给落在项首的光标算不出矩形（绘制退化到行内容边缘，
 * 即 Enter 续行后光标闪到行首）。光标停在项首时必须保留行尾空格。
 */
describe("空列表项的文本锚点（keepMarkerTrailingSpace）", () => {
  const makeDocState = (doc: string, pos: number) => {
    const created = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    return created.update({ selection: EditorSelection.cursor(pos) }).state;
  };
  const covered = (entries: { from: number; to: number }[], pos: number) =>
    entries.some((e) => e.from !== e.to && e.from <= pos && e.to > pos);

  it("空待办项 `- [ ] ` 光标在项首：checkbox 不吞行尾空格", () => {
    const entries = decosAt(makeDocState("- [ ] ", 6), 0, 8);
    // checkbox 仍在（[2,5)），但行尾空格 [5,6) 保持可见。
    expect(entries.map(widgetOf).some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    expect(covered(entries, 4)).toBe(true);
    expect(covered(entries, 5)).toBe(false);
  });

  it("空待办项光标在行首：checkbox 照常吞空格（行首有 raw `-` 作锚点）", () => {
    const entries = decosAt(makeDocState("- [ ] ", 0), 0, 8);
    expect(covered(entries, 5)).toBe(true);
  });

  it("非空待办项 `- [ ] foo` 光标在项首：空格照常吞掉（正文文本节点即锚点）", () => {
    const entries = decosAt(makeDocState("- [ ] foo", 6), 0, 10);
    expect(entries.map(widgetOf).some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    expect(covered(entries, 5)).toBe(true);
  });

  it("空无序项 `- ` 光标在项首：bullet 不吞行尾空格", () => {
    const entries = decosAt(makeDocState("- ", 2), 0, 3);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(true);
    expect(covered(entries, 1)).toBe(false);
  });
});

/**
 * 空 bullet 行的 setext 歧义：段落后的裸 `- ` 行被解析器归为 SetextHeading2
 * （CommonMark 里两种读法都成立时 setext 赢，树里没有 ListMark），渲染层必须
 * 按空列表项处理——否则 Cmd+; 在段落后切出的空项永远不渲染，输入第一个字符
 * 时解析翻转、整行重排，读作“切换不生效 + 输入卡顿”。
 */
describe("段落后空 bullet 行的 setext 歧义（decorateSetextDash）", () => {
  const PARAG = "段落行在此。";
  const doc = `${PARAG}\n- \n`;
  const dashFrom = PARAG.length + 1; // `- ` 行起点

  const makeDocState = (text: string, pos: number) => {
    const created = EditorState.create({
      doc: text,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    return created.update({ selection: EditorSelection.cursor(pos) }).state;
  };
  const covered = (entries: { from: number; to: number }[], pos: number) =>
    entries.some((e) => e.from !== e.to && e.from <= pos && e.to > pos);
  const listLineDeco = (entries: { deco: unknown }[]) =>
    entries.some(
      (e) =>
        (e.deco as { spec?: { class?: string } }).spec?.class?.includes("li-b") === true,
    );

  it("树里是 SetextHeading2 时仍渲染 bullet + li-b 行装饰（立即可见）", () => {
    // 光标在行尾（toggleList 落点），树是 SetextHeading2 而不是 List。
    const state = makeDocState(doc, dashFrom + 2);
    const entries = decosAt(state, dashFrom, dashFrom + 3);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(true);
    expect(listLineDeco(entries)).toBe(true);
  });

  it("光标压在 `-` 上：翻回源码（与 ListMark 同一活动规则），行装饰保持", () => {
    const state = makeDocState(doc, dashFrom);
    const entries = decosAt(state, dashFrom, dashFrom + 3);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(false);
    expect(listLineDeco(entries)).toBe(true);
  });

  it("空项光标在行尾：尾随空格保留作文本锚点（keepTrailingSpace 同规则）", () => {
    const state = makeDocState(doc, dashFrom + 2);
    const entries = decosAt(state, dashFrom, dashFrom + 3);
    expect(covered(entries, dashFrom)).toBe(true); // `-` 被 bullet 吞掉
    expect(covered(entries, dashFrom + 1)).toBe(false); // 空格保留可见
  });

  it("真 setext（下划线多于一个 `-`）不受影响", () => {
    const state = makeDocState("标题行\n---\n", 4);
    const entries = decosAt(state, 4, 8);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(false);
  });

  it("键入正文后解析翻转成真 ListMark：bullet 同起点覆盖标记（无缝接管）", () => {
    // 光标都在行尾（toggle 与打字的自然姿态）。行尾空格的归属由共享的
    // keepMarkerTrailingSpace 锚点规则决定（空项保留、有正文吞掉，≤1 空格
    // 宽的既定缝隙），这里锁的是两种树态下 bullet 都从 dash 起点接管。
    const rendered = decosAt(makeDocState(doc, dashFrom + 2), dashFrom, dashFrom + 3);
    const typed = decosAt(
      makeDocState(`${PARAG}\n- 字\n`, dashFrom + 3),
      dashFrom,
      dashFrom + 4,
    );
    const bulletFrom = (entries: ReturnType<typeof decosAt>) => {
      const hit = entries.find((e) => widgetOf(e) instanceof ListBulletWidget);
      return hit ? hit.from : null;
    };
    expect(bulletFrom(typed)).toBe(dashFrom);
    expect(bulletFrom(typed)).toBe(bulletFrom(rendered));
  });
});

/**
 * 选区触发器（selectionAffectsDecos）：标记槽（列表标记/任务括号）的活动规则
 * 依赖同行内的光标位置，同行内跨槽移动必须触发重建——否则 vim 的 0/A/$、
 * Esc 后的光标落点会把裸 `-`/裸 `[ ]` 永久留在屏上（或反过来 widget 盖住
 * 正在编辑的标记）。快路径不变：槽外的同行纯移动仍然必须返回 false。
 */
describe("选区触发器:同行内跨标记槽移动必须重建", () => {
  const DOC2 = [
    "- 随机变量第一行的内容",
    "  - [ ] 嵌套任务行",
    "普通段落文本行,没有标记。",
    "- ",
    "1. 有序项内容",
  ].join("\n");

  const stateAt = (line: number, col: number) => {
    const created = EditorState.create({
      doc: DOC2,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    const l = created.doc.line(line);
    return created.update({ selection: EditorSelection.cursor(l.from + col) }).state;
  };
  const moves = (from: { line: number; col: number }, to: { line: number; col: number }) =>
    selectionAffectsDecos(stateAt(from.line, from.col), stateAt(to.line, to.col));

  it("回归主形态:normal 压在 `-` 上(源码态)→ A 跳行尾,同行必须触发重建", () => {
    // 修复前这条返回 false:插件跳过重建,裸 `-` 留在屏上直到跨行/编辑
    expect(moves({ line: 1, col: 0 }, { line: 1, col: 10 })).toBe(true);
  });

  it("反向同样触发:行尾 → 0 回到标记上", () => {
    expect(moves({ line: 1, col: 10 }, { line: 1, col: 0 })).toBe(true);
  });

  it("任务行:光标压 `[ ]` ⇄ 行尾,双向都触发", () => {
    expect(moves({ line: 2, col: 6 }, { line: 2, col: 12 })).toBe(true);
    expect(moves({ line: 2, col: 12 }, { line: 2, col: 6 })).toBe(true);
  });

  it("空列表项 `- `:任何同行移动都触发(尾随空白的保留随光标翻转)", () => {
    expect(moves({ line: 4, col: 0 }, { line: 4, col: 2 })).toBe(true);
    expect(moves({ line: 4, col: 2 }, { line: 4, col: 0 })).toBe(true);
  });

  it("快路径不变:槽外的同行纯移动(普通行/列表行正文内)恒 false", () => {
    expect(moves({ line: 3, col: 2 }, { line: 3, col: 6 })).toBe(false);
    expect(moves({ line: 1, col: 4 }, { line: 1, col: 10 })).toBe(false);
    expect(moves({ line: 5, col: 5 }, { line: 5, col: 8 })).toBe(false);
  });

  it("触发器与真实装饰一致:触发的那对状态,新建装饰确实不同", () => {
    // 锁住 bug 的类别:trigger true ⟺ 两态各自全新构建的装饰在标记区不同。
    // 若有人改了活动规则让两态装饰相同,这条会先红,提示触发器可以放宽。
    const onDash = stateAt(1, 0);
    const atEnd = stateAt(1, 10);
    const bulletOf = (state: EditorState) => {
      const set = buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
      let has = false;
      set.between(0, 2, (_f, _t, deco) => {
        if ((deco as { spec?: { widget?: unknown } }).spec?.widget instanceof ListBulletWidget) {
          has = true;
        }
      });
      return has;
    };
    expect(bulletOf(onDash)).toBe(false); // 压在标记上:源码态
    expect(bulletOf(atEnd)).toBe(true); // 行尾:渲染态
    expect(selectionAffectsDecos(onDash, atEnd)).toBe(true);
  });
});

/**
 * 公式块「编辑态实时预览」的块级装饰规则。块级 widget 的规范锚点是行首：
 * 锚在行尾（换行符之前）CM6 会把该行劈成两行，DOM 里多出一个不属于任何
 * 文档行的幽灵空行（预览与下文之间的大间隙）。blockDecorationsField 是
 * 纯 RangeSet，node 环境即可断言锚点位置。
 */
describe("数学预览的块级锚点（blockDecorationsField）", () => {
  /** "a\n$$\nx = 1\n$$\nb\n":region 2..13(行 2-4),下一行行首 14。 */
  function blockState(doc: string, pos: number) {
    const created = EditorState.create({ doc, extensions: [blockDecorationsField] });
    return created.update({ selection: EditorSelection.cursor(pos) }).state;
  }

  function blockPoints(state: EditorState) {
    const { decos } = state.field(blockDecorationsField);
    const out: { from: number; to: number; widget: unknown }[] = [];
    decos.between(0, state.doc.length, (from, to, deco) => {
      const w = (deco as { spec?: { widget?: unknown } }).spec?.widget;
      if (w) out.push({ from, to, widget: w });
    });
    return out;
  }

  it("预览 widget 锚在下一行行首，不是区域末行行尾", () => {
    const state = blockState("a\n$$\nx = 1\n$$\nb\n", 6);
    const previews = blockPoints(state).filter((p) => p.widget instanceof MathPreviewWidget);
    expect(previews).toEqual([{ from: 14, to: 14, widget: expect.any(MathPreviewWidget) }]);
    // 编辑态：整块不折叠成渲染 widget。
    expect(blockPoints(state).some((p) => p.widget instanceof MathWidget)).toBe(false);
  });

  it("空内容不出预览：插入公式块后下方不凭空多出空白", () => {
    const state = blockState("a\n$$\n\n$$\nb\n", 5);
    expect(blockPoints(state).some((p) => p.widget instanceof MathPreviewWidget)).toBe(false);
  });

  it("区域到文档末尾：锚在 doc.length（合法的块级 widget 位置）", () => {
    const state = blockState("a\n$$\nx = 1\n$$", 6);
    const previews = blockPoints(state).filter((p) => p.widget instanceof MathPreviewWidget);
    expect(previews).toEqual([{ from: 13, to: 13, widget: expect.any(MathPreviewWidget) }]);
  });

  it("光标离开区域：整块折叠为 MathWidget，无预览", () => {
    const state = blockState("a\n$$\nx = 1\n$$\nb\n", 0);
    const points = blockPoints(state);
    expect(points.some((p) => p.widget instanceof MathPreviewWidget)).toBe(false);
    expect(points.some((p) => p.widget instanceof MathWidget && p.from === 2 && p.to === 13)).toBe(
      true,
    );
  });

  it("闭合 $$ 同行带正文：块 widget 只盖到定界符，不吞掉后面的正文", () => {
    // "a\n$$\nx = 1\n$$后文\n"：区域 2..13，闭合行 11..16——整行替换会让
    // "后文" 从 DOM 里消失(被 widget 盖住),光标落在那里却看不见字。
    const state = blockState("a\n$$\nx = 1\n$$后文\n", 0);
    const block = blockPoints(state).find((p) => p.widget instanceof MathWidget);
    expect(block).toEqual({ from: 2, to: 13, widget: expect.any(MathWidget) });
  });
});

/**
 * 行内公式的渲染规则（buildInlineDecorations）。
 *
 * 活动规则按**正文**判定（context.ts 的 selectionInMathBody）：`$f(x)$` 占
 * 3..9，位置 3（开符之前）与 9（闭合符之后）都在 widget 之外——那里已经是
 * 正文，公式照常渲染，光标落在渲染结果之后（Tab 跳出、打完闭合 `$` 的自然
 * 位置）。只有严格内部的 4..8 展开源码。
 *
 * 编辑时**只显示源码**：不再在闭合定界符后插一份渲染副本（同一公式的第二
 * 遍渲染）。一行里有两个以上行内公式时，那份副本正好挤在相邻公式的渲染
 * 旁边（用户报的「渲染重合」），而且宽度每次击键都变、整行跟着重排。
 *
 * 夹具 "前文 $f(x)$ 后文"：`$f(x)$` 占 3..9，闭合定界符在 8。
 */
describe("行内公式的渲染规则（buildInlineDecorations）", () => {
  const DOC_MATH = "前文 $f(x)$ 后文";

  function inlinePoints(doc: string, pos: number) {
    const created = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    const state = created.update({ selection: EditorSelection.cursor(pos) }).state;
    const set = buildInlineDecorations({
      state,
      visibleRanges: [{ from: 0, to: state.doc.length }],
    });
    // mark 装饰(widget 为 undefined)与 replace 装饰一起收,才能断言「只有源码高亮」
    const out: { from: number; to: number; widget: unknown; mark: unknown }[] = [];
    set.between(0, state.doc.length, (from, to, deco) => {
      const spec = (deco as { spec?: { widget?: unknown; class?: unknown } }).spec;
      out.push({ from, to, widget: spec?.widget, mark: spec?.class });
    });
    return out;
  }

  it("光标在公式内：只显示源码，不插渲染副本（无 replace、无第二遍渲染）", () => {
    for (const pos of [4, 6, 8]) {
      const points = inlinePoints(DOC_MATH, pos);
      // 整个区域没有任何 replace:源码原样留在文档里,只有渲染态才折成 widget
      expect(points.some((p) => p.widget instanceof MathWidget)).toBe(false);
    }
  });

  it("光标在公式内：源码按 token 上色（命令/结构符有 mark）", () => {
    // highlightMathSource 只标 $$、\cmd、{}[]^_&~——普通 $f(x)$ 没有 token。
    const points = inlinePoints("前文 $\\alpha_{x}$ 后文", 6);
    expect(points.some((p) => p.widget instanceof MathWidget)).toBe(false);
    expect(points.filter((p) => p.mark !== undefined).length).toBeGreaterThan(0);
  });

  it("光标压在边界上（开符之前 3 / 闭合符之后 9）：公式已渲染", () => {
    for (const pos of [3, 9]) {
      const points = inlinePoints(DOC_MATH, pos);
      expect(
        points.some((p) => p.widget instanceof MathWidget && p.from === 3 && p.to === 9),
      ).toBe(true);
    }
  });

  it("光标离开区域：折成渲染 widget", () => {
    const points = inlinePoints(DOC_MATH, 0);
    expect(
      points.some((p) => p.widget instanceof MathWidget && p.from === 3 && p.to === 9),
    ).toBe(true);
  });

  it("一行两个公式、编辑前一个：前一个的渲染副本紧随闭合 $，后一个照常渲染", () => {
    // "甲 $a$ 乙 $b$ 丙"：region 2..5 与 8..11。
    const doc = "甲 $a$ 乙 $b$ 丙";
    const points = inlinePoints(doc, 3); // 光标在第一个公式内
    const widgets = points.filter((p) => p.widget instanceof MathWidget);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({ from: 8, to: 11 });
    // 正在编辑的第一个公式:源码不折,渲染副本插在闭合定界符之后(=5),
    // 把「乙」与后一个公式整体往后推——不覆盖、也不并排重合。
    const copy = points.filter((p) => p.widget instanceof MathInlinePreviewWidget);
    expect(copy).toHaveLength(1);
    expect(copy[0].from).toBe(5);
    expect(copy[0].from).toBeLessThan(widgets[0].from);
  });
});

/**
 * Callout 锚点装饰:与某个 callout 标题同一段文字的正文文本加
 * md-callout-anchor(下划虚线);标题行、块内文、代码区不加。
 */
describe("livePreview callout 锚点装饰", () => {
  const anchorState = (doc: string, line = 1, col = 0) => {
    const created = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    const l = created.doc.line(line);
    return created.update({ selection: EditorSelection.cursor(l.from + col) }).state;
  };

  const anchorMarks = (state: EditorState) =>
    decosAt(state, 0, state.doc.length)
      .filter(
        (e) => (e.deco as { spec?: { class?: string } }).spec?.class === "md-callout-anchor",
      )
      .map((e) => ({ from: e.from, to: e.to }));

  it("正文里与标题同一段文字的位置有锚点;标题行与块内文没有", () => {
    const state = anchorState("斜率矩阵是错的\n\n::: 斜率矩阵\n\n:::\n");
    expect(anchorMarks(state)).toEqual([{ from: 0, to: 4 }]);
  });

  it("光标停进锚点内时装饰仍在(不参与标记的活动规则)", () => {
    const state = anchorState("斜率矩阵是错的\n\n::: 斜率矩阵\n\n:::\n", 1, 2);
    expect(anchorMarks(state)).toEqual([{ from: 0, to: 4 }]);
  });

  it("围栏代码里的同一段文字不加锚点", () => {
    const state = anchorState("```\n斜率矩阵\n```\n\n::: 斜率矩阵\n\n:::\n", 4, 0);
    expect(anchorMarks(state)).toEqual([]);
  });

  it("行内代码里的同一段文字不加锚点", () => {
    const state = anchorState("`斜率矩阵`\n\n::: 斜率矩阵\n\n:::\n", 3, 0);
    expect(anchorMarks(state)).toEqual([]);
  });

  it("锚点扫描跟着视口:只看得到视口内的命中", () => {
    const doc = "斜率矩阵\n\n::: 斜率矩阵\n\n:::\n";
    const state = anchorState(doc, 1, 0);
    const marksIn = (from: number, to: number) => {
      const set = buildInlineDecorations({ state, visibleRanges: [{ from, to }] });
      const out: { from: number; to: number }[] = [];
      set.between(0, state.doc.length, (f, t, deco) => {
        if ((deco as { spec?: { class?: string } }).spec?.class === "md-callout-anchor") {
          out.push({ from: f, to: t });
        }
      });
      return out;
    };
    expect(marksIn(0, 5)).toEqual([{ from: 0, to: 4 }]);
    // 视口只含标题行(行 1 的命中在外面):锚点不出现
    expect(marksIn(6, doc.length)).toEqual([]);
  });
});

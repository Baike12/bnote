import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { mathOwnsEndpoints, mathRegions } from "./context";

/**
 * 强调(斜体 / 加粗)的文本样式由这里画——不再交给语法高亮的 tag。
 *
 * 根因:`_` 在 LaTeX 里是下标,lezer 不认识公式,会把两个公式里的 `_` 配成一对
 * Emphasis,中间整段正文都落在节点范围内。HighlightStyle 按**节点范围**上色,
 * 装饰层再怎么过滤也挡不住它;所以 `t.emphasis` / `t.strong` 从 markdown.ts 的
 * 样式表里摘掉,改由这里按同一条「分隔符落在公式里 = 误配」的规则发光。
 *
 * 顺带解决了另一件事:光标停在强调行上时(live preview 的标记隐藏让路),文本
 * 也依旧有颜色——以前靠 tag,现在两种模式同一套装饰。装饰只标**内容**
 * (首标记之后到末标记之前),标记字符保持源码色。
 */
const emphasisMark = Decoration.mark({ class: "md-em" });
const strongMark = Decoration.mark({ class: "md-strong" });
const strikeMark = Decoration.mark({ class: "md-strike" });

/** 纯构建(无 DOM,可单测):只在可见区里走一遍语法树。 */
export function buildEmphasisMarks(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  if (ranges.length === 0) return Decoration.none;
  const out: Range<Decoration>[] = [];
  const maths = mathRegions(state);
  syntaxTree(state).iterate({
    from: ranges[0].from,
    to: ranges[ranges.length - 1].to,
    enter: (ref) => {
      const name = ref.name;
      if (name !== "Emphasis" && name !== "StrongEmphasis" && name !== "Strikethrough") {
        return true;
      }
      // 公式里配出来的误配节点:整段作废,子节点各自再判。
      if (mathOwnsEndpoints(maths, ref.from, ref.to)) return true;
      let first: SyntaxNode | null = null;
      let last: SyntaxNode | null = null;
      for (let child = ref.node.firstChild; child; child = child.nextSibling) {
        if (child.name === "EmphasisMark" || child.name === "StrikethroughMark") {
          if (!first) first = child;
          last = child;
        }
      }
      if (!first || !last || last.to <= first.to) return true;
      const deco =
        name === "StrongEmphasis" ? strongMark : name === "Strikethrough" ? strikeMark : emphasisMark;
      out.push(deco.range(first.to, last.from));
      return true; // 继续下行:嵌套强调(***x***)各自标记
    },
  });
  return Decoration.set(out, true);
}

/** 始终启用(live preview 开关都生效):只管文本样式,不动标记显隐。 */
export function emphasisMarksExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildEmphasisMarks(view.state, view.visibleRanges);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = buildEmphasisMarks(u.state, u.view.visibleRanges);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

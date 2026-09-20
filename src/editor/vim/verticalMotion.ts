import type { EditorView } from "@codemirror/view";
import { columnOnLine, pixelGoalOf, visibleVerticalTarget } from "@/editor/motionClamp";

/* ---- 视觉锚定的垂直移动：j/k/+/-/_ 的落点跟随眼睛 ----

   引擎的 moveByLines 用「文档字符列」（vim.lastHPos）决定水平落点。这个坐标
   在 live preview 里没有视觉意义：列表缩进空格、`- `、`[ ]`、标题 `#`、强调
   标记等前缀字符被装饰隐藏（零宽），同一字符列在不同行落在不同视觉位置——
   固定列意图下光标逐行横跳（实测 ±25~63px），还会踩进列表标记槽把该 token
   的渲染态翻成源码，行文本随之位移。引擎自己维护的 vim.lastHSPos（落点像素
   x，content 相对坐标）才是用户眼睛跟随的坐标，原始实现算出它却只投喂给
   折行钳制（hasMarkedText），寻常落点一概弃用。

   这里的落点改为像素锚定：
   - 目标行仍是文档行（cur.line ± repeat）：dd/dj 等行算子语义不变，软折行
     段仍整段跨越（与既有行为一致）；
   - 隐藏行（围栏/公式块/hr）不是步、公式近端边缘是落点——与 motionClamp
     共享同一套判定（visibleVerticalTarget），单一隐藏行模型；
   - 水平落点 = 目标行上离保留视觉 x 最近的可见字符边界，经 posAtCoords 解析
     （与渲染同一几何模型，永不落在隐藏内容里）；行未画出时退化为平均字宽
     估算（motionClamp 同一契约，行即将滚入视口，下一步按键重新锚定）；
   - `$` 的行尾意图（lastHPos=Infinity）自动保留：保留 x 超出目标行尾即落在
     行尾；`+`/`-`/`_` 的首个非空白意图解析到第一个可见字符（列表行上的首个
     可见字符就是正文，而不是被隐藏的标记）；
   - 连续垂直移动不回写视觉锚：落点吸附到字符边界的量化偏差若反馈进 goal，
     会逐键累积（实测 8 键右漂 47px）。视觉锚在一次连续移动里保持不变，正是
     vim curswant 的语义；水平动作会脱离家族并重新取锚；
   - 每次取锚都来自可见位置，隐藏坐标读出 x≈0 的垃圾值再传播给后续按键的
     旧路径不复存在。 ---- */

export interface VimCorePos {
  line: number;
  ch: number;
}

export interface MoveByLinesArgs {
  forward: boolean;
  repeat: number;
  repeatOffset?: number;
  toFirstChar?: boolean;
}

export interface VimCoreState {
  lastMotion: unknown;
  lastHPos: number;
  lastHSPos: number;
}

export interface CmShim {
  cm6: EditorView;
  firstLine(): number;
  lastLine(): number;
}

/** `this` 是引擎的 motions 表（moveToStartOfLine 等在其上，家族判定用）。 */
export function moveByLinesVisual(
  this: Record<string, any>,
  cm: CmShim,
  head: VimCorePos,
  motionArgs: MoveByLinesArgs,
  vim: VimCoreState,
): VimCorePos {
  const view = cm.cm6;
  const state = view.state;
  const doc = state.doc;

  // 连续垂直移动家族沿用保留的视觉锚；其他动作（插入退出、0、w…）之后
  // 的第一步从当前光标的真实位置重新取锚。
  const family =
    vim.lastMotion === this.moveByLines ||
    vim.lastMotion === this.moveByDisplayLines ||
    vim.lastMotion === this.moveByScroll ||
    vim.lastMotion === this.moveToColumn ||
    vim.lastMotion === this.moveToEol;
  const eolIntent = family && vim.lastHPos === Infinity;
  if (!family) vim.lastHPos = head.ch;

  const repeat = motionArgs.repeat + (motionArgs.repeatOffset || 0);
  const line = motionArgs.forward ? head.line + repeat : head.line - repeat;
  if (line < cm.firstLine() && head.line === cm.firstLine()) {
    return this.moveToStartOfLine(cm, head, motionArgs, vim);
  }
  if (line > cm.lastLine() && head.line === cm.lastLine()) {
    // 引擎私有 moveToEol(keepHPos=true) 的忠实复刻：原力行尾，不动记账。
    return { line: head.line + motionArgs.repeat - 1, ch: Infinity };
  }

  const down = !!motionArgs.forward;
  const count = Math.abs(repeat) || 0;
  const targetNo = visibleVerticalTarget(state, head.line + 1, down, count);
  const target = doc.line(targetNo);

  const contentLeft = view.contentDOM.getBoundingClientRect().left;
  let goal: number;
  if (family && Number.isFinite(vim.lastHSPos)) {
    goal = vim.lastHSPos;
  } else {
    const headLine = doc.line(head.line + 1);
    goal = pixelGoalOf(view, headLine.from + Math.min(head.ch, headLine.length), contentLeft);
  }

  let ch: number;
  if (motionArgs.toFirstChar) {
    const m = /\S/.exec(target.text);
    const firstNonWhite = m ? m.index : 0;
    // 首个非空白字符可能是被隐藏的标记（列表行）：像素解析会落在第一个
    // 可见字符上；隐藏位置读出的 x≈0 同样解析到第一个可见字符。
    ch = columnOnLine(
      view,
      target,
      pixelGoalOf(view, target.from + firstNonWhite, contentLeft),
      contentLeft,
    );
    // 新意图，锚随落点重置（vim 的 `+` 重置 curswant 语义）。
    vim.lastHSPos = pixelGoalOf(view, target.from + ch, contentLeft);
  } else if (eolIntent) {
    // 行尾意图：lastHSPos 已由 $（moveToEol）设为行尾 x，保持不变。
    ch = target.length;
  } else {
    ch = columnOnLine(view, target, goal, contentLeft);
    if (!family) {
      // 新动作（插入退出、0、w…）之后的第一步：取的锚就是新锚。
      vim.lastHSPos = goal;
    }
  }

  vim.lastHPos = eolIntent ? Infinity : ch;
  return { line: targetNo - 1, ch };
}

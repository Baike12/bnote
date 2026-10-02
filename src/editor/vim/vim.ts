import { vim, Vim, getCM, CodeMirror } from "@replit/codemirror-vim";

// Re-exported for harness/debug access to the underlying engine singleton.
export { Vim, getCM };
import type { EditorView, KeyBinding } from "@codemirror/view";
import { keymap, ViewPlugin, Decoration } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorSelection, RangeSetBuilder } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { setSearchQuery, SearchQuery } from "@codemirror/search";
import type { VimMapping, VimMode } from "./vimrc";
import { readClipboardText, writeClipboardText } from "@/lib/clipboard";
import { moveByLinesVisual } from "./verticalMotion";

export type RunCommand = (commandId: string) => void;

let runCommandRef: RunCommand = () => {};

/** :w / :wq / :q … plus :Bnote <command-id> for any bnote command. */
export function registerVimExCommands(run: RunCommand) {
  runCommandRef = run;
  Vim.defineEx("write", "w", () => run("workspace.save-note"));
  Vim.defineEx("wq", "wq", () => {
    run("workspace.save-note");
    run("workspace.close-window");
  });
  Vim.defineEx("x", "x", () => {
    run("workspace.save-note");
    run("workspace.close-window");
  });
  Vim.defineEx("quit", "q", () => run("workspace.close-window"));
  Vim.defineEx("noh", "noh", (cm) => {
    const view = (cm as unknown as { cm6: EditorView }).cm6;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  });
  Vim.defineEx("Bnote", "B", (_cm, params) => {
    const id = (params?.args ?? [])[0];
    if (id) run(id);
  });
}

export function vimModeExtension(): Extension {
  patchVimNewlineIndent();
  patchVimNotice();
  patchVimVerticalMotion();
  patchVimMarkerFind();
  return vim();
}

/* ---- 底部消息：屏蔽 yank 提示，其余消息改成"按任意键收掉"。
   引擎的消息都走 showConfirm → openNotification（适配器独有的出口）：
   - yank 每次都会弹一条 1.5s 的红色 "N lines yanked"。vim 里这条归 report 选项管，
     引擎没实现该开关，也没有任何 option 能关掉它，所以在这一层按内容丢掉；
   - 其余消息（报错、:set 回显等）引擎只挂了个 15s 定时器：关不掉、只能干等。
     vim 的手感是"下一条命令/按键就清掉"，所以这里把 close 挂到
     state.closeVimNotification 上——引擎自己的按键路径（multiSelectHandleKey）
     下一次按键就会调用它。长消息（需要回车确认的 :reg）引擎自己会挂，行为不变。 ---- */

let noticePatched = false;

/** showConfirm 拼出的 yank 消息：`N lines yanked`，带寄存器时尾部是 `into "a`
    （引擎少拼了一个右引号，别按正常引号对写）。两个调用点都是这个形状。 */
const YANK_NOTICE = /^\d+ lines yanked(?: into ".+)?$/;

/** 非阻塞消息的停留时长；引擎默认 15s，按 vim 的手感调短（按键仍可立刻收掉）。 */
const NOTICE_MS = 4000;

function patchVimNotice() {
  if (noticePatched) return;
  noticePatched = true;
  try {
    const proto = CodeMirror.prototype as unknown as {
      openNotification: (
        this: { state: { closeVimNotification?: (() => void) | null } },
        template: HTMLElement,
        options?: { duration?: number },
      ) => (() => void) | undefined;
    };
    const open = proto.openNotification;
    proto.openNotification = function (template, options) {
      if (YANK_NOTICE.test(template.textContent?.trim() ?? "")) return undefined;
      // duration 0 = 需要回车确认的长消息，保持原样。
      const duration = Math.min(options?.duration ?? NOTICE_MS, NOTICE_MS);
      const close = open.call(this, template, { ...options, duration });
      if (typeof close === "function") this.state.closeVimNotification = close;
      return close;
    };
  } catch (e) {
    console.warn("[bnote] vim notice patch failed", e);
  }
}

/* ---- vim o/O indent compat: the engine implements `o`/`O` via CM6's
   insertNewlineAndIndent, which expands a tab indent to spaces (tabStop
   columns). Vim copies the leading whitespace verbatim — patch the shim
   command and the open-line action so o/O keep tabs and exact spaces
   (O takes the CURRENT line's indent, not the line above's). ---- */

let newlineIndentPatched = false;

function patchVimNewlineIndent() {
  if (newlineIndentPatched) return;
  newlineIndentPatched = true;
  try {
    const VimAny = Vim as unknown as Record<string, any>;
    const commands = (CodeMirror as unknown as {
      commands: Record<string, ((cm: { cm6: EditorView }) => void) | undefined>;
    }).commands;
    // Safety net for other engine paths that newline-and-indent.
    commands.newlineAndIndent = (cm) => {
      const view = cm.cm6;
      const state = view.state;
      view.dispatch(
        state.update(
          state.changeByRange((range) => {
            const line = state.doc.lineAt(range.head);
            const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
            return {
              changes: { from: range.head, insert: state.lineBreak + indent },
              range: EditorSelection.cursor(range.head + state.lineBreak.length + indent.length),
            };
          }),
          { scrollIntoView: true, userEvent: "input" },
        ),
      );
    };
    // Faithful port of the engine's newLineAndEnterInsertMode with verbatim
    // indent (O uses the current line's indent, vim-style).
    VimAny.defineAction("newLineAndEnterInsertMode", function (
      this: Record<string, any>,
      cm: { cm6: EditorView },
      actionArgs: { after?: boolean; repeat?: number },
      vimState: Record<string, unknown>,
    ) {
      vimState.insertMode = true;
      const view = cm.cm6;
      const state = view.state;
      const line = state.doc.lineAt(state.selection.main.head);
      const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
      const openAfter = actionArgs.after !== false;
      if (!openAfter && line.number === 1) {
        view.dispatch({
          changes: { from: 0, insert: indent + state.lineBreak },
          selection: { anchor: indent.length },
          scrollIntoView: true,
        });
      } else {
        const at = openAfter ? line.to : state.doc.line(line.number - 1).to;
        view.dispatch({
          changes: { from: at, insert: state.lineBreak + indent },
          selection: { anchor: at + state.lineBreak.length + indent.length },
          scrollIntoView: true,
        });
      }
      this.enterInsertMode(cm, { repeat: actionArgs.repeat }, vimState);
    });
  } catch (e) {
    console.warn("[bnote] vim o/O indent patch failed", e);
  }
}

/* ---- 视觉锚定的垂直移动：把引擎的 moveByLines 换成像素锚定实现。
   设计与证据见 ./verticalMotion.ts 顶部的注释块。 ---- */

let verticalMotionPatched = false;

function patchVimVerticalMotion() {
  if (verticalMotionPatched) return;
  verticalMotionPatched = true;
  const VimAny = Vim as unknown as {
    defineMotion: (name: string, fn: unknown) => void;
  };
  VimAny.defineMotion("moveByLines", moveByLinesVisual);
}

/* ---- 跨文档跳转标记：Marker.find() 对"不在此文档里的偏移"必须报告不存在，
   不能抛。引擎（@replit/codemirror-vim 6.4 / -core 0.1.0）的 Marker 持有裸
   文档偏移，find() = posFromIndex(offset)，偏移超出当前文档长度时
   Text.lineAt 直接抛 RangeError；CM5 原版的 TextMarker 随文档走，文档不在了
   find() 返回 undefined，jumpList.add/move（vim-core vim.js:578/603）都按
   「标记不存在」优雅跳过——CM6 port 丢了这个语义。
   触发链：jumpList 挂在引擎的模块级单例 vimGlobalState 上，跨文档、跨
   view.setState 存活；bnote 每次切文件走 loadDocument/reloadDocument 的
   setState 整体替换（setup.ts），不是事务，标记不会被 mapPos。于是在长文档
   里按过 G/gg/n//…（toJumplist，marker=大偏移）再切到更短的文档，gg/G 在
   recordJumpPosition → jumpList.add → curMark.find() 处必抛——异常发生在
   setSelection 之前，光标永远落不下去；引擎 catch 重置 vim 态（状态条仍是
   NORMAL），j/k 等非 jumplist 键照常——用户看到「normal 模式 gg/G 没反应」，
   且每次按键都命中同一个死标记（add 在写槽位前就抛，pointer 不前进），本
   会话内永久失效，直到重启或打开更长的文档把毒标记冲掉。
   修法=恢复 CM5 语义：offset 越界（<0 或 >doc.length）find() 返回 null，
   add() 走下一槽位续写、move() 把死标记当不存在跳过。Marker 类不导出，只能
   从实例原型拿：包一层 setBookmark（全引擎唯一 new Marker 的构造点），首个
   书签落地的瞬间 patch 其原型并拆掉包装。越界是唯一可靠的「跨文档残留」
   信号——不追文档身份（同文档编辑后 Text 引用必然变化，身份判等无从建立）；
   「偏移合法但语义错位」的残余（换到长度相近的文档）与上游一致：记一次怪
   跳转后自愈。回归测试 ./jumpList.test.ts（真实引擎 + 真 shim Marker）。 ---- */

let markerFindPatched = false;
let markerProtoHooked = false;

/** 首个书签落地时执行：从实例拿到 Marker.prototype，包一层 find()。
 *  做完即撤掉 setBookmark 包装（钩子只用一次）。 */
function hookMarkerPrototype(marker: object, restoreSetBookmark: () => void) {
  if (markerProtoHooked) return;
  const proto = Object.getPrototypeOf(marker) as
    | ({ offset: number | null; cm: { cm6: EditorView }; find(): unknown })
    | null;
  if (!proto || typeof proto.find !== "function") return; // 不是认识的形状：留着包装，下个书签再试
  markerProtoHooked = true;
  restoreSetBookmark();
  const origFind = proto.find;
  proto.find = function (this: { offset: number | null; cm: { cm6: EditorView } }) {
    const offset = this.offset;
    if (offset != null) {
      const doc = this.cm.cm6.state.doc;
      // 当前文档装不下的偏移 = 别的文档留下的标记；报告不存在，别抛。
      if (offset < 0 || offset > doc.length) return null;
    }
    return origFind.call(this);
  };
}

/** 恢复 Marker.find() 的 CM5 语义（见上方注释块）；导出仅供门禁
 *  （jumpList.test.ts 要在无 DOM 的 node 里先装上 patch）。 */
export function patchVimMarkerFind() {
  if (markerFindPatched) return;
  markerFindPatched = true;
  try {
    const proto = CodeMirror.prototype as unknown as {
      setBookmark: (this: CodeMirror, cursor: never, options?: { insertLeft?: boolean }) => object;
    };
    const origSetBookmark = proto.setBookmark;
    proto.setBookmark = function (cursor, options) {
      const marker = origSetBookmark.call(this, cursor, options);
      hookMarkerPrototype(marker, () => {
        proto.setBookmark = origSetBookmark;
      });
      return marker;
    };
  } catch (e) {
    console.warn("[bnote] vim marker find patch failed", e);
  }
}

/* ---- clipboard=unnamed: sync the vim unnamed register with the system clipboard.
   The underlying vim engine already maps register "+" to navigator.clipboard;
   here we patch the unnamed register '"' to follow it: every yank/delete/change
   writes to the clipboard, and p/P reads it back. ---- */

let clipboardUnnamed = false;
let clipboardPatched = false;

export function setVimClipboardUnnamed(on: boolean) {
  clipboardUnnamed = on;
  if (!on || clipboardPatched) return;
  clipboardPatched = true;
  try {
    const VimAny = Vim as unknown as Record<string, any>;
    const controller = VimAny.getRegisterController();
    // Prototype-level patch survives the engine resetting its global state.
    const proto = Object.getPrototypeOf(controller);
    const origPush = proto.pushText;
    proto.pushText = function (
      registerName: string,
      operator: string,
      text: string,
      linewise: boolean,
      blockwise: boolean,
    ) {
      origPush.call(this, registerName, operator, text, linewise, blockwise);
      if (clipboardUnnamed && registerName !== "_" && registerName !== "+") {
        const out = linewise && !text.endsWith("\n") ? `${text}\n` : text;
        void writeClipboardText(out);
      }
    };
    // Redefine the paste action: when clipboard=unnamed and no explicit
    // register was given, read the system clipboard first. `this` inside a
    // vim action is the engine's actions object (continuePaste lives there).
    // 读走 lib/clipboard（WKWebView 里 navigator.clipboard.readText 不可用，
    // 这条路径此前一直静默失败）；失败时回退寄存器内容。
    VimAny.defineAction("paste", function (
      this: Record<string, any>,
      cm: unknown,
      actionArgs: { registerName?: string },
      vimState: unknown,
    ) {
      const controller = VimAny.getRegisterController();
      const name = actionArgs.registerName || "";
      if (clipboardUnnamed && name === "") {
        const register = controller.getRegister("");
        readClipboardText().then((value) => {
          if (value) register.setText(value, value.endsWith("\n"), false);
          this.continuePaste(cm, actionArgs, vimState, register.toString(), register);
        });
        return;
      }
      // Default engine behavior: "+" reads the clipboard, others read the register.
      const register = controller.getRegister(name);
      if (name === "+") {
        void readClipboardText().then((value) => {
          if (value !== null) this.continuePaste(cm, actionArgs, vimState, value, register);
        });
      } else {
        this.continuePaste(cm, actionArgs, vimState, register.toString(), register);
      }
    });
  } catch (e) {
    console.warn("[bnote] clipboard=unnamed patch failed", e);
  }
}

/* ---- visual-mode selection paint: the decoration layer is the ONLY painter
   while vim visual mode is on.
   CM 自己的选区（.cm-selectionBackground 矩形 + 浏览器原生 ::selection）几何是
   坐标推导出来的，有两处必然对不上：横向边界按 .cm-line 的 padding 算（本应用
   的留白在 .cm-content 上，于是矩形比行盒宽、左边压到引用条），纵向末端要向
   coordsAtPos(to, -2) 取值（位置紧邻块级 widget——公式块、公式预览——时坐标落
   进 widget 内部，长出跨行/高几百像素的窄灰带）。装饰的几何来自 DOM 行盒与文档
   坐标，两条路都不会走样，所以 visual 选区只由这一层画：
   - cm-vimVisualLine / cm-vimVisualLineHint：行带（linewise 行带即选区；charwise/
     blockwise 的行带只是"这些行被卷入"的提示色）；
   - cm-vimVisualRange：精确范围（charwise 的字符区间、blockwise 的逐行块）。
   CM 的矩形在 cm-vimSelPaint 下被置透明（见 global.css）。 ---- */

const visualLineDeco = Decoration.line({ class: "cm-vimVisualLine" });
/* charwise/blockwise 的行带只是"这些行被卷入"的提示色：精确范围那层已经用了选区
   本色，两处同色会让选中范围糊成一片。 */
const visualLineHintDeco = Decoration.line({ class: "cm-vimVisualLineHint" });
const visualRangeDeco = Decoration.mark({ class: "cm-vimVisualRange" });

/** 绘制层接管选区时挂在 .cm-editor 上的类（CSS 据此关掉 CM 的选区矩形）。 */
const OWN_PAINT_CLASS = "cm-vimSelPaint";

interface Pos {
  line: number;
  ch: number;
}

interface VisualDoc {
  length: number;
  lines: number;
  line(n: number): { from: number; to: number };
  lineAt(pos: number): { from: number; to: number; number: number };
}

interface VisualVimState {
  visualMode?: boolean;
  visualLine?: boolean;
  visualBlock?: boolean;
  sel?: { anchor?: Pos; head?: Pos };
}

/** Visual 模式高亮行集合的纯函数体：vim 引擎的 sel（CodeMirror 5 风格
 *  0 基 line/ch）优先——linewise visual 常常保持 CM 选区为空；引擎没维护
 *  sel 时退回 CM 选区。导出供门禁锁几何（前向/反向/linewise/空选区）。 */
export function visualLineNumbers(
  doc: VisualDoc,
  vimState: VisualVimState | null,
  ranges: readonly { from: number; to: number; empty?: boolean }[],
): number[] {
  if (!vimState?.visualMode) return [];
  const lines = new Set<number>();
  const sel = vimState.sel;
  if (sel?.anchor != null && sel?.head != null) {
    const aLine = Math.min(sel.anchor.line, sel.head.line) + 1;
    const bLine = Math.max(sel.anchor.line, sel.head.line) + 1;
    const endLine = doc.lines;
    const from = Math.max(1, Math.min(aLine, endLine));
    const to = Math.max(1, Math.min(bLine, endLine));
    const hasExtent = sel.anchor.line !== sel.head.line || sel.anchor.ch !== sel.head.ch;
    if (!hasExtent && !vimState.visualLine) {
      // Charwise visual with a collapsed range: nothing visible yet.
      return [];
    }
    for (let n = from; n <= to; n++) lines.add(n);
  } else {
    for (const range of ranges) {
      if (range.empty) continue;
      // A selection ending at a line start really ends on the previous line.
      let to = range.to;
      if (to > range.from && to === doc.lineAt(to).from) to -= 1;
      for (let n = doc.lineAt(range.from).number; n <= doc.lineAt(to).number; n++) {
        lines.add(n);
      }
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/** Visual 模式「精确范围」的纯函数体（文档偏移），与行带互补：
 *  - linewise：整行由行带表达，这里返回空（再叠一层字符底色只是同色加深）；
 *  - blockwise：引擎只把光标所在那一段同步进 CM 选区，块形状必须按 anchor/head
 *    的列区间逐行切出来（列越界的行钳到行尾——vim 的块选就是这样）；
 *  - charwise：直接用引擎同步到 CM 的选区（含头字符由引擎保证）。
 *  只给绘制用：几何来自文档坐标，不经过 coordsAtPos，所以块级 widget 边界不会
 *  让它变形。导出供门禁锁几何。 */
export function visualRangeSpans(
  doc: VisualDoc,
  vimState: VisualVimState | null,
  ranges: readonly { from: number; to: number; empty?: boolean }[],
): { from: number; to: number }[] {
  if (!vimState?.visualMode) return [];
  const sel = vimState.sel;
  if (vimState.visualLine) return [];
  const out: { from: number; to: number }[] = [];
  if (vimState.visualBlock && sel?.anchor != null && sel?.head != null) {
    const a = sel.anchor;
    const h = sel.head;
    const first = Math.max(1, Math.min(a.line, h.line) + 1);
    const last = Math.min(doc.lines, Math.max(a.line, h.line) + 1);
    const startCh = Math.min(a.ch, h.ch);
    const endCh = Math.max(a.ch, h.ch) + 1; // vim 的选区含头字符
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      const width = line.to - line.from;
      const from = line.from + Math.min(startCh, width);
      const to = line.from + Math.min(endCh, width);
      if (to > from) out.push({ from, to });
    }
    return out;
  }
  for (const range of ranges) {
    if (!range.empty && range.to > range.from) out.push({ from: range.from, to: range.to });
  }
  return out;
}

/** Visual 选区要画的全部装饰：行带 + 精确范围。空集 = 当前没有绘制者（刚按 v
 *  还没动的折叠选区），此时独占绘制也一并放开。导出供门禁锁几何与绘制所有权。 */
export function visualSelectionDecos(
  doc: VisualDoc,
  vimState: VisualVimState | null,
  ranges: readonly { from: number; to: number; empty?: boolean }[],
): DecorationSet {
  if (!vimState?.visualMode) return Decoration.set([]);
  const lines = visualLineNumbers(doc, vimState, ranges);
  const spans = visualRangeSpans(doc, vimState, ranges);
  // linewise 的行带就是选区本身（选区本色）；charwise/blockwise 上面还压着精确
  // 范围那层，行带退成提示色。
  const lineDeco = vimState.visualLine ? visualLineDeco : visualLineHintDeco;
  if (spans.length === 0) {
    // 行带本身有序：走 O(n) 的 builder（大范围 linewise 选区的每击重建）。
    const builder = new RangeSetBuilder<Decoration>();
    for (const n of lines) {
      const line = doc.line(n);
      builder.add(line.from, line.from, lineDeco);
    }
    return builder.finish();
  }
  const decos: Range<Decoration>[] = [];
  for (const n of lines) decos.push(lineDeco.range(doc.line(n).from));
  for (const span of spans) decos.push(visualRangeDeco.range(span.from, span.to));
  return Decoration.set(decos, true);
}

export function vimVisualHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private lastVisual: boolean;
      private ownsPaint = false;
      private view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.lastVisual = !!vimStateOf(view)?.visualMode;
        this.decorations = this.build(view);
        this.syncOwnership();
      }

      update(u: ViewUpdate) {
        const visual = !!vimStateOf(u.view)?.visualMode;
        if (u.docChanged || u.selectionSet || u.viewportChanged || visual !== this.lastVisual) {
          this.lastVisual = visual;
          this.decorations = this.build(u.view);
          this.syncOwnership();
        }
      }

      destroy() {
        this.view.dom.classList.remove(OWN_PAINT_CLASS);
      }

      /** 装饰层一旦画了选区，CM 的选区矩形必须让位——同一个状态两个绘制者正是
       *  错位的来源（见文件上方注释）。没有绘制者时也别拦着 CM 画自己的矩形。 */
      private syncOwnership() {
        const owns = this.decorations.size > 0;
        if (owns === this.ownsPaint) return;
        this.ownsPaint = owns;
        this.view.dom.classList.toggle(OWN_PAINT_CLASS, owns);
      }

      build(view: EditorView): DecorationSet {
        return visualSelectionDecos(
          view.state.doc,
          vimStateOf(view) as VisualVimState | null,
          view.state.selection.ranges,
        );
      }
    },
		{ decorations: (v) => v.decorations },
	);
}

/* ---- 当前行底 shade:自有装饰模型,替代 highlightActiveLine + 祖先类门控 CSS。
   引擎在 Esc/i 时翻动 scrollDOM 上的 .cm-vimMode 类,任何以它为祖先条件的
   选择器都会让样式失效圈罩住整个视口子树(每行及其 KaTeX/markdown 子树全部
   重查规则)。底 shade 改成一个 line decoration:可见性直接跟 vimDrawsBlockCursor
   走(normal/visual/replace 画块光标 ⇔ 引擎给 scroller 挂 cm-vimMode 的同一
   判据,updateClass 逐字对照过),insert 态不发装饰;一次切换只动光标行一行
   的类,失效圈收进单行,宽域失效少一个消费方。 ---- */

/** activeLine 行装饰的纯构建:不画块光标(insert 态、无引擎)返回空集,否则给
 *  每个 range 的 head 行挂 cm-activeLine(多 range 同行去重)。导出供门禁锁
 *  可见性判据与装饰几何。 */
export function activeLineDecos(
  state: EditorState,
  drawsBlockCursor: boolean,
): DecorationSet {
  if (!drawsBlockCursor) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const lineFrom = state.doc.lineAt(r.head).from;
    if (seen.has(lineFrom)) continue;
    seen.add(lineFrom);
    builder.add(lineFrom, lineFrom, activeLineDeco);
  }
  return builder.finish();
}

const activeLineDeco = Decoration.line({ class: "cm-activeLine" });

export function vimActiveLine(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = activeLineDecos(view.state, vimDrawsBlockCursor(view));
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = activeLineDecos(u.view.state, vimDrawsBlockCursor(u.view));
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function vimStateOf(view: EditorView): { insertMode?: boolean; visualMode?: boolean } | null {
  const cm = getCM(view) as unknown as { state?: { vim?: { insertMode?: boolean; visualMode?: boolean } } } | null;
  return cm?.state?.vim ?? null;
}

/** 引擎此刻是否在画块光标。判据照抄 @replit/codemirror-vim 的 measureCursor
 *  （`vim && (!vim.insertMode || overwrite)`）：insert 态（非 replace）下块光标
 *  层按空渲染，为它做的 measure 冲刷没有对象。overwrite 是引擎挂在自己的 CM5
 *  兼容 state 上的标志（getCM 里那个普通对象，不是 CM6 的 field），只能这么读。 */
export function vimDrawsBlockCursor(view: EditorView): boolean {
  const cm = getCM(view) as unknown as {
    state?: { vim?: { insertMode?: boolean }; overwrite?: boolean };
  } | null;
  const st = cm?.state;
  if (!st?.vim) return false;
  return !st.vim.insertMode || !!st.overwrite;
}

export function currentVimMode(view: EditorView): VimMode | null {
  const v = vimStateOf(view);
  if (!v) return null;
  if (v.insertMode) return "insert";
  if (v.visualMode) return "visual";
  return "normal";
}

const SPECIAL_KEYS: Record<string, string> = {
  esc: "Escape",
  cr: "Enter",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  bs: "Backspace",
  bar: "|",
  lt: "<",
  gt: ">",
  lead: "\\",
};

/** `<C-s>` → CM6 key string "Ctrl-s"; `<D-s>` → "Mod-s". */
export function normalizeVimKey(lhs: string): string | null {
  if (!lhs.startsWith("<") || !lhs.endsWith(">")) {
    return lhs.length === 1 ? lhs : null;
  }
  const inner = lhs.slice(1, -1);
  let result = "";
  let mods = "";
  const parts = inner.split("-");
  let keyPart = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "c" || mod === "ctrl") mods += "Ctrl-";
    else if (mod === "d" || mod === "cmd" || mod === "meta") mods += "Mod-";
    else if (mod === "m" || mod === "a" || mod === "alt") mods += "Alt-";
    else if (mod === "s" || mod === "shift") mods += "Shift-";
    else return null;
  }
  const lower = keyPart.toLowerCase();
  if (SPECIAL_KEYS[lower]) {
    keyPart = SPECIAL_KEYS[lower];
  } else if (keyPart.length !== 1 && !/^(F\d+|Arrow.+|Home|End|PageUp|PageDown|Delete|Insert)$/.test(keyPart)) {
    return null;
  }
  result = keyPart;
  return mods + result;
}

/** Builds the CM6 keymap that runs bnote commands for `:command` mappings. */
export function commandMappingKeymap(mappings: VimMapping[]): Extension {
  // A key can be mapped more than once per mode (`noremap` plus `vnoremap`, or
  // a stray duplicate); vim lets the LAST definition win, while a keymap picks
  // the first binding it finds — so collapse duplicates back-to-front.
  const byKey = new Map<string, KeyBinding>();
  for (const m of mappings) {
    if (!m.commandId) continue;
    const key = normalizeVimKey(m.lhs);
    if (!key) continue;
    const mode = m.mode;
    byKey.set(`${mode}\u0000${key}`, {
      key,
      run: (view) => {
        const current = currentVimMode(view);
        if (!current) return false; // vim not enabled — don't hijack keys
        if (mode === "insert" && current !== "insert") return false;
        if (mode === "normal" && current !== "normal") return false;
        if (mode === "visual" && current !== "visual") return false;
        runCommandRef(m.commandId!);
        return true;
      },
    });
  }
  const bindings = [...byKey.values()];
  return bindings.length > 0 ? keymap.of(bindings) : [];
}

/** Applies key-sequence mappings through the vim engine itself. */
export function applyNativeMappings(mappings: VimMapping[]) {
  try {
    Vim.mapclear();
  } catch {
    // mapclear without args is fine on a fresh Vim instance
  }
  for (const m of mappings) {
    if (m.commandId) continue; // handled by the CM6 keymap
    const ctx =
      m.mode === "insert" ? "insert" : m.mode === "visual" ? "visual" : "normal";
    // rhs 必须原样传：引擎展开 keyToKey 映射时按尖括号 token 切分
    // （doKeyToKey 的 vimToCmKeyMap 分支），<Esc>/<CR>/<Tab>/<Space> 是它
    // 原生认识的形状。早期版本把 <Esc> 改写成裸 "Esc"——展开器把它按
    // E·s·c 三个单字符逐个 replaceSelection 进文档，`imap jj <Esc>` 从此
    // 退不出插入模式，用户"在 normal 模式按 gg/G 没反应"实际都发生在
    // insert 态。回归测试见 ./nativeMappings.test.ts。
    const rhs = m.rhs;
    try {
      if (m.noremap) Vim.noremap(m.lhs, rhs, ctx);
      else Vim.map(m.lhs, rhs, ctx);
    } catch (e) {
      console.warn(`vimrc: cannot map ${m.lhs} → ${m.rhs}`, e);
    }
  }
}

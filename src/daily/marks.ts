import { StateEffect, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { documentPath, setDocPath } from "@/editor/docPath";
import { todayStamp } from "@/editor/ops";
import { useAppStore } from "@/state/appStore";
import { onLinksChanged, peekLinks, type DailyLink } from "./links";
import { dailyPathFor, isDailyPath, isTodo, parseListLine, todoText } from "./model";

/**
 * 与日记链接的待办行的可视标识。
 *
 * 语义分两侧,各自都是「当下最该知道的那一件事」:
 *  - 源笔记(项目里的待办):标出**指向今天这份日记**的链接——就是 ⌘⇧J 眼中
 *    「已同步」的那批。昨天发出去的条目今天不再算数,与发送命令的按日归属
 *    判定一致;否则同一行会同时挂上多天的映射标记。auto 链接(存在即聚合)
 *    不标源侧:自动同步下每个待办都有链接,标记铺满全库就不再是信息。
 *  - 日记文件(任意一天):标出**指向这份日记**的链接,并带上源笔记名——它是
 *    「这条是同步来的,不是手写的」的唯一线索。
 *
 * 渲染只用**行装饰 + 绝对定位的伪元素**(CSS 在 global.css):不插入 widget、
 * 不参与行内布局,所以列表缩进/折行几何与无标记时逐像素一致。
 *
 * 链接库在编辑器之外(发送/镜像/解链都在引擎里改),所以库的写入者通过
 * links.ts 的订阅通知到这里,这里再派发一个带标记的空事务唤醒 CM 重算
 * (`onLinksChanged` 可能在别的 dispatch 之内触发,故延到微任务里)。
 */

/** 空事务上的标记:链接库变了,装饰要重算。 */
export const dailyLinksChanged = StateEffect.define<null>();

/** 构建只需要的视图面(与 livePreview.DecorationBuildView 同构,便于无 DOM 测试)。 */
export interface DailyMarkView {
  state: EditorState;
  visibleRanges: readonly { from: number; to: number }[];
}

export interface DailyMarkContext {
  /** 当前打开的文件路径。 */
  path: string;
  /** 该文件参与的全部链接(store.forFile(path))。 */
  links: DailyLink[];
  /** 今天这份日记的路径。 */
  todayDailyPath: string;
}

/** 源笔记名(去掉目录与 .md),用在日记侧标签与提示里。 */
export function sourceLabel(srcPath: string): string {
  return srcPath.slice(srcPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

function markFor(link: DailyLink, dailySide: boolean): Decoration {
  const attrs: Record<string, string> = dailySide
    ? {
        "data-daily-src": sourceLabel(link.srcPath),
        title: `与《${sourceLabel(link.srcPath)}》的待办同步中`,
      }
    : {
        title:
          link.kind === "recorded"
            ? "勾选完成时已记录到今日日记,两侧保持同步"
            : "已发送到今日日记,两侧保持同步",
      };
  return Decoration.line({ class: "md-daily-link", attributes: attrs });
}

/** 视口内与日记链接的待办行 → 行装饰。纯函数:只读 state 与传入的链接表。 */
export function buildDailyMarks(view: DailyMarkView, ctx: DailyMarkContext): DecorationSet {
  const dailySide = isDailyPath(ctx.path);
  const byText = new Map<string, DailyLink>();
  for (const l of ctx.links) {
    const relevant = dailySide
      ? l.dailyPath === ctx.path
      : l.kind !== "auto" && l.srcPath === ctx.path && l.dailyPath === ctx.todayDailyPath;
    if (relevant && !byText.has(l.text)) byText.set(l.text, l);
  }
  if (byText.size === 0 || view.visibleRanges.length === 0) return Decoration.none;

  const doc = view.state.doc;
  const from = Math.min(...view.visibleRanges.map((r) => r.from));
  const to = Math.max(...view.visibleRanges.map((r) => r.to));
  const out: Range<Decoration>[] = [];
  for (let n = doc.lineAt(from).number; ; n++) {
    const line = doc.line(n);
    const parsed = parseListLine(line.text);
    if (isTodo(parsed)) {
      const link = byText.get(todoText(parsed));
      if (link) out.push(markFor(link, dailySide).range(line.from));
    }
    if (line.to >= to || line.to >= doc.length) break;
  }
  return Decoration.set(out, true);
}

/** 链接库变更 → 派发唤醒事务(等本轮更新结束,避免嵌套 dispatch)。 */
function wake(view: EditorView): void {
  queueMicrotask(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: dailyLinksChanged.of(null) });
  });
}

const dailyMarksPlugin = ViewPlugin.fromClass(
  class {
    marks: DecorationSet = Decoration.none;
    private unsubscribe: () => void;

    constructor(private view: EditorView) {
      this.unsubscribe = onLinksChanged(() => wake(this.view));
      this.marks = this.build();
    }

    destroy() {
      this.unsubscribe();
    }

    private build(): DecorationSet {
      const state = this.view.state;
      const path = documentPath(state);
      const vaultRoot = useAppStore.getState().vaultPath;
      if (!path || !vaultRoot) return Decoration.none;
      const store = peekLinks(vaultRoot);
      if (!store) return Decoration.none; // 链接库未加载:先不标,加载后订阅会唤醒
      return buildDailyMarks(this.view, {
        path,
        links: store.forFile(path),
        todayDailyPath: dailyPathFor(vaultRoot, todayStamp()),
      });
    }

    update(u: ViewUpdate) {
      const pathChanged = u.transactions.some((t) =>
        t.effects.some((e) => e.is(setDocPath) || e.is(dailyLinksChanged)),
      );
      if (!u.docChanged && !u.viewportChanged && !pathChanged) return;
      this.marks = this.build();
    }
  },
  { decorations: (v) => v.marks },
);

export function dailyMarksExtension(): Extension {
  return dailyMarksPlugin;
}

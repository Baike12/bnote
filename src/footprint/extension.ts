import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { documentPath, setDocPath } from "@/editor/docPath";
import { todayStamp } from "@/editor/ops";
import { useAppStore } from "@/state/appStore";
import { openNote } from "@/app/actions";
import { dailyPathFor, isDailyPath } from "@/daily/model";
import { onFootprintsChanged, footprintsFor, todayFootprintEntries, footprintRevision, refreshFootprints } from "./store";
import {
  buildFootprintView,
  type FootprintView,
} from "./view";
import {
  FootprintWidget,
  currentFold,
  flipGroupFold,
  flipZoneFold,
  foldSignature,
} from "./widget";

/**
 * 今日足迹的两个编辑器面:
 *  - 日记侧 footprintZoneExtension:今天的日记文档末尾挂一个块级 widget
 *    (块装饰只能出自 StateField,与 livePreview.blockDecorationsField 同一
 *    约束)。索引为空时不挂——足迹区只在真有内容的那天出现。
 *  - 源文件侧 footprintMarksExtension:今天被收录的块首行打 pip 行装饰
 *    (与 daily/marks.ts 同一套「不参与行内布局」的几何纪律)。
 *
 * 索引在编辑器之外(noteDirty/refreshAll 在 store 里写),广播经
 * onFootprintsChanged 到这里,派发一个带 footprintChanged 的空事务唤醒重算
 * (可能嵌在别的 dispatch 之内,故延到微任务——与 dailyMarks 同款)。
 */

/** 空事务上的标记:足迹索引或折叠状态变了,装饰要重算。 */
export const footprintChanged = StateEffect.define<null>();

// ---------------------------------------------------------------- 日记侧:区 widget

interface ZoneValue {
  decos: DecorationSet;
  /** revision + 折叠签名 + 激活判定:不变则复用旧 DecorationSet,widget DOM 不重画。 */
  sig: string;
}

function isTodayDaily(state: EditorState): boolean {
  const path = documentPath(state);
  const vaultRoot = useAppStore.getState().vaultPath;
  return (
    path !== null &&
    vaultRoot !== null &&
    isDailyPath(path) &&
    path === dailyPathFor(vaultRoot, todayStamp())
  );
}

function buildZoneValue(state: EditorState): ZoneValue {
  if (!isTodayDaily(state)) return { decos: Decoration.none, sig: "off" };
  const entries = todayFootprintEntries();
  if (entries.length === 0) return { decos: Decoration.none, sig: "empty" };
  const viewData: FootprintView = buildFootprintView(entries);
  const widget = new FootprintWidget(viewData, currentFold());
  return {
    decos: Decoration.set([
      // 锚在文档末尾(公式块同款约束:块 widget 锚行首;文档末尾即 doc.length)。
      Decoration.widget({ widget, block: true }).range(state.doc.length),
    ]),
    sig: `${footprintRevision()}|${foldSignature()}|${state.doc.length}`,
  };
}

export const footprintZoneField = StateField.define<ZoneValue>({
  create: buildZoneValue,
  update(value, tr) {
    const wake = tr.effects.some((e) => e.is(footprintChanged) || e.is(setDocPath));
    if (!tr.docChanged && !wake) return value;
    const next = buildZoneValue(tr.state);
    if (!tr.docChanged && next.sig === value.sig) return value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decos),
});

// ---------------------------------------------------------------- 点击路由

/** widget DOM 上的 data-footprint-* 点击路由(与 livePreview 的 mousedown
 *  handler 同一套模式):区/组箭头折叠,组名与块体跳源文件。 */
function footprintMousedown(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      const el = target?.closest?.("[data-footprint-action]") as HTMLElement | null;
      if (!el) return false;
      const action = el.dataset.footprintAction;
      if (action === "toggle-zone") {
        flipZoneFold();
        wakeView(view);
        return true;
      }
      if (action === "toggle-group") {
        const path = el.dataset.footprintPath;
        if (path) {
          flipGroupFold(path);
          wakeView(view);
        }
        return true;
      }
      if (action === "open-block" || action === "open-group") {
        const path = el.dataset.footprintPath;
        if (!path) return true;
        const line = Number(el.dataset.footprintLine);
        void openNote(path, Number.isFinite(line) && line > 0 ? line : undefined);
        return true;
      }
      return false;
    },
  });
}

// ---------------------------------------------------------------- 唤醒

function wakeView(view: EditorView): void {
  queueMicrotask(() => {
    if (view.dom.isConnected) view.dispatch({ effects: footprintChanged.of(null) });
  });
}

/** store 广播 → 唤醒事务;顺带值守「文档变成今日日记」:全量兜底重建索引
 *  (覆盖应用未运行期间的改动——watcher 只报运行期变更,重启后无脏路径可喂)。
 *  refreshFootprints 自带节流,快速来回切文件不重复全库读。 */
function footprintWakeExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      private unsubscribe: () => void;

      constructor(private view: EditorView) {
        this.unsubscribe = onFootprintsChanged(() => wakeView(this.view));
        void this.maybeFullRefresh();
      }

      update(u: ViewUpdate) {
        if (!u.transactions.some((t) => t.effects.some((e) => e.is(setDocPath)))) return;
        void this.maybeFullRefresh();
      }

      private async maybeFullRefresh(): Promise<void> {
        const path = documentPath(this.view.state);
        const vaultRoot = useAppStore.getState().vaultPath;
        if (!path || !vaultRoot || path !== dailyPathFor(vaultRoot, todayStamp())) return;
        await refreshFootprints();
        wakeView(this.view);
      }

      destroy() {
        this.unsubscribe();
      }
    },
  );
}

// ---------------------------------------------------------------- 源文件侧:pip

/** 构建只需要的视图面(与 dailyMarks 的 DailyMarkView 同构,便于无 DOM 测试)。 */
export interface FootprintMarkView {
  state: EditorState;
  visibleRanges: readonly { from: number; to: number }[];
}

/** 视口内、今日收录块的首行 → 行装饰。纯函数。 */
export function buildFootprintMarks(view: FootprintMarkView, blocks: readonly { start: number }[]): DecorationSet {
  if (blocks.length === 0 || view.visibleRanges.length === 0) return Decoration.none;
  const doc = view.state.doc;
  const starts = new Set(blocks.map((b) => b.start));
  const from = Math.min(...view.visibleRanges.map((r) => r.from));
  const to = Math.max(...view.visibleRanges.map((r) => r.to));
  const mark = Decoration.line({
    class: "md-footprint",
    attributes: { title: "今日足迹已收录到今日日记" },
  });
  const out: Range<Decoration>[] = [];
  for (let n = doc.lineAt(from).number; ; n++) {
    if (starts.has(n)) out.push(mark.range(doc.line(n).from));
    const line = doc.line(n);
    if (line.to >= to || line.to >= doc.length) break;
  }
  return Decoration.set(out, true);
}

const footprintMarksPlugin = ViewPlugin.fromClass(
  class {
    marks: DecorationSet = Decoration.none;
    private unsubscribe: () => void;

    constructor(private view: EditorView) {
      this.unsubscribe = onFootprintsChanged(() => wakeView(this.view));
      this.marks = this.build();
    }

    destroy() {
      this.unsubscribe();
    }

    private build(): DecorationSet {
      const state = this.view.state;
      const path = documentPath(state);
      // 源侧才打标;日记文件(自己就是聚合页)不打
      if (!path || isDailyPath(path)) return Decoration.none;
      return buildFootprintMarks(this.view, footprintsFor(path));
    }

    update(u: ViewUpdate) {
      const pathChanged = u.transactions.some((t) =>
        t.effects.some((e) => e.is(setDocPath) || e.is(footprintChanged)),
      );
      if (!u.docChanged && !u.viewportChanged && !pathChanged) return;
      this.marks = this.build();
    }
  },
  { decorations: (v) => v.marks },
);

// ---------------------------------------------------------------- 组装

export function footprintZoneExtension(): Extension {
  return [footprintZoneField, footprintMousedown(), footprintWakeExtension()];
}

export function footprintMarksExtension(): Extension {
  return footprintMarksPlugin;
}

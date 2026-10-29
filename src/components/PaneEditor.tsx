import { useEffect, useRef } from "react";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createEditor, loadDocument } from "@/editor/setup";
import { registerEditorView, unregisterEditorView } from "@/editor/api";
import { applySettingsToEditor } from "@/app/actions";

const AUTOSAVE_DELAY = 800;

export interface PaneEditorProps {
  /** 当前装的文件(null = 空文档)。 */
  path: string | null;
  /** 切换文件时读文档。 */
  load: (path: string) => Promise<string>;
  /** 自动保存/切换前冲刷时写文档。 */
  save: (path: string, text: string) => Promise<void>;
  /** 每次文档变化立即通知(项目卡片用来更新内存缓存)。 */
  onSnapshot?: (path: string, text: string) => void;
  /** 建实例时固定的额外扩展(拖拽手柄等)。 */
  extraExtensions?: Extension[];
  /** 是否允许「输入待办自动发送到今日日记」;项目卡片传 false。 */
  allowAutoSend?: boolean;
  className?: string;
  /** 实例创建/销毁时回调(命令层要直接 focus 它)。 */
  onViewChange?: (view: EditorView | null) => void;
}

/**
 * 项目视图里的一块编辑器(项目卡片 / 右栏日记共用)。
 *
 * 与 `EditorPane` 的区别:整份文件的生命周期由 props 驱动(路径一变就换文档),
 * 自动保存写自己那一份,不碰全局 currentFile / dirty。切文件前先把没落盘的
 * 内容冲刷出去——项目卡片之间靠切换聚焦来轮转,漏一次就是丢一笔输入。
 */
export function PaneEditor(props: PaneEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const pathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最近一次挂载的 props:创建编辑器的 effect 只跑一次,其余读取走这里。 */
  const propsRef = useRef(props);
  propsRef.current = props;
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = createEditor(
      host,
      "",
      {
        onDocChanged: () => {
          const path = pathRef.current;
          if (!path) return;
          const text = view.state.doc.toString();
          propsRef.current.onSnapshot?.(path, text);
          dirtyRef.current = true;
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            flushRef.current();
          }, AUTOSAVE_DELAY);
        },
        onCursorMoved: () => {},
      },
      {
        allowAutoSend: propsRef.current.allowAutoSend,
        extraExtensions: propsRef.current.extraExtensions,
      },
    );
    viewRef.current = view;

    const flush = () => {
      const path = pathRef.current;
      if (!path || !dirtyRef.current) return;
      dirtyRef.current = false;
      propsRef.current.onSnapshot?.(path, view.state.doc.toString());
      void propsRef.current
        .save(path, view.state.doc.toString())
        .catch((e) => console.warn("pane save failed", e));
    };
    flushRef.current = flush;

    registerEditorView(view);
    propsRef.current.onViewChange?.(view);
    void applySettingsToEditor(view);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flush();
      view.destroy();
      unregisterEditorView(view);
      viewRef.current = null;
      pathRef.current = null;
      propsRef.current.onViewChange?.(null);
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = props.path;
    if (pathRef.current === next) return;
    flushRef.current();
    pathRef.current = next;
    dirtyRef.current = false;
    if (!next) {
      loadDocument(view, "");
      return;
    }
    let cancelled = false;
    void props.load(next).then((text) => {
      // 读盘回来时目标可能又换了(快速连点切换):只认当前路径。
      if (cancelled || pathRef.current !== next) return;
      loadDocument(view, text, next);
    });
    return () => {
      cancelled = true;
    };
    // props.load 走 ref 读取,这里只跟随路径变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  return <div className={props.className ?? "pane-editor"} ref={hostRef} />;
}

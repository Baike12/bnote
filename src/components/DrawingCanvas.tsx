import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { api } from "@/lib/tauri";
import {
  parseDrawingFile,
  serializeDrawingFile,
  type DrawingScene,
} from "@/lib/excalidrawFile";
import { useAppStore, type DrawingSession } from "@/state/appStore";
import { afterDrawingClosed, drawingPngPath } from "@/app/drawing";
import { setCommandKeysSuspended } from "@/commands/globalKeys";
import { fileName } from "@/lib/path";

/**
 * 全屏画布浮层(盖过所有模态和学习模式的原生子 webview)。
 *
 * 性能契约:
 * - excalidraw 是独立 chunk,只在画布打开时下载;App 静态引用的只有本外壳。
 * - 画布 onChange 在拖拽时每帧都发:回调里只写 ref + 重置防抖定时器,
 *   绝不 setState——React 重渲染和保存都以 600ms 防抖节流。
 * - 保存是唯一写入者:串行化调度(in-flight 时只记「还要再存」,完成后补),
 *   不并发写盘;内容没变(序列化相等)直接跳过。
 */

// Excalidraw 按这个基准相对寻址字体(`fonts/<Family>/…`),由 vite 插件在
// dev/build 两侧落到本地文件;必须在它的 chunk 执行前就位。
(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  "/excalidraw-assets/";

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })),
);

const SAVE_DEBOUNCE_MS = 600;

interface SceneSnapshot {
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown> | null;
}

const exApi: { current: ExcalidrawImperativeAPI | null } = { current: null };

export default function DrawingCanvas() {
  const session = useAppStore((s) => s.drawingSession);
  if (!session) return null;
  // key = 路径:换文件必然重挂,画布内部状态绝不跨文件复用。
  return <CanvasInner key={session.path} session={session} />;
}

function CanvasInner({ session }: { session: DrawingSession }) {
  const [scene, setScene] = useState<DrawingScene | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  const [saving, setSaving] = useState(false);

  /** onChange 的最新一帧;只在防抖到点时被读,拖拽路径零渲染开销。 */
  const latest = useRef<SceneSnapshot | null>(null);
  /** .excalidraw.md 的包裹头,写回时原样保留(打开时解析一次)。 */
  const mdWrapper = useRef<string | null>(null);
  const lastWritten = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const rerunAfter = useRef(false);
  const alive = useRef(true);

  // ---- 载入场景 ------------------------------------------------------------
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const text = await api.readFile(session.path);
        if (cancelled) return;
        const parsed = parseDrawingFile(text, fileName(session.path));
        mdWrapper.current = parsed.mdWrapper;
        setScene(parsed.scene);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      exApi.current = null; // 不让卸载的实例被引用钉在内存里
    };
  }, [session.path]);

  // ---- 保存调度(唯一写入者,串行) -----------------------------------------
  const runSave = useCallback(async () => {
    const snap = latest.current;
    if (!snap || !alive.current) return;
    if (inFlight.current) {
      rerunAfter.current = true; // 正在写盘:完成后补一轮,绝不并发写
      return;
    }
    const path = session.path;
    const json = serializeDrawingFile(
      snap as unknown as DrawingScene,
      fileName(path),
      mdWrapper.current,
    );
    if (json === lastWritten.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await api.writeFile(path, json);
      lastWritten.current = json;
      const count = (snap.elements as { isDeleted?: boolean }[]).filter(
        (el) => !el.isDeleted,
      ).length;
      if (count > 0) await exportPng(snap, path);
    } catch (e) {
      lastWritten.current = null; // 写失败:下次必须重写
      useAppStore.getState().showToast(`画布保存失败: ${String(e)}`);
    } finally {
      inFlight.current = false;
      if (alive.current) setSaving(false);
      if (rerunAfter.current) {
        rerunAfter.current = false;
        void runSave();
      }
    }
  }, [session.path]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void runSave();
    }, SAVE_DEBOUNCE_MS);
  }, [runSave]);

  const onChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      latest.current = {
        elements,
        appState: appState as Record<string, unknown>,
        files: (files ?? null) as Record<string, unknown> | null,
      };
      const enabled = (appState as { objectsSnapModeEnabled?: boolean })
        .objectsSnapModeEnabled;
      if (typeof enabled === "boolean") setSnapOn(enabled);
      scheduleSave();
    },
    [scheduleSave],
  );

  /** 关闭前把未落盘的改动写掉;返回场景是否为空(空的新图要撤嵌入删文件)。 */
  const flushNow = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (latest.current) await runSave();
    const els = (latest.current?.elements ?? []) as { isDeleted?: boolean }[];
    return els.every((el) => el.isDeleted);
  }, [runSave]);

  const close = useCallback(async () => {
    const empty = await flushNow();
    await afterDrawingClosed(session, empty);
  }, [flushNow, session]);

  // 命令快捷键在画布打开期间整体挂起(见 globalKeys);这里只留画布自己的。
  // 页面隐藏(切走/关窗)时立刻冲一次盘,减少丢尾。
  useEffect(() => {
    setCommandKeysSuspended(true);
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flushNow();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      setCommandKeysSuspended(false);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [flushNow]);

  const onOverlayKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void close();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void flushNow();
      }
    },
    [close, flushNow],
  );

  return (
    <div className="drawing-overlay" onKeyDownCapture={onOverlayKeyDown}>
      <div className="drawing-topbar">
        <span className="drawing-title" title={session.path}>
          {fileName(session.path)}
          <span className={saving ? "drawing-save busy" : "drawing-save"}>
            {saving ? "保存中…" : "已保存"}
          </span>
        </span>
        <span className="spacer" />
        <button
          className={`btn drawing-snap${snapOn ? " on" : ""}`}
          title="拖动元素时对齐其他元素的边界/中心(Alt+S 也可切换)"
          onClick={() => {
            const next = !snapOn;
            setSnapOn(next);
            exApi.current?.updateScene({
              appState: { objectsSnapModeEnabled: next },
            });
          }}
        >
          {snapOn ? "⇥ 边界吸附:开" : "⇥ 边界吸附:关"}
        </button>
        <button className="btn drawing-done" onClick={() => void close()}>
          完成 ⌘↩
        </button>
      </div>
      <div className="drawing-body">
        {loadError ? (
          <div className="drawing-error">
            <p>画图文件读取失败</p>
            <pre>{loadError}</pre>
            <button
              className="btn"
              onClick={() => void afterDrawingClosed(session, false)}
            >
              关闭
            </button>
          </div>
        ) : scene === null ? (
          <div className="drawing-loading">加载画布…</div>
        ) : (
          <Suspense fallback={<div className="drawing-loading">加载画布…</div>}>
            <Excalidraw
              initialData={{
                elements: scene.elements as never[],
                appState: {
                  viewBackgroundColor:
                    typeof scene.appState.viewBackgroundColor === "string"
                      ? scene.appState.viewBackgroundColor
                      : "#ffffff",
                  // 对齐是 bnote 的默认体验:每次打开都回到吸附态(Alt+S 可临时关)。
                  objectsSnapModeEnabled: true,
                  // 飞书式简洁风:干净直线 + 等宽字体(不用 excalidraw 手绘风)。
                  currentItemRoughness: 0,
                  currentItemFontFamily: 3,
                },
                files: (scene.files ?? undefined) as never,
              }}
              langCode="zh-CN"
              onChange={onChange}
              excalidrawAPI={(api) => {
                exApi.current = api;
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** 导出 2x PNG 预览到画图旁边的同名 .png(笔记里的嵌入就渲染它)。 */
async function exportPng(snap: SceneSnapshot, drawingPath: string): Promise<void> {
  const { exportToBlob } = await import("@excalidraw/excalidraw");
  const opts = {
    elements: snap.elements,
    appState: { ...(snap.appState as object), exportBackground: true },
    files: snap.files ?? null,
    mimeType: "image/png",
    exportPadding: 32,
    getDimensions: (width: number, height: number) => ({
      width: width * 2,
      height: height * 2,
      scale: 2,
    }),
  } as unknown as Parameters<typeof exportToBlob>[0];
  const blob = await exportToBlob(opts);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  await api.writeFileBase64(drawingPngPath(drawingPath), dataUrl.slice(dataUrl.indexOf(",") + 1));
}

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  beginDrawingSave,
  finalizeDrawingSession,
  flushDrawingSave,
  loadDrawingScene,
  subscribeDrawingSave,
} from "@/app/drawing";
import { setCommandKeyContext } from "@/commands/globalKeys";
import { bindingsForCommand, formatBinding } from "@/commands/keys";
import { useAppStore } from "@/state/appStore";
import { fileName } from "@/lib/path";

/**
 * 全屏画布浮层(盖过所有模态和学习模式的原生子 webview)。
 *
 * 性能契约:
 * - excalidraw 是独立 chunk,只在画布打开时下载;App 静态引用的只有本外壳。
 * - 画布 onChange 在拖拽时每帧都发:这里只写模块级调度(见 app/drawing.ts)
 *   和一个吸附开关,绝不 setState——保存与渲染都以 600ms 防抖节流。
 *
 * 对齐策略:吸附只在「移动/调整已有元素」时生效;正在拖出新元素(新建)
 * 时不吸附——否则新画的形状会被旁边的图形拉歪,画的时候无法对齐到纸面意图。
 */

// Excalidraw 按这个基准相对寻址字体(`fonts/<Family>/…`),由 vite 插件在
// dev/build 两侧落到本地文件;必须在它的 chunk 执行前就位。
(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  "/excalidraw-assets/";

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })),
);

const exApi: { current: ExcalidrawImperativeAPI | null } = { current: null };

export default function DrawingCanvas() {
  const session = useAppStore((s) => s.drawingSession);
  if (!session) return null;
  // key = 路径:换文件必然重挂,画布内部状态绝不跨文件复用。
  return <CanvasInner key={session.path} session={session} />;
}

function CanvasInner({ session }: { session: import("@/state/appStore").DrawingSession }) {
  const [scene, setScene] = useState<import("@/lib/excalidrawFile").DrawingScene | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ---- 载入场景 ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const parsed = await loadDrawingScene(session.path);
        if (!cancelled) setScene(parsed);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    const off = subscribeDrawingSave(setSaving);
    return () => {
      cancelled = true;
      off();
      exApi.current = null; // 不让卸载的实例被引用钉在内存里
    };
  }, [session.path]);

  // 画布打开期间命令快捷键只放行快速跳转/命令面板(见 globalKeys);
  // 页面隐藏(切走/关窗)时立刻冲一次盘,减少丢尾。
  useEffect(() => {
    setCommandKeyContext("drawing");
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flushDrawingSave();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      setCommandKeyContext(null);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  /** 用户的吸附偏好(Alt+S 可改);新建元素期间被临时压成 false。 */
  const userSnap = useRef(true);
  /** 我们上次注入的值:区分「用户改了偏好」和「我们自己的临时关闭回声」。 */
  const forcedSnap = useRef(true);

  const onChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      const as = appState as {
        newElement?: unknown;
        objectsSnapModeEnabled?: boolean;
      };
      beginDrawingSave({
        elements,
        appState: as as Record<string, unknown>,
        files: (files ?? null) as Record<string, unknown> | null,
      });

      // 动态吸附:拖出新元素时关,其余时候回到用户偏好。
      // 注意 userSnap 只在 stateSnap ≠ 我们注入值 时更新——手势结束时
      // stateSnap 还是我们注的 false,不能当成用户偏好读回来。
      const creating = as.newElement != null;
      const stateSnap = as.objectsSnapModeEnabled !== false;
      if (!creating && stateSnap !== forcedSnap.current) {
        userSnap.current = stateSnap; // Alt+S 之类的用户操作
      }
      const desired = creating ? false : userSnap.current;
      forcedSnap.current = desired;
      if (stateSnap !== desired) {
        const api = exApi.current;
        if (api) queueMicrotask(() => api.updateScene({ appState: { objectsSnapModeEnabled: desired } }));
      }
    },
    [],
  );

  const close = useCallback(() => void finalizeDrawingSession(), []);

  const onOverlayKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void flushDrawingSave();
      }
    },
    [close],
  );

  return (
    <div className="drawing-overlay" onKeyDownCapture={onOverlayKeyDown}>
      <div className="drawing-topbar" data-tauri-drag-region>
        <span className="drawing-title" data-tauri-drag-region title={session.path}>
          {fileName(session.path)}
          <span className={saving ? "drawing-save busy" : "drawing-save"}>
            {saving ? "保存中…" : "已保存"}
          </span>
        </span>
        <span className="drawing-hint">
          ⌘↩ 返回笔记 · {formatBinding(bindingsForCommand("nav.quick-switcher")[0] ?? "Mod-o")} 切换文件
        </span>
      </div>
      <div className="drawing-body">
        {loadError ? (
          <div className="drawing-error">
            <p>画图文件读取失败</p>
            <pre>{loadError}</pre>
            <button className="btn" onClick={close}>
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
                  // 对齐是 bnote 的默认体验:每次打开都回到吸附态(新建元素时
                  // 自动临时关闭,见 onChange)。
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

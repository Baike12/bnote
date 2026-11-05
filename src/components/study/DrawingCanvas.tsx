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
 * Fullscreen canvas overlay (it covers every modal and the native child
 * webviews of study mode).
 *
 * Performance contract:
 * - excalidraw is a separate chunk, downloaded only when the canvas opens;
 *   the App statically imports nothing but this shell.
 * - The canvas fires onChange on every frame of a drag: here we only write
 *   module-level scheduling (see app/drawing.ts) and one snap switch, never
 *   setState; saving and rendering are both debounced to 600 ms.
 *
 * Alignment policy: snapping only applies when moving or resizing an
 * existing element; while a new element is being dragged out it is off,
 * otherwise a freshly drawn shape gets pulled crooked by its neighbours and
 * cannot be aligned to the intent of the paper.
 */

// Excalidraw addresses its fonts relative to this base path
// (`fonts/<Family>/...`); the vite plugin materializes them as local files on
// both dev and build, so it must be in place before its chunk executes.
(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })),
);

const exApi: { current: ExcalidrawImperativeAPI | null } = { current: null };

export default function DrawingCanvas() {
  const session = useAppStore((s) => s.drawingSession);
  if (!session) return null;
  // key = path: switching file always remounts, the canvas state is never reused across files.
  return <CanvasInner key={session.path} session={session} />;
}

function CanvasInner({ session }: { session: import("@/state/appStore").DrawingSession }) {
  const [scene, setScene] = useState<import("@/lib/excalidrawFile").DrawingScene | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ---- load the scene ------------------------------------------------------
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
      exApi.current = null; // do not let the unmounted instance be pinned in memory by a reference
    };
  }, [session.path]);

  // While the canvas is open the command shortcuts only let the quick
  // switcher and the palette through (see globalKeys); when the page is
  // hidden (switched away, window closed) flush the save at once to lose
  // less of the tail.
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

  /** The user's snapping preference (Alt+S toggles it); temporarily forced to false while a new element is created. */
  const userSnap = useRef(true);
  /** The value we injected last: tells "the user changed the preference" apart from "our own temporary override echoing back". */
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

      // Dynamic snapping: off while a new element is dragged out, back to the
      // user preference otherwise. Note that userSnap is only updated when
      // stateSnap differs from the value we injected: at the end of a gesture
      // stateSnap is still the false we injected and must not be read back as
      // the user preference.
      const creating = as.newElement != null;
      const stateSnap = as.objectsSnapModeEnabled !== false;
      if (!creating && stateSnap !== forcedSnap.current) {
        userSnap.current = stateSnap; // a user action such as Alt+S
      }
      const desired = creating ? false : userSnap.current;
      forcedSnap.current = desired;
      if (stateSnap !== desired) {
        const api = exApi.current;
        if (api)
          queueMicrotask(() => api.updateScene({ appState: { objectsSnapModeEnabled: desired } }));
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
          ⌘↩ 返回笔记 · {formatBinding(bindingsForCommand("nav.quick-switcher")[0] ?? "Mod-o")}{" "}
          切换文件
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
                  // Alignment is bnote's default experience: every open
                  // starts in snapping mode (temporarily switched off while
                  // creating an element, see onChange).
                  objectsSnapModeEnabled: true,
                  // Feishu-like minimal look: clean straight lines and a
                  // monospace font (not excalidraw's hand-drawn style).
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

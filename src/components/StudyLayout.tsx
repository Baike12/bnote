import { useRef } from "react";
import { AgentPanel } from "./AgentPanel";
import { ContentPane } from "./ContentPane";
import { EditorPane } from "./EditorPane";
import { StudyRightTabs } from "./StudyRightTabs";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName } from "@/lib/path";
import { dragContentEdge } from "@/study/layoutModel";

/**
 * Study-mode two-column layout: content (left) + right pane with a
 * 笔记 / 学习助手 tab, and a draggable divider.
 *
 * 中栏宽度按像素存进 settings(`studyContentWidth`),右栏吃剩余宽度:拖窗口
 * 边缘只会改中栏,右栏不动——笔记/助手的内容宽度因此稳定。窗口窄到放不下时
 * CSS 的 clamp 压缩中栏(见 global.css 的 --content-w),不改用户偏好。
 *
 * 拖动期间把像素直接写进 CSS 变量(不 setState):面板里有 CodeMirror,
 * 60Hz 重渲染代价太大;指针抬起时一次性提交。
 *
 * 右栏两个页签**都常驻挂载**,非活动页签 visibility:hidden(不是卸载):
 * 切页签零重挂、零重测——CodeMirror 的装饰和滚动位置原样保留,这是手感要求。
 *
 * 右栏头部带 `data-tauri-drag-region="deep"`(AgentPanel 头部同):标题栏
 * (Overlay 样式)在学习模式下整条不渲染,没有它就一处都拖不动窗口。
 * `deep` 而不是裸属性——裸属性只认直接点在带属性的那个元素上,点在标题文字
 * (子 span)上不算;`deep` 走进整棵子树,而 Tauri 的 drag.js 遇到可点元素
 * (button/input/…)本身就截断,所以头部里的按钮照常可点。
 */
export function StudyLayout() {
  const contentWidth = useAppStore((s) => s.settings.studyContentWidth);
  const rightTab = useAppStore((s) => s.settings.studyRightTab);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const currentFile = useAppStore((s) => s.currentFile);
  const hostRef = useRef<HTMLDivElement>(null);
  const noteTitle = currentFile
    ? fileName(currentFile).replace(/\.(md|markdown|txt)$/i, "")
    : "笔记";

  /** Starts the divider drag (content | right pane). */
  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width <= 0) return;
    event.preventDefault();

    // 新模型里内容栏宽度只由指针位置决定(dragContentEdge),不需要起点
    // 宽度;起点就落在眼前这条线上,不存在"从存值跳一下"的问题。

    const handle = event.currentTarget;
    handle.classList.add("dragging");
    // Pointer events are followed on the window (not the 8px handle) so the
    // drag survives fast moves and leaving the window.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // no active pointer (hover-less input / synthetic events)
    }

    let latest: number | null = null;

    const onMove = (move: PointerEvent) => {
      const x = move.clientX - hostRect.left;
      latest = dragContentEdge(x, hostRect.width);
      host.style.setProperty("--content-src", `${latest}px`);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      handle.classList.remove("dragging");
      // 提交 → React 用同样的像素值重渲染(clamp 由 CSS 负责)。
      const done = latest;
      if (done !== null && done !== contentWidth) {
        patchSettings({ studyContentWidth: done });
      }
      // 显示宽度(窗口窄时被 CSS 压过)不能当成新偏好写回变量:还原成存值。
      host.style.setProperty("--content-src", `${done ?? contentWidth}px`);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function resetSplit() {
    patchSettings({ studyContentWidth: DEFAULT_SETTINGS.studyContentWidth });
  }

  return (
    <div
      className="study-layout"
      ref={hostRef}
      style={
        {
          "--content-src": `${contentWidth}px`,
        } as React.CSSProperties
      }
    >
      <ContentPane />
      <div
        className="study-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整内容栏宽度"
        title="拖动调整宽度,双击恢复默认"
        onPointerDown={startDrag}
        onDoubleClick={resetSplit}
      />
      <div className="study-right">
        {/* 两个页签都常驻挂载(见组件注释):隐藏的是显示,不是存在。 */}
        <div className="study-right-body">
          <div
            className="study-right-page"
            data-tab="notes"
            data-inactive={rightTab !== "notes"}
          >
            {/* 学习模式没有 .titlebar,窗口的拖动区只剩各栏头部。 */}
            <div className="study-notes-head" data-tauri-drag-region="deep">
              <StudyRightTabs />
              <span className="study-notes-title">{noteTitle}</span>
            </div>
            <EditorPane />
          </div>
          <div
            className="study-right-page"
            data-tab="agent"
            data-inactive={rightTab !== "agent"}
          >
            <AgentPanel />
          </div>
        </div>
      </div>
    </div>
  );
}

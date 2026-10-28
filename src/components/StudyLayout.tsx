import { useRef } from "react";
import { AgentPanel } from "./AgentPanel";
import { ContentPane } from "./ContentPane";
import { EditorPane } from "./EditorPane";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName } from "@/lib/path";
import { dragAgentEdge, dragContentEdge } from "@/study/layoutModel";

/**
 * Study-mode three-column layout: agent (left) + content (middle) + notes
 * (right), with a draggable divider on each edge of the content column.
 *
 * 助手栏与中栏的宽度按像素存进 settings(`studyAgentWidth` /
 * `studyContentWidth`),笔记栏吃剩余宽度:拖窗口边缘只改笔记栏,前两栏不动
 * ——笔记/助手的内容宽度、PDF 页面尺寸因此稳定。窗口窄到放不下时,CSS 的
 * clamp 压缩前两栏(见 global.css 的 --agent-w / --content-w),不改用户偏好。
 *
 * 拖动期间把像素直接写进 CSS 变量(不 setState):面板里有 CodeMirror,
 * 60Hz 重渲染代价太大;指针抬起时一次性提交。指针位置就是列的边界,拖动
 * 不需要起点宽度——存值只用来在指针抬起时判断要不要提交。
 *
 * 三栏**都常驻挂载**:助手面板与笔记编辑器一直在树里,切内容/翻页零重挂、
 * 零重测——CodeMirror 的装饰和滚动位置原样保留,这是手感要求。
 *
 * 三栏头部都带 `data-tauri-drag-region="deep"`(AgentPanel 头部 / notes head):
 * 标题栏(Overlay 样式)在学习模式下整条不渲染,没有它就一处都拖不动窗口。
 * `deep` 而不是裸属性——裸属性只认直接点在带属性的那个元素上,点在标题文字
 * (子 span)上不算;`deep` 走进整棵子树,而 Tauri 的 drag.js 遇到可点元素
 * (button/input/…)本身就截断,所以头部里的按钮照常可点。
 *
 * 窗口红绿灯压在左栏头部:最左是助手栏,让位由 `.study-layout .agent-header`
 * 的 --study-lead 负责。
 */
export function StudyLayout() {
  const agentWidth = useAppStore((s) => s.settings.studyAgentWidth);
  const contentWidth = useAppStore((s) => s.settings.studyContentWidth);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const currentFile = useAppStore((s) => s.currentFile);
  const hostRef = useRef<HTMLDivElement>(null);
  const noteTitle = currentFile
    ? fileName(currentFile).replace(/\.(md|markdown|txt)$/i, "")
    : "笔记";

  /**
   * 一根分栏线的公共拖动骨架:指针移动时只写 CSS 变量,抬起时提交一次。
   * `toWidth(x)` 把「指针相对布局左缘的坐标」换算成这一栏的宽度。
   */
  function startDrag(
    event: React.PointerEvent<HTMLDivElement>,
    variable: "--agent-src" | "--content-src",
    stored: number,
    toWidth: (x: number) => number,
    commit: (width: number) => void,
  ) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width <= 0) return;
    event.preventDefault();

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
      const width = toWidth(move.clientX - hostRect.left);
      latest = width;
      host.style.setProperty(variable, `${width}px`);
      // 原生网页预览是挂在 DOM 之上的子 webview,只会按尺寸变化自己跟着挪;
      // 拖助手栏只平移内容栏、尺寸不变,需要这个信号让它重报矩形(见
      // ContentPane 的 previewSyncRef)。
      window.dispatchEvent(new Event("bnote:study-layout-resize"));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      handle.classList.remove("dragging");
      // 提交 → React 用同样的像素值重渲染(clamp 由 CSS 负责)。
      const done = latest;
      if (done !== null && done !== stored) commit(done);
      // 显示宽度(窗口窄时被 CSS 压过)不能当成新偏好写回变量:还原成存值。
      host.style.setProperty(variable, `${done ?? stored}px`);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** 助手|内容:助手栏拿指针位置。 */
  function startAgentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const hostWidth = hostRef.current?.getBoundingClientRect().width ?? 0;
    startDrag(
      event,
      "--agent-src",
      agentWidth,
      (x) => dragAgentEdge(x, hostWidth),
      (width) => patchSettings({ studyAgentWidth: width }),
    );
  }

  /** 内容|笔记:内容栏拿指针位置,左缘(助手栏)不动。 */
  function startContentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    // 内容栏左缘在拖动中不动(线只在中栏与笔记栏之间),量一次即可。
    const content = host.querySelector(".content-pane");
    if (!content) return;
    const contentLeft = content.getBoundingClientRect().left - hostRect.left;
    startDrag(
      event,
      "--content-src",
      contentWidth,
      (x) => dragContentEdge(x, hostRect.width, contentLeft),
      (width) => patchSettings({ studyContentWidth: width }),
    );
  }

  function resetAgentSplit() {
    patchSettings({ studyAgentWidth: DEFAULT_SETTINGS.studyAgentWidth });
  }

  function resetContentSplit() {
    patchSettings({ studyContentWidth: DEFAULT_SETTINGS.studyContentWidth });
  }

  return (
    <div
      className="study-layout"
      ref={hostRef}
      style={
        {
          "--agent-src": `${agentWidth}px`,
          "--content-src": `${contentWidth}px`,
        } as React.CSSProperties
      }
    >
      <div className="study-left">
        <AgentPanel />
      </div>
      <div
        className="study-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整学习助手宽度"
        title="拖动调整助手栏宽度,双击恢复默认"
        onPointerDown={startAgentDrag}
        onDoubleClick={resetAgentSplit}
      />
      <ContentPane />
      <div
        className="study-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整内容栏宽度"
        title="拖动调整内容栏宽度,双击恢复默认"
        onPointerDown={startContentDrag}
        onDoubleClick={resetContentSplit}
      />
      <div className="study-right">
        {/* 学习模式没有 .titlebar,窗口的拖动区只剩各栏头部。 */}
        <div className="study-notes-head" data-tauri-drag-region="deep">
          <span className="study-notes-title">{noteTitle}</span>
        </div>
        <EditorPane />
      </div>
    </div>
  );
}

import { useRef } from "react";
import { AgentPanel } from "./AgentPanel";
import { ContentPane } from "./ContentPane";
import { EditorPane } from "./EditorPane";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName } from "@/lib/path";
import { dragAgentEdge, dragContentEdge, RESIZER_WIDTH } from "@/study/layoutModel";

/**
 * Study-mode three-column layout: agent (left) + content (middle) + notes
 * (right), with a draggable divider on each edge of the content column.
 *
 * 助手栏与中栏的宽度按像素存进 settings(`studyAgentWidth` /
 * `studyContentWidth`),笔记栏吃剩余宽度:拖窗口边缘只改笔记栏,前两栏不动
 * ——笔记/助手的内容宽度、PDF 页面尺寸因此稳定。窗口窄到放不下时,CSS 的
 * clamp 压缩前两栏(见 global.css 的 --agent-w / --content-w),不改用户偏好。
 *
 * 拖分栏线只动相邻的两栏:宽度在相邻两栏之间转移,不相邻的那栏原地不动
 * (拖 助手|内容 不牵动笔记栏;拖 内容|笔记 不牵动助手栏)。每栏最小宽度是
 * 布局宽度的 10%,相邻栏到界时把线顶住(见 layoutModel)。
 *
 * 拖动期间把像素直接写进 CSS 变量(不 setState):面板里有 CodeMirror,
 * 60Hz 重渲染代价太大;指针抬起时一次性提交。拖动按**位移**算:起点是线
 * 当前的位置,握线偏了 4px 也不会跳一下。
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
   * `compute(dx)` 把「指针相对按下点的位移」换算成这次要写的几个变量;
   * `commit` 把同一组值提交进设置。
   */
  function startDrag(
    event: React.PointerEvent<HTMLDivElement>,
    variables: string[],
    stored: Record<string, number>,
    compute: (dx: number) => Record<string, number>,
    commit: (values: Record<string, number>) => void,
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

    const startX = event.clientX;
    let latest: Record<string, number> | null = null;

    const onMove = (move: PointerEvent) => {
      const values = compute(move.clientX - startX);
      latest = values;
      for (const [name, value] of Object.entries(values)) {
        host.style.setProperty(name, `${value}px`);
      }
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
      if (done) {
        const changed = variables.some((name) => done[name] !== stored[name]);
        if (changed) commit(done);
      }
      // 显示宽度(窗口窄时被 CSS 压过)不能当成新偏好写回变量:还原成存值。
      for (const name of variables) {
        host.style.setProperty(name, `${latest?.[name] ?? stored[name]}px`);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /**
   * 助手|内容:宽度在助手栏与中栏之间转移,笔记栏不动。
   * 起点量的是**屏幕上真实的两栏宽度**(CSS 可能夹过),位移从线的当前位置起算。
   */
  function startAgentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const left = host.querySelector(".study-left");
    const content = host.querySelector(".content-pane");
    if (!left || !content) return;
    const agent0 = left.getBoundingClientRect().width;
    const content0 = content.getBoundingClientRect().width;
    const sum = agent0 + content0;
    startDrag(
      event,
      ["--agent-src", "--content-src"],
      { "--agent-src": agentWidth, "--content-src": contentWidth },
      (dx) => {
        const widths = dragAgentEdge(agent0 + RESIZER_WIDTH + dx, hostRect.width, sum);
        return { "--agent-src": widths.agent, "--content-src": widths.content };
      },
      (values) =>
        patchSettings({
          studyAgentWidth: values["--agent-src"],
          studyContentWidth: values["--content-src"],
        }),
    );
  }

  /** 内容|笔记:宽度在中栏与笔记栏之间转移,助手栏不动。 */
  function startContentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    // 内容栏左缘在拖动中不动(线只在中栏与笔记栏之间),量一次即可。
    const content = host.querySelector(".content-pane");
    if (!content) return;
    const contentRect = content.getBoundingClientRect();
    const contentLeft = contentRect.left - hostRect.left;
    const content0 = contentRect.width;
    startDrag(
      event,
      ["--content-src"],
      { "--content-src": contentWidth },
      (dx) => {
        const widths = dragContentEdge(
          contentLeft + content0 + RESIZER_WIDTH + dx,
          hostRect.width,
          contentLeft,
        );
        return { "--content-src": widths.content };
      },
      (values) => patchSettings({ studyContentWidth: values["--content-src"] }),
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

import { useEffect, useRef, useState } from "react";
import { AgentPanel } from "./AgentPanel";
import { ContentPane } from "./ContentPane";
import { EditorPane } from "./EditorPane";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName } from "@/lib/path";
import {
  dragAgentEdge,
  dragContentEdge,
  normalizeSplit,
} from "@/study/layoutModel";

/**
 * Study-mode three-column layout with draggable dividers.
 *
 * 左(Agent)、中(内容)的宽度按像素存进 settings,右(笔记)吃剩余宽度:
 * 拖窗口边缘只会改笔记栏,中栏宽度不动——PDF 页面大小和纵向可见内容因此
 * 保持稳定。只有窗口窄到"笔记栏将小于下限"时,CSS 的 clamp 才会依次压缩
 * 中栏、左栏(见 global.css 的 --content-w / --agent-w),不改用户偏好。
 *
 * 拖动期间把像素直接写进 CSS 变量(不 setState):面板里有 CodeMirror,
 * 60Hz 重渲染代价太大;指针抬起时一次性提交。
 *
 * Agent 栏默认收起。收起后中栏保持自己的宽度、笔记栏吃掉空出来的空间;
 * 首次展开后 Agent 常驻挂载,聊天记录与会话都留着。
 *
 * 三栏的头部都带 `data-tauri-drag-region="deep"`(见各自的组件):标题栏
 * (Overlay 样式)在学习模式下整条不渲染,没有它就一处都拖不动窗口。
 * `deep` 而不是裸属性——裸属性只认直接点在带属性的那个元素上,点在标题文字
 * (子 span)上不算;`deep` 走进整棵子树,而 Tauri 的 drag.js 遇到可点元素
 * (button/input/…)本身就截断,所以头部里的按钮照常可点。
 */
export function StudyLayout() {
  const split = useAppStore((s) => s.settings.studySplit);
  const agentOpen = useAppStore((s) => s.settings.studyAgentOpen);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const currentFile = useAppStore((s) => s.currentFile);
  const hostRef = useRef<HTMLDivElement>(null);
  // 首次展开后才挂载 Agent:默认收起时不该发起会话/连接模型;之后收起只隐藏,
  // 聊天记录与会话都留着。
  const [agentMounted, setAgentMounted] = useState(agentOpen);
  useEffect(() => {
    if (agentOpen) setAgentMounted(true);
  }, [agentOpen]);

  // 旧配置的比例形式在 App 启动时已换算;这里再归一一次,防手改 config。
  const [agent, content] = normalizeSplit(split, window.innerWidth);
  const noteTitle = currentFile
    ? fileName(currentFile).replace(/\.(md|markdown|txt)$/i, "")
    : "笔记";

  /** Starts a drag: `edge` 0 = agent|content divider, 1 = content|notes. */
  function startDrag(edge: 0 | 1) {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const width = hostRect.width;
      if (width <= 0) return;
      event.preventDefault();

      // 用实际显示的宽度做基准(窗口变窄时 CSS 已经压缩过),拖动从眼前
      // 这条线继续,而不是从存着的偏好宽度跳一下。
      const agentEl = host.querySelector<HTMLElement>(".agent-panel");
      const contentEl = host.querySelector<HTMLElement>(".content-pane");
      const agentPx0 = agentOpen ? (agentEl?.getBoundingClientRect().width ?? agent) : 0;
      const contentPx0 = contentEl?.getBoundingClientRect().width ?? content;

      const handle = event.currentTarget;
      handle.classList.add("dragging");
      // Pointer events are followed on the window (not the 8px handle) so the
      // drag survives fast moves and leaving the window.
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // no active pointer (hover-less input / synthetic events)
      }

      let latest: [number, number] | null = null;

      const onMove = (move: PointerEvent) => {
        const x = move.clientX - hostRect.left;
        latest =
          edge === 0
            ? dragAgentEdge(x, agentPx0, contentPx0)
            : // 中|右分栏只动中栏;左栏写回存储值,不把窗口变窄时的显示
              // 宽度(被 CSS 压过)当成新偏好。
              [agent, dragContentEdge(x, agentPx0, width, agentOpen)];
        host.style.setProperty("--agent-src", `${latest[0]}px`);
        host.style.setProperty("--content-src", `${latest[1]}px`);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        handle.classList.remove("dragging");
        // 提交 → React 用同样的像素值重渲染(clamp 由 CSS 负责)。
        const done = latest;
        if (done && (done[0] !== agent || done[1] !== content)) {
          patchSettings({ studySplit: done });
        }
        // `--agent-src` 在只拖中|右分栏时可能被写成了「显示宽度」(窗口窄时
        // 小于存储宽度)。写回存储值,免得下次渲染前用错基准。
        host.style.setProperty("--agent-src", `${done ? done[0] : agent}px`);
        host.style.setProperty("--content-src", `${done ? done[1] : content}px`);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
  }

  function resetSplit() {
    patchSettings({ studySplit: DEFAULT_SETTINGS.studySplit });
  }

  return (
    <div
      className={`study-layout${agentOpen ? " agent-open" : " agent-closed"}`}
      ref={hostRef}
      style={
        {
          "--agent-src": `${agent}px`,
          "--content-src": `${content}px`,
        } as React.CSSProperties
      }
    >
      {agentMounted && <AgentPanel collapsed={!agentOpen} />}
      {agentOpen && (
        <div
          className="study-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整 Agent 面板宽度"
          title="拖动调整宽度,双击恢复默认"
          onPointerDown={startDrag(0)}
          onDoubleClick={resetSplit}
        />
      )}
      <ContentPane />
      <div
        className="study-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整内容栏宽度"
        title="拖动调整宽度,双击恢复默认"
        onPointerDown={startDrag(1)}
        onDoubleClick={resetSplit}
      />
      <div className="study-notes">
        {/* 学习模式没有 .titlebar,窗口的拖动区只剩三栏的头部。 */}
        <div className="study-notes-head" data-tauri-drag-region="deep">
          <span className="study-notes-title">{noteTitle}</span>
        </div>
        <EditorPane />
      </div>
    </div>
  );
}

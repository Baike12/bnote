import { useRef } from "react";
import { AgentPanel } from "./AgentPanel";
import { ContentPane } from "./ContentPane";
import { EditorPane } from "./EditorPane";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName } from "@/lib/path";

/**
 * Study-mode three-column layout with draggable dividers.
 *
 * Widths live in settings as fractions of the layout width (so a window resize
 * keeps the proportions) and are applied through CSS custom properties. During
 * a drag the properties are written to the DOM directly — re-rendering the two
 * panes (both host CodeMirror instances) on every pointer move would be far too
 * expensive — and the final fractions are committed once on pointer up.
 *
 * 三栏的头部都带 `data-tauri-drag-region="deep"`(见各自的组件):标题栏
 * (Overlay 样式)在学习模式下整条不渲染,没有它就一处都拖不动窗口。
 * `deep` 而不是裸属性——裸属性只认直接点在带属性的那个元素上,点在标题文字
 * (子 span)上不算;`deep` 走进整棵子树,而 Tauri 的 drag.js 遇到可点元素
 * (button/input/…)本身就截断,所以头部里的按钮照常可点。
 */

/** Resizer hit area (px, layout box). */
const RESIZER = 8;
const MIN_AGENT = 220;
const MIN_CONTENT = 260;
const MIN_NOTES = 220;
/** Keeps a hand-edited config.json from producing an unusable layout. */
const MIN_FRACTION = 0.05;
const MAX_SUM = 0.95;

export function normalizeSplit(split: unknown): [number, number] {
  const fallback = DEFAULT_SETTINGS.studySplit;
  if (!Array.isArray(split) || split.length !== 2) return fallback;
  const [a, c] = split.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
  if (Number.isNaN(a) || Number.isNaN(c)) return fallback;
  const agent = Math.min(Math.max(a, MIN_FRACTION), MAX_SUM - MIN_FRACTION);
  const content = Math.min(Math.max(c, MIN_FRACTION), MAX_SUM - agent);
  return [agent, content];
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

export function StudyLayout() {
  const split = useAppStore((s) => s.settings.studySplit);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const currentFile = useAppStore((s) => s.currentFile);
  const hostRef = useRef<HTMLDivElement>(null);

  const [agent, content] = normalizeSplit(split);
  const noteTitle = currentFile
    ? fileName(currentFile).replace(/\.(md|markdown|txt)$/i, "")
    : "笔记";

  /** Starts a drag: `edge` 0 = agent|content divider, 1 = content|notes. */
  function startDrag(edge: 0 | 1) {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (!host) return;
      const width = host.getBoundingClientRect().width;
      if (width <= 0) return;
      event.preventDefault();

      const agentPx0 = agent * width;
      const contentPx0 = content * width;
      // The pair separated by an inner divider keeps a constant sum: dragging
      // moves the border, it doesn't steal space from the third column.
      const pairSum = agentPx0 + contentPx0;
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
        const x = move.clientX - host.getBoundingClientRect().left;
        let agentPx = agentPx0;
        let contentPx = contentPx0;
        if (edge === 0) {
          agentPx = clamp(x, MIN_AGENT, pairSum - MIN_CONTENT);
          contentPx = pairSum - agentPx;
        } else {
          contentPx = clamp(
            x - agentPx0 - RESIZER,
            MIN_CONTENT,
            width - agentPx0 - RESIZER * 2 - MIN_NOTES,
          );
        }
        agentPx = Math.round(agentPx);
        contentPx = Math.round(contentPx);
        host.style.setProperty("--agent-w", `${agentPx}px`);
        host.style.setProperty("--content-w", `${contentPx}px`);
        latest = [agentPx / width, contentPx / width];
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        handle.classList.remove("dragging");
        // Commit → React re-renders the same widths as percentages.
        const done = latest;
        if (done && (done[0] !== agent || done[1] !== content)) {
          patchSettings({ studySplit: done });
        }
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
      className="study-layout"
      ref={hostRef}
      style={
        {
          "--agent-w": `${agent * 100}%`,
          "--content-w": `${content * 100}%`,
        } as React.CSSProperties
      }
    >
      <AgentPanel />
      <div
        className="study-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 Agent 面板宽度"
        title="拖动调整宽度,双击恢复默认"
        onPointerDown={startDrag(0)}
        onDoubleClick={resetSplit}
      />
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

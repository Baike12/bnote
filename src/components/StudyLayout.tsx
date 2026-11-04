import { useRef } from "react";
import { AgentPanel } from "./AgentPanel";
import { ContentPane } from "./ContentPane";
import { CreativePreview } from "./CreativePreview";
import { EditorPane } from "./EditorPane";
import { JsonFilePane } from "./JsonFilePane";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName, isJsonPath } from "@/lib/path";
import { dragAgentEdge, dragContentEdge, RESIZER_WIDTH } from "@/study/layoutModel";
import { startSplitDrag } from "./splitDrag";

/**
 * Study-mode three-column layout: agent (left) + content (middle) + notes
 * (right), with a draggable divider on each edge of the content column.
 *
 * The widths of the agent and content columns are stored in pixels in the
 * settings (`studyAgentWidth` / `studyContentWidth`), the notes column takes
 * the rest: dragging the window edge only changes the notes column, the
 * first two stay, so the content width of the notes and agent panes and the
 * PDF page size remain stable. When the window gets too narrow, the CSS clamp
 * shrinks the first two columns (see --agent-w / --content-w in global.css)
 * without touching the stored preference.
 *
 * Dragging a divider only moves the two adjacent columns: the width is
 * transferred between them, the column that is not adjacent stays put
 * (dragging agent|content does not move the notes column, dragging
 * content|notes does not move the agent column). The minimum width of a
 * column is 10% of the layout width and the divider is stopped at the limit
 * (see layoutModel).
 *
 * During the drag the pixels go straight into CSS variables (no setState):
 * the panes hold CodeMirror instances and a 60 Hz re-render is far too
 * expensive; the value is committed once, on pointerup. The drag is computed
 * from the **offset**: the origin is where the divider currently sits, so
 * grabbing it 4 px off does not make it jump.
 *
 * All three columns stay **mounted permanently**: the agent panel and the
 * notes editor live in the tree the whole time, so switching content or
 * turning a page causes zero remounts and zero re-measures, and CodeMirror's
 * decorations and scroll position survive untouched. That is a feel
 * requirement, not an optimization.
 *
 * All three column headers carry `data-tauri-drag-region="deep"` (the
 * AgentPanel header / notes head): the title bar (Overlay style) is not
 * rendered at all in study mode, without it not a single spot of the window
 * could be dragged. `deep` rather than the bare attribute, because the bare
 * attribute only counts a direct press on the element that carries it, not
 * on the title text (a child span); `deep` walks the whole subtree, while
 * Tauri's drag.js stops at clickable elements (button/input/...) on its own,
 * so the buttons in the header stay clickable.
 *
 * The macOS traffic lights sit on top of the leftmost header: that is the
 * agent column, and the clearance is handled by --study-lead of
 * `.study-layout .agent-header`.
 */
export function StudyLayout() {
  const agentWidth = useAppStore((s) => s.settings.studyAgentWidth);
  const contentWidth = useAppStore((s) => s.settings.studyContentWidth);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const currentFile = useAppStore((s) => s.currentFile);
  const creativeMode = useAppStore((s) => s.creativeMode);
  const hostRef = useRef<HTMLDivElement>(null);
  const noteTitle = currentFile
    ? fileName(currentFile).replace(/\.(md|markdown|txt)$/i, "")
    : "笔记";

  /**
   * Shared drag skeleton for one divider: `compute(dx)` turns the "pointer
   * offset from the press point" into the variables to write; the value is
   * committed once on pointerup (see splitDrag). The project view uses the
   * same one.
   */
  function startDrag(
    event: React.PointerEvent<HTMLDivElement>,
    variables: string[],
    stored: Record<string, number>,
    compute: (dx: number) => Record<string, number>,
    commit: (values: Record<string, number>) => void,
  ) {
    startSplitDrag({
      event,
      host: hostRef.current,
      variables,
      stored,
      compute,
      commit,
      // The native web preview is a child webview mounted above the DOM and
      // only follows size changes by itself; dragging the agent column only
      // translates the content column without resizing it, so this signal is
      // needed to make it re-report its bounds (see ContentPane's
      // previewSyncRef).
      onMove: () => window.dispatchEvent(new Event("bnote:study-layout-resize")),
    });
  }

  /**
   * agent|content: the width is transferred between the agent column and the
   * middle column, the notes column stays.
   * The origin measures the **real column widths on screen** (CSS may have
   * clamped them), and the offset is taken from the divider's current
   * position.
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

  /** content|notes: the width is transferred between the middle column and the notes column, the agent column stays. */
  function startContentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    // The left edge of the content column does not move during the drag (the divider sits between the middle and the notes column), so measuring once is enough.
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
      {creativeMode ? <CreativePreview /> : <ContentPane />}
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
        {/* Study mode has no .titlebar, so the only drag regions of the window are the column headers. */}
        <div className="study-notes-head" data-tauri-drag-region="deep">
          <span className="study-notes-title">{noteTitle}</span>
        </div>
        {isJsonPath(currentFile) ? <JsonFilePane /> : <EditorPane />}
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { AgentPanel } from "../agent/AgentPanel";
import { ContentPane } from "./ContentPane";
import { CreativePreview } from "./CreativePreview";
import { EditorPane } from "../EditorPane";
import { JsonFilePane } from "../JsonFilePane";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName, isJsonPath } from "@/lib/path";
import { dragLeftEdge, dragMiddleEdge, RESIZER_WIDTH } from "@/study/layoutModel";
import { startSplitDrag } from "../splitDrag";

/**
 * Study-mode three-column layout: agent (left) + content (middle) + notes
 * (right), with a draggable divider on each edge of the content column.
 *
 * The widths belong to the **columns**, not to the panes: the left column and
 * the middle column are stored in pixels in the settings
 * (`studyAgentWidth` / `studyContentWidth`), the notes column takes the rest.
 * Dragging the window edge only changes the notes column, the first two stay,
 * so the content width of the notes and agent panes and the PDF page size
 * remain stable. When the window gets too narrow, the CSS clamp shrinks the
 * first two columns (see --agent-w / --content-w in global.css) without
 * touching the stored preference.
 *
 * Because the widths belong to the columns, the focused swap (assistant and
 * content trade places) resizes both panes to the column they move into: the
 * three columns keep exactly the widths they had. Dragging a divider follows
 * the same rule — a divider always edits the columns it separates, whichever
 * pane is currently sitting there.
 *
 * Dragging a divider only moves the two adjacent columns: the width is
 * transferred between them, the column that is not adjacent stays put
 * (dragging left|middle does not move the notes column, dragging middle|notes
 * does not move the left column). The minimum width of a column is 10% of the
 * layout width and the divider is stopped at the limit (see layoutModel).
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
 * The macOS traffic lights sit on top of the leftmost header, and the focused
 * swap changes which column that is: the clearance is `--study-lead` and is
 * applied to the agent header by default, to the content header (PDF toolbar
 * or code toolbar) while `.agent-focused` moves the content column to the far
 * left. It must travel with the order, never stay on a fixed column.
 */
export function StudyLayout() {
  const agentWidth = useAppStore((s) => s.settings.studyAgentWidth);
  const contentWidth = useAppStore((s) => s.settings.studyContentWidth);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const mainColumn = useAppStore((s) => s.mainColumn);
  const setMainColumn = useAppStore((s) => s.setMainColumn);
  const swapped = mainColumn === "agent";
  const currentFile = useAppStore((s) => s.currentFile);
  const creativeMode = useAppStore((s) => s.creativeMode);
  const hostRef = useRef<HTMLDivElement>(null);
  const noteTitle = currentFile
    ? fileName(currentFile).replace(/\.(md|markdown|txt)$/i, "")
    : "笔记";

  // The native web preview is a child webview mounted above the DOM: it only
  // follows layout changes it is told about. The focused swap moves the
  // content pane into the left column and resizes it to that column's width,
  // so the signal is the only way it learns the new bounds (same channel as a
  // split drag).
  useEffect(() => {
    window.dispatchEvent(new Event("bnote:study-layout-resize"));
  }, [swapped]);

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
   * agent|content: the width is transferred between the first (left) and the
   * middle column, the notes column stays.
   * The origin measures the **real column widths on screen** (CSS may have
   * clamped them), and the offset is taken from the divider's current
   * position.
   *
   * The stored widths belong to the columns, not to the panes: while the
   * assistant column is focused the two panes trade places (see
   * .agent-focused in global.css) but the left column and the middle column
   * keep their own widths, so this divider always edits "left | middle" —
   * the panes are only the occupants.
   */
  function startAgentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const left = host.querySelector(".study-left");
    const content = host.querySelector(".content-pane");
    if (!left || !content) return;
    // Whichever pane sits on the left is the left column; the divider's left
    // neighbour is that one.
    const leftPane = swapped ? content : left;
    const middlePane = swapped ? left : content;
    const leftWidth = leftPane.getBoundingClientRect().width;
    const rightWidth = middlePane.getBoundingClientRect().width;
    const sum = leftWidth + rightWidth;
    startDrag(
      event,
      ["--agent-src", "--content-src"],
      { "--agent-src": agentWidth, "--content-src": contentWidth },
      (dx) => {
        const widths = dragLeftEdge(leftWidth + RESIZER_WIDTH + dx, hostRect.width, sum);
        return { "--agent-src": widths.left, "--content-src": widths.middle };
      },
      (values) =>
        patchSettings({
          studyAgentWidth: values["--agent-src"],
          studyContentWidth: values["--content-src"],
        }),
    );
  }

  /** content|notes: the width is transferred between the middle column and the notes column, the left column stays. */
  function startContentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    // The column left of this divider never moves while dragging, so
    // measuring once is enough. It is the middle column, whatever pane the
    // focused layout put there.
    const subject = host.querySelector(swapped ? ".study-left" : ".content-pane");
    if (!subject) return;
    const subjectRect = subject.getBoundingClientRect();
    const subjectLeft = subjectRect.left - hostRect.left;
    const subjectWidth = subjectRect.width;
    startDrag(
      event,
      ["--content-src"],
      { "--content-src": contentWidth },
      (dx) => {
        const widths = dragMiddleEdge(
          subjectLeft + subjectWidth + RESIZER_WIDTH + dx,
          hostRect.width,
          subjectLeft,
        );
        return { "--content-src": widths.middle };
      },
      (values) => patchSettings({ studyContentWidth: values["--content-src"] }),
    );
  }

  /** Double-click on a divider: restore that column's default width. */
  function resetLeftSplit() {
    patchSettings({ studyAgentWidth: DEFAULT_SETTINGS.studyAgentWidth });
  }

  function resetMiddleSplit() {
    patchSettings({ studyContentWidth: DEFAULT_SETTINGS.studyContentWidth });
  }

  return (
    <div
      className={`study-layout${swapped ? " agent-focused" : ""}`}
      ref={hostRef}
      onPointerDownCapture={(event) => {
        // A click is the explicit "I work here" signal: the middle column
        // follows it and stays there (the notes column never moves it).
        const target = event.target as HTMLElement;
        if (target.closest(".content-pane")) setMainColumn("content");
        else if (target.closest(".agent-panel")) setMainColumn("agent");
      }}
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
        className="study-resizer resizer-agent"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        title="拖动调整左栏宽度,双击恢复默认"
        onPointerDown={startAgentDrag}
        onDoubleClick={resetLeftSplit}
      />
      {creativeMode ? <CreativePreview /> : <ContentPane />}
      <div
        className="study-resizer resizer-content"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整中间栏宽度"
        title="拖动调整中间栏宽度,双击恢复默认"
        onPointerDown={startContentDrag}
        onDoubleClick={resetMiddleSplit}
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

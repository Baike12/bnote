import { useRef } from "react";
import { AgentPanel } from "../agent/AgentPanel";
import { CodeProjectPane } from "@/code/components/CodeProjectPane";
import { EditorPane } from "../EditorPane";
import { JsonFilePane } from "../JsonFilePane";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName, isJsonPath } from "@/lib/path";
import { dragAgentEdge, dragContentEdge, RESIZER_WIDTH } from "@/study/layoutModel";
import { startSplitDrag } from "../splitDrag";

/**
 * Code mode: agent (left) | code project (middle) | notes (right).
 *
 * It is the same three-column shape as study mode, but its own mode: a local
 * vault and a code repository are unrelated, so entering code mode must not
 * pretend the repository is a study material. The widths live in their own
 * settings (`codeAgentWidth` / `codeContentWidth`) so switching between the
 * two modes does not reshuffle the other one's columns.
 *
 * The drag discipline is identical to StudyLayout (see the long note there):
 * only the two adjacent columns move, the drag writes CSS variables, the
 * preference is committed once on pointerup, and the origin is measured from
 * the real on-screen widths so a CSS clamp cannot make the divider jump.
 */
export function CodeLayout() {
  const agentWidth = useAppStore((s) => s.settings.codeAgentWidth);
  const contentWidth = useAppStore((s) => s.settings.codeContentWidth);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const currentFile = useAppStore((s) => s.currentFile);
  const hostRef = useRef<HTMLDivElement>(null);
  const noteTitle = currentFile
    ? fileName(currentFile).replace(/\.(md|markdown|txt)$/i, "")
    : "笔记";

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
    });
  }

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
          codeAgentWidth: values["--agent-src"],
          codeContentWidth: values["--content-src"],
        }),
    );
  }

  function startContentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
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
      (values) => patchSettings({ codeContentWidth: values["--content-src"] }),
    );
  }

  return (
    <div
      className="study-layout code-layout"
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
        aria-label="调整助手栏宽度"
        title="拖动调整助手栏宽度,双击恢复默认"
        onPointerDown={startAgentDrag}
        onDoubleClick={() =>
          patchSettings({ codeAgentWidth: DEFAULT_SETTINGS.codeAgentWidth })
        }
      />
      <div className="content-pane code-mode-content">
        <CodeProjectPane />
      </div>
      <div
        className="study-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整代码栏宽度"
        title="拖动调整代码栏宽度,双击恢复默认"
        onPointerDown={startContentDrag}
        onDoubleClick={() =>
          patchSettings({ codeContentWidth: DEFAULT_SETTINGS.codeContentWidth })
        }
      />
      <div className="study-right">
        <div className="study-notes-head" data-tauri-drag-region="deep">
          <span className="study-notes-title">{noteTitle}</span>
        </div>
        {isJsonPath(currentFile) ? <JsonFilePane /> : <EditorPane />}
      </div>
    </div>
  );
}

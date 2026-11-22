import { useRef } from "react";
import { AgentPanel } from "../agent/AgentPanel";
import { CodeProjectPane } from "@/code/components/CodeProjectPane";
import { ProjectsSidebar } from "@/code/components/ProjectsSidebar";
import { WorktreeModal } from "@/code/components/WorktreeModal";
import { EditorPane } from "../EditorPane";
import { JsonFilePane } from "../JsonFilePane";
import { DEFAULT_SETTINGS, useAppStore } from "@/state/appStore";
import { fileName, isJsonPath } from "@/lib/path";
import { leftDividerWidths, middleDividerWidth } from "@/study/layoutModel";
import { projectsDividerWidth } from "@/code/projectsWidth";
import { startSplitDrag } from "../splitDrag";

/**
 * Code mode: projects (leftmost) | agent | code project | notes.
 *
 * The added column carries the project-and-session list, so the widths are
 * their own settings (`codeProjectsWidth` / `codeAgentWidth` /
 * `codeContentWidth`): entering code mode must not reshuffle the study
 * columns and vice versa.
 *
 * The drag discipline is identical to StudyLayout (see the long note there):
 * only the two adjacent columns move, the drag writes CSS variables, the
 * preference is committed once on pointerup, and the origin is measured from
 * the real on-screen widths so a CSS clamp cannot make the divider jump.
 */
export function CodeLayout() {
  const projectsOpen = useAppStore((s) => s.settings.codeProjectsOpen);
  const projectsWidth = useAppStore((s) => s.settings.codeProjectsWidth);
  const agentWidth = useAppStore((s) => s.settings.codeAgentWidth);
  const contentWidth = useAppStore((s) => s.settings.codeContentWidth);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const mainColumn = useAppStore((s) => s.mainColumn);
  const setMainColumn = useAppStore((s) => s.setMainColumn);
  const swapped = mainColumn === "agent";
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

  function startProjectsDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const projects = host.querySelector(".code-projects");
    const agent = host.querySelector(".study-left");
    const content = host.querySelector(".content-pane");
    if (!projects || !agent || !content) return;
    const projectsWidthNow = projects.getBoundingClientRect().width;
    // The columns to the right of this divider never move: their total is the
    // budget the projects column may not eat into.
    const reserved = agent.getBoundingClientRect().width + content.getBoundingClientRect().width;
    startDrag(
      event,
      ["--projects-src"],
      { "--projects-src": projectsWidth },
      (dx) => ({
        "--projects-src": projectsDividerWidth(
          { projectsWidth: projectsWidthNow, hostWidth: hostRect.width, reservedWidth: reserved },
          dx,
        ),
      }),
      (values) => patchSettings({ codeProjectsWidth: values["--projects-src"] }),
    );
  }

  function startAgentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const left = host.querySelector(".study-left");
    const content = host.querySelector(".content-pane");
    if (!left || !content) return;
    // The widths belong to the columns, so the divider always edits
    // left | middle; only the occupants change when the panes swap. The
    // projects column is not adjacent here and stays put.
    const leftWidth = (swapped ? content : left).getBoundingClientRect().width;
    const rightWidth = (swapped ? left : content).getBoundingClientRect().width;
    startDrag(
      event,
      ["--agent-src", "--content-src"],
      { "--agent-src": agentWidth, "--content-src": contentWidth },
      (dx) => {
        const widths = leftDividerWidths(
          { leftWidth, middleWidth: rightWidth, hostWidth: hostRect.width },
          dx,
        );
        return { "--agent-src": widths.left, "--content-src": widths.middle };
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
    const subject = host.querySelector(swapped ? ".study-left" : ".content-pane");
    if (!subject) return;
    const subjectRect = subject.getBoundingClientRect();
    const subjectLeft = subjectRect.left - hostRect.left;
    const subjectWidth = subjectRect.width;
    startDrag(
      event,
      ["--content-src"],
      { "--content-src": contentWidth },
      (dx) => ({
        "--content-src": middleDividerWidth(
          { middleLeft: subjectLeft, middleWidth: subjectWidth, hostWidth: hostRect.width },
          dx,
        ),
      }),
      (values) => patchSettings({ codeContentWidth: values["--content-src"] }),
    );
  }

  return (
    <div
      className={`study-layout code-layout${swapped ? " agent-focused" : ""}${
        projectsOpen ? " with-projects" : ""
      }`}
      ref={hostRef}
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".content-pane")) setMainColumn("content");
        else if (target.closest(".agent-panel")) setMainColumn("agent");
      }}
      style={
        {
          "--projects-src": `${projectsWidth}px`,
          "--agent-src": `${agentWidth}px`,
          "--content-src": `${contentWidth}px`,
        } as React.CSSProperties
      }
    >
      {projectsOpen && (
        <>
          <ProjectsSidebar />
          <div
            className="study-resizer resizer-projects"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整项目侧栏宽度"
            title="拖动调整项目侧栏宽度,双击恢复默认"
            onPointerDown={startProjectsDrag}
            onDoubleClick={() =>
              patchSettings({ codeProjectsWidth: DEFAULT_SETTINGS.codeProjectsWidth })
            }
          />
        </>
      )}
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
        onDoubleClick={() => patchSettings({ codeAgentWidth: DEFAULT_SETTINGS.codeAgentWidth })}
      />
      <div className="content-pane code-mode-content">
        <CodeProjectPane />
      </div>
      <div
        className="study-resizer resizer-content"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整中间栏宽度"
        title="拖动调整中间栏宽度,双击恢复默认"
        onPointerDown={startContentDrag}
        onDoubleClick={() => patchSettings({ codeContentWidth: DEFAULT_SETTINGS.codeContentWidth })}
      />
      <div className="study-right">
        <div className="study-notes-head" data-tauri-drag-region="deep">
          <span className="study-notes-title">{noteTitle}</span>
        </div>
        {isJsonPath(currentFile) ? <JsonFilePane /> : <EditorPane />}
      </div>
      <WorktreeModal />
    </div>
  );
}

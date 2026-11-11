import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "../store";
import { openProjectAt, openProjectDialog } from "../commands";
import { projectLabel, switchCandidates } from "../projectSwitch";

/**
 * The open project's name, in front of the toolbar's first button.
 *
 * Everything in this pane is scoped by that one directory — the tree, search,
 * the language servers, the agent's workdir — so the scope is stated where the
 * pane starts, and switching is one click instead of "close, then find the
 * empty state".
 *
 * The dropdown is the app's usual title-button + popover (`.content-title-btn`
 * / `.study-history-pop`), not a native `<select>`.
 */
export function ProjectSwitcher() {
  const project = useCodeStore((s) => s.project);
  const recent = useAppStore((s) => s.recentCodeProjects);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click outside / Escape closes. `pointerdown` (not `click`) so the list is
  // gone before the click lands on whatever is underneath.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // No project = the empty state, which already offers the picker and the
  // recent list; a second copy here would be redundant.
  if (!project) return null;

  const others = switchCandidates(recent, project.root);

  const switchTo = (root: string) => {
    // Close first: the switch flushes the buffers and rescans, and the list
    // must not float over the project it is about to replace.
    setOpen(false);
    void openProjectAt(root);
  };

  return (
    <div className="code-project-switch" ref={rootRef}>
      <button
        type="button"
        className={`content-title-btn code-project-btn${open ? " open" : ""}`}
        title={`当前项目:${project.root}\n点击切换项目`}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <span className="content-title">{project.name}</span>
        <span className="content-history-caret">▾</span>
      </button>
      {open && (
        <div className="study-history-pop code-project-pop" role="dialog" aria-label="切换代码项目">
          <div className="study-history-list">
            <button
              type="button"
              className="study-history-item is-current"
              title={project.root}
              onClick={() => setOpen(false)}
            >
              <span className="code-project-current-row">
                <span className="study-history-title">{project.name}</span>
                <span className="code-project-tag">当前</span>
              </span>
              <span className="study-history-sub">{project.root}</span>
            </button>
            {others.map((path) => (
              <button
                type="button"
                key={path}
                className="study-history-item"
                title={path}
                onClick={() => switchTo(path)}
              >
                <span className="study-history-title">{projectLabel(path)}</span>
                <span className="study-history-sub">{path}</span>
              </button>
            ))}
            <button
              type="button"
              className="study-history-action"
              onClick={() => {
                setOpen(false);
                void openProjectDialog();
              }}
            >
              ＋ 选择文件夹…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

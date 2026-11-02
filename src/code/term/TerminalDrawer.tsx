import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "../store";
import { applyTermTheme, fitTerminal, focusTerminal, mountTerminal, unmountTerminal } from "./session";

/**
 * The terminal drawer at the bottom of the code pane.
 *
 * The drawer is a **shell**: the emulator instances live in `session.ts` and
 * outlive this component (switching the study content unmounts the whole code
 * pane, and the scrollback must survive that). Here the active session is
 * re-parented into `.code-term-host`, resized with the drawer, and the tab strip
 * drives the store.
 */
export function TerminalDrawer() {
  const terminals = useCodeStore((s) => s.terminals);
  const activeId = useCodeStore((s) => s.activeTermId);
  const setActiveTerminal = useCodeStore((s) => s.setActiveTerminal);
  const closeTerminal = useCodeStore((s) => s.closeTerminal);
  const spawnTerminal = useCodeStore((s) => s.spawnTerminal);
  const restartTerminal = useCodeStore((s) => s.restartTerminal);
  const setTermOpen = useCodeStore((s) => s.setTermOpen);
  const theme = useAppStore((s) => s.settings.theme);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // The grid follows the host, not the terminal's own idea of its size: the
  // drawer is resized by dragging and by the pane's layout.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || activeId === null) return;
    let live = true;
    void mountTerminal(activeId, host).then(() => {
      if (!live) return;
      fitTerminal(activeId);
    });
    const observer = new ResizeObserver(() => fitTerminal(activeId));
    observer.observe(host);
    return () => {
      live = false;
      observer.disconnect();
      unmountTerminal(activeId, host);
    };
  }, [activeId]);

  // The app theme changed: the palette comes from CSS variables.
  useEffect(() => {
    applyTermTheme();
  }, [theme]);

  return (
    <div className="code-term">
      <div className="code-term-head">
        <div className="code-term-tabs">
          {terminals.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={`code-term-tab${tab.id === activeId ? " is-active" : ""}${
                tab.exited ? " is-exited" : ""
              }`}
              title={tab.exited ? `${tab.title}(已退出)` : tab.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setActiveTerminal(tab.id)}
            >
              <span className="code-term-tab-name">{tab.title}</span>
              <span
                className="code-term-tab-close"
                title="关闭这个终端"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTerminal(tab.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="code-term-btn"
          title="新建终端"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void spawnTerminal()}
        >
          +
        </button>
        <button
          type="button"
          className="code-term-btn"
          title="重启当前终端"
          disabled={activeId === null}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void restartTerminal()}
        >
          ↻
        </button>
        <button
          type="button"
          className="code-term-btn"
          title="收起终端(进程继续在后台运行)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setTermOpen(false)}
        >
          ×
        </button>
      </div>
      <div
        className="code-term-host"
        ref={hostRef}
        // The pane takes the keyboard: a click in the padding around the grid
        // must reach the shell, not the element behind it.
        onMouseDown={() => {
          if (activeId !== null) focusTerminal(activeId);
        }}
      />
    </div>
  );
}

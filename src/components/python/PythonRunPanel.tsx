import { useEffect, useRef } from "react";
import { stopRun, usePythonRun } from "@/python/run";

/**
 * Bottom run panel: python run output and uv environment creation logs both
 * stream here. It sits between the editor and the status bar of EditorPane and
 * only takes height while open.
 */
export function PythonRunPanel() {
  const open = usePythonRun((s) => s.open);
  const command = usePythonRun((s) => s.command);
  const lines = usePythonRun((s) => s.lines);
  const running = usePythonRun((s) => s.running);
  const exitCode = usePythonRun((s) => s.exitCode);
  const cancelled = usePythonRun((s) => s.cancelled);
  const timedOut = usePythonRun((s) => s.timedOut);
  const durationMs = usePythonRun((s) => s.durationMs);
  const clear = usePythonRun((s) => s.clear);
  const close = usePythonRun((s) => s.close);

  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    // Follow the scroll: when the user is parked higher up reading the history, leave it alone; when pinned to the bottom, follow new output.
    const el = preRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!open) return null;

  const status = running
    ? "运行中"
    : timedOut
      ? "超时已终止"
      : cancelled
        ? "已取消"
        : exitCode === 0
          ? "成功"
          : `退出码 ${exitCode ?? "?"}`;

  return (
    <div className="python-run-panel">
      <div className="python-run-head">
        <span
          className={`python-run-status ${running ? "running" : exitCode === 0 && !cancelled ? "ok" : "bad"}`}
        >
          {running && <span className="python-run-spin" />}
          {status}
        </span>
        {durationMs !== null && !running && (
          <span className="python-run-dur">{(durationMs / 1000).toFixed(2)}s</span>
        )}
        <span className="python-run-cmd" title={command}>
          {command}
        </span>
        <span className="spacer" />
        {running && (
          <button className="btn btn-ghost" onClick={() => void stopRun()}>
            停止
          </button>
        )}
        <button className="btn btn-ghost" onClick={clear}>
          清空
        </button>
        <button className="btn btn-ghost" onClick={close}>
          关闭
        </button>
      </div>
      <pre ref={preRef} className="python-run-body">
        {lines.map((l, i) => (
          <span key={i} className={`py-${l.stream}`}>
            {l.text}
          </span>
        ))}
      </pre>
    </div>
  );
}

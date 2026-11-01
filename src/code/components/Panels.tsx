import { useMemo } from "react";
import { useCodeStore } from "../store";
import { useAppStore } from "@/state/appStore";
import type { LspDiagnostic } from "../types";

/**
 * 底部面板:问题(诊断)与引用。
 *
 * 两个面板共用一条「点击 → 跳转」的通路:把目标文件打开,再让编辑器把光标
 * 落到目标位置(位置用 LSP 坐标传,目标文件的文档偏移此刻还不存在)。
 */

const SEVERITY_LABEL: Record<number, string> = {
  1: "错误",
  2: "警告",
  3: "信息",
  4: "提示",
};

export function ProblemsPanel() {
  const diagnostics = useCodeStore((s) => s.diagnostics);
  const openFile = useCodeStore((s) => s.openFile);
  const requestJump = useCodeStore((s) => s.requestJump);

  const groups = useMemo(
    () =>
      Object.entries(diagnostics)
        .filter(([, list]) => list.length > 0)
        .map(([path, list]) => ({ path, list })),
    [diagnostics],
  );

  const total = groups.reduce((sum, g) => sum + g.list.length, 0);

  if (total === 0) {
    return <div className="code-panel-empty">没有诊断信息</div>;
  }

  return (
    <div className="code-panel">
      {groups.map((group) => (
        <div key={group.path} className="code-panel-group">
          <div className="code-panel-group-head">{group.path}</div>
          {group.list.map((d, i) => (
            <button
              type="button"
              key={i}
              className={`code-panel-row sev-${d.severity}`}
              onClick={() => {
                void openFile(group.path);
                requestJump(group.path, d.range.start);
              }}
            >
              <span className="code-panel-badge">{SEVERITY_LABEL[d.severity] ?? "问题"}</span>
              <span className="code-panel-msg">{d.message}</span>
              <span className="code-panel-loc">
                {d.range.start.line + 1}:{d.range.start.character + 1}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ReferencesPanel() {
  const references = useCodeStore((s) => s.references);
  const openFile = useCodeStore((s) => s.openFile);
  const requestJump = useCodeStore((s) => s.requestJump);
  const setReferences = useCodeStore((s) => s.setReferences);
  const showToast = useAppStore((s) => s.showToast);

  if (!references) return null;
  if (references.length === 0) {
    return (
      <div className="code-panel-empty">
        没有找到引用
        <button type="button" className="code-panel-close" onClick={() => setReferences(null)}>
          关闭
        </button>
      </div>
    );
  }

  return (
    <div className="code-panel">
      <div className="code-panel-group-head">
        {references.length} 个引用
        <button type="button" className="code-panel-close" onClick={() => setReferences(null)}>
          关闭
        </button>
      </div>
      {references.map((ref, i) => (
        <button
          type="button"
          key={i}
          className="code-panel-row"
          onClick={() => {
            // 项目外的引用(标准库、依赖)打不开:后端只放行项目根内的路径。
            if (ref.external) {
              showToast("这条引用在项目外,不在这个面板里打开");
              return;
            }
            void openFile(ref.path);
            requestJump(ref.path, ref.position);
          }}
        >
          <span className="code-panel-msg">
            {ref.path}
            {ref.external && <span className="code-panel-ext"> 项目外</span>}
          </span>
          <span className="code-panel-loc">
            {ref.position.line + 1}:{ref.position.character + 1}
          </span>
        </button>
      ))}
    </div>
  );
}

/** 诊断条数(状态栏用)。 */
export function useProblemCount(): number {
  const diagnostics = useCodeStore((s) => s.diagnostics);
  return useMemo(
    () => Object.values(diagnostics).reduce((sum, list) => sum + list.length, 0),
    [diagnostics],
  );
}

/** 某个文件的诊断(编辑器状态栏用)。 */
export function useFileDiagnostics(path: string | null): LspDiagnostic[] {
  const diagnostics = useCodeStore((s) => s.diagnostics);
  return useMemo(() => (path ? (diagnostics[path] ?? []) : []), [diagnostics, path]);
}

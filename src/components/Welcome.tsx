import { useEffect } from "react";
import { runCommand } from "@/commands/registry";
import { useAppStore } from "@/state/appStore";

export function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-logo">bnote</div>
      <p className="welcome-tagline">本地优先 · 实时渲染 · Vim · LaTeX 片段</p>
      <button className="btn primary" onClick={() => runCommand("workspace.open-vault")}>
        打开笔记文件夹
      </button>
      <p className="welcome-hint">
        选择一个文件夹作为笔记仓库（vault），其中的 .md 文件会被自动索引。
      </p>
    </div>
  );
}

export function Toast() {
  const toast = useAppStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useAppStore.getState().clearToast(), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return <div className="toast">{toast}</div>;
}

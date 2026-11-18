import { useInvestStore } from "@/invest/store";

/**
 * The notes column's tab group: every document of the current scope
 * (README / analysis / events + user-created ones). The fixed three come
 * first (the Rust side orders them), user documents follow. Switching a tab
 * opens the document through the app's global `currentFile`, so the note
 * editor below keeps its single owner.
 */
export function DocTabs() {
  const docs = useInvestStore((s) => s.docs);
  const activeDocAbs = useInvestStore((s) => s.activeDocAbs);
  const openDoc = useInvestStore((s) => s.openDoc);
  const refreshDocs = useInvestStore((s) => s.refreshDocs);
  if (docs.length === 0) return null;
  return (
    <div className="invest-doc-tabs">
      {docs.map((doc) => (
        <button
          key={doc.rel_path}
          className={`invest-doc-tab${activeDocAbs?.endsWith(doc.rel_path) ? " active" : ""}`}
          title={doc.rel_path}
          onClick={() => openDoc(doc.rel_path)}
        >
          {doc.title === "README"
            ? "概览"
            : doc.title === "analysis"
              ? "分析"
              : doc.title === "events"
                ? "事件"
                : doc.title}
        </button>
      ))}
      <span className="invest-doc-tabs-spacer" />
      <button
        className="invest-doc-refresh"
        title="重新扫描本标的的文档目录"
        onClick={() => void refreshDocs()}
      >
        ↻
      </button>
    </div>
  );
}

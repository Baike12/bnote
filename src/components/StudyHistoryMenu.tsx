import { useEffect, useRef, useState } from "react";
import type { StudyPdfEntry, StudyUrlEntry } from "@/study/history";

type Tab = "pdf" | "url";

interface StudyHistoryMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tab shown when the menu opens (follows the content currently open). */
  initialTab: Tab;
  pdfs: StudyPdfEntry[];
  urls: StudyUrlEntry[];
  onOpenPdf: (entry: StudyPdfEntry) => void;
  onOpenUrl: (entry: StudyUrlEntry) => void;
  onImportPdf: () => void;
}

/**
 * Top-left history dropdown of the study column.
 *
 * PDFs and web pages are separate *buttons* (tabs), not one mixed list: a PDF
 * is a file inside the vault, a page is a URL that may be gone tomorrow, and
 * mixing them makes both harder to scan.
 */
export function StudyHistoryMenu({
  open,
  onOpenChange,
  initialTab,
  pdfs,
  urls,
  onOpenPdf,
  onOpenUrl,
  onImportPdf,
}: StudyHistoryMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  // Click outside / Escape closes. `pointerdown` (not `click`) so the menu is
  // gone before the click lands on whatever is underneath.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const list = tab === "pdf" ? pdfs : urls;

  return (
    <div className="study-history" ref={rootRef}>
      <button
        className={`content-history-btn${open ? " open" : ""}`}
        title="打开历史 PDF / 网页"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        材料 <span className="content-history-caret">▾</span>
      </button>
      {open && (
        <div className="study-history-pop" role="dialog" aria-label="学习材料历史">
          <div className="study-history-tabs">
            <button
              className={`study-history-tab${tab === "pdf" ? " active" : ""}`}
              onClick={() => setTab("pdf")}
            >
              PDF <span className="study-history-count">{pdfs.length}</span>
            </button>
            <button
              className={`study-history-tab${tab === "url" ? " active" : ""}`}
              onClick={() => setTab("url")}
            >
              网页 <span className="study-history-count">{urls.length}</span>
            </button>
          </div>
          <div className="study-history-list">
            {list.length === 0 && (
              <p className="study-history-empty">
                {tab === "pdf" ? "还没有打开过 PDF" : "还没有打开过网页"}
              </p>
            )}
            {tab === "pdf"
              ? pdfs.map((entry) => (
                  <button
                    key={entry.path}
                    className="study-history-item"
                    onClick={() => onOpenPdf(entry)}
                    title={entry.path}
                  >
                    <span className="study-history-title">{entry.title}</span>
                    <span className="study-history-sub">{entry.relPath}</span>
                  </button>
                ))
              : urls.map((entry) => (
                  <button
                    key={entry.url}
                    className="study-history-item"
                    onClick={() => onOpenUrl(entry)}
                    title={entry.url}
                  >
                    <span className="study-history-title">{entry.title}</span>
                    <span className="study-history-sub">{entry.url}</span>
                  </button>
                ))}
            {tab === "pdf" && (
              <button className="study-history-action" onClick={onImportPdf}>
                ＋ 导入 PDF 到 vault/pdfs
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

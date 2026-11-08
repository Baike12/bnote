import { useEffect, useRef, useState } from "react";
import {
  urlTitle,
  type StudyPdfEntry,
  type StudyUrlEntry,
  type WereadBookEntry,
} from "@/study/history";
import { RenameInput } from "@/components/RenameInput";

type Tab = "pdf" | "url" | "weread";

interface StudyHistoryMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The title is the dropdown trigger: clicking the file name expands the materials list. */
  title: string;
  /** Tab shown when the menu opens (follows the content currently open). */
  initialTab: Tab;
  pdfs: StudyPdfEntry[];
  urls: StudyUrlEntry[];
  books: WereadBookEntry[];
  onOpenPdf: (entry: StudyPdfEntry) => void;
  onOpenUrl: (entry: StudyUrlEntry) => void;
  onOpenBook: (entry: WereadBookEntry) => void;
  onRenameUrl: (entry: StudyUrlEntry, name: string) => void;
  onOpenShelf: () => void;
  onImportPdf: () => void;
}

/** The subtitle of a book shows only the time: the tail of a reader URL is a hash and carries no information for a human. */
function formatWhen(at: number): string {
  if (!at) return "";
  const d = new Date(at);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Middle column header: the file name itself is the "materials" dropdown.
 *
 * PDFs, web pages and weread books are separate *buttons* (tabs), not one
 * mixed list: a PDF is a file inside the vault, a page is a URL that may be
 * gone tomorrow, and a book lives in the weread account — mixing them makes
 * all three harder to scan. Code projects are their own mode and do not
 * appear here.
 */
export function StudyHistoryMenu({
  open,
  onOpenChange,
  title,
  initialTab,
  pdfs,
  urls,
  books,
  onOpenPdf,
  onOpenUrl,
  onOpenBook,
  onRenameUrl,
  onOpenShelf,
  onImportPdf,
}: StudyHistoryMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  /** The web page whose title is being edited (its URL); null when nothing is. */
  const [renaming, setRenaming] = useState<string | null>(null);

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

  const list = tab === "pdf" ? pdfs : tab === "url" ? urls : books;
  const emptyHint =
    tab === "pdf"
      ? "还没有打开过 PDF"
      : tab === "url"
        ? "还没有打开过网页"
        : "还没有读过微信读书的书";

  return (
    <div className="study-history" ref={rootRef}>
      <button
        className={`content-title-btn${open ? " open" : ""}`}
        title="学习材料:点击展开 PDF / 网页 / 微信读书列表"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <span className="content-title" title={title}>
          {title}
        </span>
        <span className="content-history-caret">▾</span>
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
            <button
              className={`study-history-tab${tab === "weread" ? " active" : ""}`}
              onClick={() => setTab("weread")}
            >
              微信读书 <span className="study-history-count">{books.length}</span>
            </button>
          </div>
          <div className="study-history-list">
            {list.length === 0 && <p className="study-history-empty">{emptyHint}</p>}
            {tab === "pdf" &&
              pdfs.map((entry) => (
                <button
                  key={entry.path}
                  className="study-history-item"
                  onClick={() => onOpenPdf(entry)}
                  title={entry.path}
                >
                  <span className="study-history-title">{entry.title}</span>
                  <span className="study-history-sub">{entry.relPath}</span>
                </button>
              ))}
            {tab === "url" &&
              urls.map((entry) => (
                <div key={entry.url} className="study-history-row">
                  {renaming === entry.url ? (
                    <div className="study-history-item is-editing">
                      <RenameInput
                        initial={urlTitle(entry)}
                        onCommit={(name) => {
                          setRenaming(null);
                          // An empty value means cancel (Escape / nothing typed).
                          if (name) onRenameUrl(entry, name);
                        }}
                      />
                      <span className="study-history-sub" title={entry.url}>
                        {entry.url}
                      </span>
                    </div>
                  ) : (
                    <>
                      <button
                        className="study-history-item"
                        onClick={() => onOpenUrl(entry)}
                        title={entry.url}
                      >
                        <span className="study-history-title" title={urlTitle(entry)}>
                          {urlTitle(entry)}
                        </span>
                        <span className="study-history-sub">{entry.url}</span>
                      </button>
                      <button
                        className="study-history-rename"
                        title="重命名这个网页"
                        aria-label={`重命名 ${urlTitle(entry)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming(entry.url);
                        }}
                      >
                        ✎
                      </button>
                    </>
                  )}
                </div>
              ))}
            {tab === "weread" &&
              books.map((entry) => (
                <button
                  key={entry.url}
                  className="study-history-item"
                  onClick={() => onOpenBook(entry)}
                  title={entry.url}
                >
                  <span className="study-history-title">{entry.title}</span>
                  <span className="study-history-sub">{formatWhen(entry.at)}</span>
                </button>
              ))}
            {tab === "pdf" && (
              <button className="study-history-action" onClick={onImportPdf}>
                ＋ 导入 PDF 到 vault/pdfs
              </button>
            )}
            {tab === "weread" && (
              <button className="study-history-action" onClick={onOpenShelf}>
                打开微信读书(书架 / 商城)
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

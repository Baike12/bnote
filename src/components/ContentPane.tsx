import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { agentApi, type PreviewBounds, type StudyContent } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { pdfHistoryForVault, type StudyPdfEntry, type StudyUrlEntry } from "@/study/history";
import { ErrorBoundary } from "./ErrorBoundary";
import { StudyHistoryMenu } from "./StudyHistoryMenu";

/**
 * Study-mode center column.
 *
 * PDFs are *not* converted: the file is copied into `<vault>/pdfs/` and shown
 * by the pdf.js reader, so what the user browses is the paper itself. Web
 * pages are still embedded as a native child webview glued to the placeholder
 * — see `agent.rs::show_study_preview` for why it is not an iframe.
 */

/** 收进来的 PDF 落在 vault 的这个目录下。 */
const PDF_FOLDER = "pdfs";

/** pdf.js(+worker) 只在真正打开 PDF 时下载，不拖慢应用启动。 */
const PdfViewer = lazy(() =>
  import("./PdfViewer").then((m) => ({ default: m.PdfViewer })),
);

export function ContentPane() {
  const content = useAppStore((s) => s.studyContent);
  const setStudyContent = useAppStore((s) => s.setStudyContent);
  const studyHistory = useAppStore((s) => s.studyHistory);
  const recordStudyPdf = useAppStore((s) => s.recordStudyPdf);
  const recordStudyUrl = useAppStore((s) => s.recordStudyUrl);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const showToast = useAppStore((s) => s.showToast);
  const modal = useAppStore((s) => s.modal);
  const previewRef = useRef<HTMLDivElement>(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const previewUrl = content?.kind === "url" ? content.url : null;
  const pdfs = pdfHistoryForVault(studyHistory, vaultPath);

  // 中栏内嵌网页:把占位元素的矩形报给后端,并在它变化时同步过去。
  // 占位元素随三栏布局变化(拖分隔线、缩放窗口、收起侧栏)而变,ResizeObserver
  // 对这些情况都会触发;同尺寸的纯位移在这里不会发生——布局宽度是百分比,
  // 位置变了宽度必变。
  // 依赖整个 content 而不是 previewUrl:同一个网址再输一次是「重新加载」,
  // 靠的就是新对象让这个 effect 重跑(旧的一轮先关掉预览)。
  useEffect(() => {
    const el = previewRef.current;
    if (content?.kind !== "url" || !el) return;
    const url = content.url;
    let closed = false;
    let lastKey = "";
    const sync = (create: boolean) => {
      const bounds = previewBounds(el);
      const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      const call = create
        ? agentApi.showStudyPreview(url, bounds)
        : agentApi.setStudyPreviewBounds(bounds);
      void call.then(
        () => {
          if (create && !closed) setPreviewError(null);
        },
        (e: unknown) => {
          if (create && !closed) {
            setPreviewError(String(e).replace(/^[A-Z_]+:\s*/, ""));
          }
        },
      );
    };
    sync(true);
    const observer = new ResizeObserver(() => sync(false));
    observer.observe(el);
    return () => {
      closed = true;
      observer.disconnect();
      void agentApi.closeStudyPreview().catch(() => {});
    };
  }, [content]);

  // 原生视图永远画在 DOM 之上,所以设置/命令面板这类 HTML 浮层打开时要把它
  // 藏起来,关掉再放出来。画布也一样:全屏浮层,开着时不能被原生视图盖住。
  const canvasOpen = useAppStore((s) => s.drawingSession !== null);
  useEffect(() => {
    if (!previewUrl) return;
    // 历史下拉也要藏:它是 DOM 浮层,而原生网页视图永远画在 DOM 之上,
    // 不藏的话下拉的下半截会被网页盖住。
    void agentApi
      .setStudyPreviewVisible(modal === null && !canvasOpen && !historyOpen)
      .catch(() => {});
  }, [previewUrl, modal, canvasOpen, historyOpen]);

  // Drag & drop: PDFs are imported into the vault and shown as PDFs.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            void handleDrop(event.payload.paths);
          }
        })
        .then((off) => {
          unlisten = off;
        });
    } catch {
      // browser harness: no Tauri webview events
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDrop(paths: string[]) {
    const pdf = paths.find((p) => /\.pdf$/i.test(p));
    if (pdf) {
      await importAndOpen(pdf);
    } else {
      showToast("请拖入 PDF 文件");
    }
  }

  function openPdf(entry: { path: string; relPath: string; title: string }) {
    setStudyContent({ kind: "pdf", path: entry.path, title: entry.title });
    recordStudyPdf(entry);
  }

  async function importAndOpen(pdfPath: string) {
    setImporting(true);
    try {
      // 原文收进 vault 的 pdfs/:下载目录清空后,笔记里的这份材料仍然在。
      const result = await agentApi.importPdf(pdfPath, PDF_FOLDER);
      openPdf({ path: result.pdfPath, relPath: result.relPath, title: result.title });
      showToast(`已收进 vault/${result.relPath}`);
    } catch (e) {
      showToast(`导入 PDF 失败: ${String(e).replace(/^[A-Z_]+:\s*/, "")}`);
    } finally {
      setImporting(false);
    }
  }

  /**
   * Opens (or re-navigates) the standalone preview window through the backend,
   * so a failure is a real error instead of the silent `tauri://error` event
   * the JS `new WebviewWindow(...)` API emits.
   */
  async function openPreview(url: string): Promise<boolean> {
    try {
      await agentApi.openStudyUrl(url);
      return true;
    } catch (e) {
      showToast(`打开网页失败: ${String(e).replace(/^[A-Z_]+:\s*/, "")}`);
      return false;
    }
  }

  function openUrl(raw?: string) {
    const url = normalizeUrl(raw ?? urlInput);
    if (!url) {
      showToast("请输入网址");
      return;
    }
    setUrlInput("");
    // 内容一换,上面的 effect 就把中栏的网页预览切到这个地址(同一个网址
    // 再输一次也会重新加载,因为 content 是新对象)。
    const title = url.replace(/^https?:\/\//, "").split("/")[0] || url;
    setStudyContent({ kind: "url", url, title });
    recordStudyUrl({ url, title });
  }

  function openHistoryPdf(entry: StudyPdfEntry) {
    setHistoryOpen(false);
    openPdf(entry);
  }

  function openHistoryUrl(entry: StudyUrlEntry) {
    setHistoryOpen(false);
    setStudyContent({ kind: "url", url: entry.url, title: entry.title });
    recordStudyUrl({ url: entry.url, title: entry.title });
  }

  async function pickPdf() {
    // A real filesystem path: the `<input type="file">` path is a sandbox
    // token in the webview, and the backend needs an actual path.
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: "选择 PDF 文件",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      const path = typeof picked === "string" ? picked : null;
      if (path) await importAndOpen(path);
    } catch (e) {
      showToast(`选择文件失败: ${String(e)}`);
    }
  }

  return (
    <div
      className={`content-pane${dragging ? " dragging" : ""}`}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* 学习模式没有标题栏,这行是窗口拖动区(按钮、输入框不受影响)。
          历史下拉固定在最左上角:左边 Agent 收起时这里是整窗的左边缘。 */}
      <div className="content-toolbar" data-tauri-drag-region="deep">
        <StudyHistoryMenu
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          initialTab={content?.kind === "url" ? "url" : "pdf"}
          pdfs={pdfs}
          urls={studyHistory.urls}
          onOpenPdf={openHistoryPdf}
          onOpenUrl={openHistoryUrl}
          onImportPdf={() => {
            setHistoryOpen(false);
            void pickPdf();
          }}
        />
        {!settings.studyAgentOpen && (
          <button
            className="icon-btn content-agent-toggle"
            title="展开学习助手"
            onClick={() => patchSettings({ studyAgentOpen: true })}
          >
            助手
          </button>
        )}
        <span className="content-title" title={content?.title}>
          {importing ? "正在导入 PDF…" : content ? content.title : "学习模式"}
        </span>
        <span className="spacer" />
        {content?.kind === "url" ? (
          <>
            <input
              className="content-url"
              type="text"
              placeholder="输入网址打开网页预览…"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") openUrl();
              }}
            />
            <button
              className="icon-btn pdf-tool-btn"
              title="打开这个网址"
              onClick={() => openUrl()}
            >
              打开
            </button>
          </>
        ) : (
          <button
            className="icon-btn pdf-tool-btn"
            title="选择 PDF 文件(存进 vault/pdfs)"
            onClick={() => void pickPdf()}
            disabled={importing}
          >
            ＋ PDF
          </button>
        )}
        {content && (
          <button
            className="icon-btn"
            title="关闭当前内容"
            onClick={() => setStudyContent(null as StudyContent | null)}
          >
            ✕
          </button>
        )}
      </div>
      <div className="content-body">
        {!content && !importing && (
          <div className="content-empty">
            <p className="content-empty-title">拖入 PDF 直接阅读</p>
            <p className="content-empty-hint">
              PDF 会存到 vault 的 <code>{PDF_FOLDER}/</code> 文件夹,不转换成
              Markdown——书签、图表、公式都按原文显示。
            </p>
            <button className="btn content-pick" onClick={() => void pickPdf()}>
              选择 PDF 文件
            </button>
            <div className="content-empty-url">
              <input
                className="content-url"
                type="text"
                placeholder="或在 web 中预览网址…"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openUrl();
                }}
              />
              <button className="btn" onClick={() => openUrl()}>
                打开网页
              </button>
            </div>
          </div>
        )}
        {content?.kind === "pdf" && (
          <ErrorBoundary
            resetKey={content.path}
            fallback={(error, reset) => (
              <div className="pdf-fail">
                <p className="content-empty-title">PDF 阅读器加载失败</p>
                <p className="pdf-status-msg">{error.message}</p>
                <button className="btn" onClick={reset}>
                  重试
                </button>
              </div>
            )}
          >
            <Suspense fallback={<div className="pdf-status">正在加载 PDF 阅读器…</div>}>
              <PdfViewer
                path={content.path}
                eyeCare={settings.studyEyeCare}
                onToggleEyeCare={() => patchSettings({ studyEyeCare: !settings.studyEyeCare })}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {content?.kind === "url" && (
          <div className="content-web">
            <div className="content-web-bar">
              <span className="content-web-url" title={content.url}>
                {content.url}
              </span>
              <button
                className="icon-btn"
                title="在独立窗口中打开(中栏里页面显示异常时用)"
                onClick={() => void openPreview(content.url)}
              >
                ↗
              </button>
            </div>
            {/* 原生子 webview 会盖住这块占位区,页面的滚动/点击都归它。 */}
            <div className="content-web-view" ref={previewRef}>
              {previewError && (
                <div className="content-web-fail">
                  <p className="content-empty-title">网页没能显示</p>
                  <p className="content-web-fail-msg">{previewError}</p>
                  <button
                    className="btn"
                    onClick={() => void openPreview(content.url)}
                  >
                    在独立窗口中打开
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 占位元素的矩形,转成后端要的逻辑像素坐标。
 *
 * 窗口内容区左上角就是 DOM 视口原点(标题栏是 overlay 样式,内容区铺满整窗),
 * 所以 `getBoundingClientRect()` 的视口坐标可以直接当窗口坐标用。
 */
export function previewBounds(el: HTMLElement): PreviewBounds {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

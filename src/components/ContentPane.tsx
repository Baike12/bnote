import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { agentApi, type PreviewBounds, type StudyContent } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { createEditor, loadDocument } from "@/editor/setup";
import type { EditorView } from "@codemirror/view";
import { fileName } from "@/lib/path";

/**
 * Study-mode center column: shows the current content (a converted-PDF
 * markdown note), accepts PDF drops for conversion, and embeds a web page in
 * the column itself for `kind: "url"`.
 *
 * The page is a native child webview of the main window, glued to the
 * `.content-web-view` placeholder — see `agent.rs::show_study_preview` for why
 * it is not an iframe.
 */
/** 转换产物落在这个 vault 目录下:原文 `<stem>.pdf`、结果 `<stem>.md`、
 *  图表 `assets/<stem>/…`(见后端 convert_pdf_to_markdown)。 */
const PDF_FOLDER = "pdfs";

export function ContentPane() {
  const content = useAppStore((s) => s.studyContent);
  const setStudyContent = useAppStore((s) => s.setStudyContent);
  const showToast = useAppStore((s) => s.showToast);
  const modal = useAppStore((s) => s.modal);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const loadedRef = useRef<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [converting, setConverting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewUrl = content?.kind === "url" ? content.url : null;

  // Editor lifecycle: create once, swap docs as content changes.
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const view = createEditor(hostRef.current, "", {
      onDocChanged: () => {},
      onCursorMoved: () => {},
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      loadedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!content) {
      if (loadedRef.current !== null) {
        loadDocument(view, "");
        loadedRef.current = null;
      }
      return;
    }
    if (content.kind !== "markdown") return;
    if (loadedRef.current === content.path) return;
    let cancelled = false;
    void (async () => {
      try {
        const text = await invokeReadFile(content.path);
        if (!cancelled && viewRef.current) {
          // 带上路径:图表的相对引用(`assets/<stem>/…`)以这份文档为基准,
          // 而不是右栏那篇笔记的目录。
          loadDocument(viewRef.current, text, content.path);
          loadedRef.current = content.path;
        }
      } catch (e) {
        if (!cancelled) showToast(`读取内容失败: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, showToast]);

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
  // 藏起来,关掉再放出来。
  useEffect(() => {
    if (!previewUrl) return;
    void agentApi.setStudyPreviewVisible(modal === null).catch(() => {});
  }, [previewUrl, modal]);

  // Drag & drop: PDFs convert to markdown; markdown opens directly.
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
    const md = paths.find((p) => /\.(md|markdown|txt)$/i.test(p));
    if (pdf) {
      await convertAndOpen(pdf);
    } else if (md) {
      const title = fileName(md).replace(/\.(md|markdown|txt)$/i, "");
      setStudyContent({ kind: "markdown", path: md, title });
    } else {
      showToast("请拖入 PDF 或 Markdown 文件");
    }
  }

  async function convertAndOpen(pdfPath: string) {
    setConverting(true);
    try {
      // 转换结果和原文都落到当前 vault 的 pdfs/ 下(见后端 convert_pdf_to_markdown):
      // 原文留在下载目录的话,过几天就找不回这篇笔记是从哪份 PDF 来的了。
      const result = await agentApi.convertPdf(pdfPath, PDF_FOLDER);
      setStudyContent({
        kind: "markdown",
        path: result.mdPath,
        title: result.title,
      });
      showToast(
        `转换完成:${result.pages} 页,${(result.elapsedMs / 1000).toFixed(1)}s → ${PDF_FOLDER}/${fileName(result.mdPath)}`,
      );
    } catch (e) {
      showToast(`PDF 转换失败: ${String(e)}`);
    } finally {
      setConverting(false);
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

  function openUrl() {
    const url = normalizeUrl(urlInput);
    if (!url) {
      showToast("请输入网址");
      return;
    }
    setUrlInput("");
    // 内容一换,下面的 effect 就把中栏的网页预览切到这个地址(同一个网址
    // 再输一次也会重新加载,因为 content 是新对象)。
    const title = url.replace(/^https?:\/\//, "").split("/")[0] || url;
    setStudyContent({ kind: "url", url, title });
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
      if (path) await convertAndOpen(path);
    } catch (e) {
      showToast(`选择文件失败: ${String(e)}`);
    }
  }

  return (
    <div
      className={`content-pane${dragging ? " dragging" : ""}`}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* 学习模式没有标题栏,这行是窗口拖动区(网址输入框、按钮不受影响)。 */}
      <div className="content-toolbar" data-tauri-drag-region="deep">
        <span className="content-title">
          {converting
            ? "正在转换 PDF…"
            : content
              ? content.kind === "markdown"
                ? content.title
                : content.title
              : "学习模式"}
        </span>
        <span className="spacer" />
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
        <div className="content-editor" ref={hostRef} />
        {!content && !converting && (
          <div className="content-empty">
            <p className="content-empty-title">拖入 PDF 开始学习</p>
            <p className="content-empty-hint">
              PDF 会转换成 Markdown(公式转为 LaTeX、图表原位保留),或
            </p>
            <button className="btn content-pick" onClick={() => void pickPdf()}>
              选择 PDF 文件
            </button>
            <p className="content-empty-hint">
              也可以在上方输入网址,直接在中栏预览网页并让 Agent 阅读它
            </p>
          </div>
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

async function invokeReadFile(path: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("read_file", { path });
}

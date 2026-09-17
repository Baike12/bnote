import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { agentApi, type StudyContent } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { createEditor, loadDocument } from "@/editor/setup";
import type { EditorView } from "@codemirror/view";
import { fileName } from "@/lib/path";

/**
 * Study-mode center column: shows the current content (a converted-PDF
 * markdown note), accepts PDF drops for conversion, and can open a URL in a
 * separate Tauri WebviewWindow.
 */
export function ContentPane() {
  const content = useAppStore((s) => s.studyContent);
  const setStudyContent = useAppStore((s) => s.setStudyContent);
  const showToast = useAppStore((s) => s.showToast);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const loadedRef = useRef<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState("");

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
          loadDocument(viewRef.current, text);
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
      const result = await agentApi.convertPdf(pdfPath, "Study");
      setStudyContent({
        kind: "markdown",
        path: result.mdPath,
        title: result.title,
      });
      showToast(
        `转换完成:${result.pages} 页,${(result.elapsedMs / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      showToast(`PDF 转换失败: ${String(e)}`);
    } finally {
      setConverting(false);
    }
  }

  function openUrl() {
    const url = normalizeUrl(urlInput);
    if (!url) {
      showToast("请输入网址");
      return;
    }
    setUrlInput("");
    // Preview in a real webview window; the agent reads the page via read_url.
    void (async () => {
      try {
        await new WebviewWindow(`study-web-${Date.now()}`, { url, title: url });
      } catch (e) {
        console.warn("open webview window failed", e);
      }
    })();
    const title = url.replace(/^https?:\/\//, "").split("/")[0] || url;
    setStudyContent({ kind: "url", url, title });
  }

  return (
    <div
      className={`content-pane${dragging ? " dragging" : ""}`}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="content-toolbar">
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
            <label className="btn content-pick">
              选择 PDF 文件
              <input
                type="file"
                accept="application/pdf"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void convertAndOpen(webPath(file));
                  e.target.value = "";
                }}
              />
            </label>
            <p className="content-empty-hint">
              也可以在上方输入网址,在独立窗口预览网页并让 Agent 阅读它
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function webPath(file: File): string {
  // In packaged Tauri the File object carries a path on drop via webkitGetAsEntry;
  // for the file input we get a fake path — use Tauri's conversion when present.
  const anyFile = file as File & { path?: string };
  if (anyFile.path) return anyFile.path;
  return `file://${file.name}`;
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

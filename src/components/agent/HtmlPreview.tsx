import { useEffect, useRef, useState } from "react";

import { agentApi } from "@/lib/tauri";
import { PREVIEW_HEIGHT_FLAG, wrapPreviewDocument } from "@/study/htmlPreview";

type Mode = "preview" | "code";

interface Loaded {
  code: string;
  url: string;
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * A live preview for one `html` code block of an agent reply.
 *
 * The document goes to the native `agent-preview` protocol (commands/preview.rs)
 * and renders in a sandboxed iframe (`allow-scripts`, no `allow-same-origin`:
 * the page gets an opaque origin and cannot touch the app, the vault or IPC).
 * srcdoc / blob / data frames are not usable in the packaged webview — the app
 * CSP is inherited into every local-scheme document and their inline scripts
 * are blocked (measured offscreen), so the custom scheme is the only channel.
 *
 * The frame reports its content height over postMessage; the per-upload token
 * ties a message to the frame that sent it — every mounted preview hears every
 * message, and only the owner of the token accepts it. Browser mode (no custom
 * scheme, no inherited CSP) falls back to a blob: URL — dev-only.
 */
export function HtmlPreview({ code }: { code: string }) {
  const [mode, setMode] = useState<Mode>("preview");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  // The upload is async; a stale answer must not overwrite the URL of newer
  // code (single writer: the effect owns `loaded` and proves freshness by its
  // own sequence number).
  const seq = useRef(0);
  // Token of the document this component is currently showing (height channel).
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (mode !== "preview") return;
    if (loaded && loaded.code === code) return;
    const mine = ++seq.current;
    const token = `${mine}-${Date.now().toString(36)}`;
    const document_ = wrapPreviewDocument(code, token);
    const upload = isTauriRuntime()
      ? agentApi.putPreview(document_)
      : Promise.resolve(URL.createObjectURL(new Blob([document_], { type: "text/html" })));
    upload
      .then((url) => {
        if (seq.current !== mine) return;
        tokenRef.current = token;
        setLoaded({ code, url });
      })
      .catch(() => {
        // No URL: keep the previous state; the code view is one click away
        // and the failure is not actionable for the user.
      });
  }, [code, mode, loaded]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record[PREVIEW_HEIGHT_FLAG] !== tokenRef.current) return;
      const value = record.height;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
      setHeight(value);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="agent-html-preview">
      <div className="agent-html-preview-bar">
        <div className="agent-html-preview-tabs" role="tablist">
          <button
            className={`agent-html-preview-tab${mode === "preview" ? " is-active" : ""}`}
            onClick={() => setMode("preview")}
          >
            预览
          </button>
          <button
            className={`agent-html-preview-tab${mode === "code" ? " is-active" : ""}`}
            onClick={() => setMode("code")}
          >
            源码
          </button>
        </div>
      </div>
      {mode === "preview" ? (
        loaded ? (
          <iframe
            className="agent-html-frame"
            src={loaded.url}
            style={height !== null ? { height } : undefined}
            sandbox="allow-scripts allow-modals allow-forms"
            title="HTML 预览"
          />
        ) : (
          <div className="agent-html-frame agent-html-frame-loading">预览生成中…</div>
        )
      ) : (
        <pre className="agent-code">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

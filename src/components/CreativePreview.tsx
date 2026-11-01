import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { agentApi, api, bblogApi, type BblogCategory } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { vaultDotPath } from "@/study/vaultJson";

interface PreviewState {
  /** The snapshot written by preview_html (a file:// URL); the child webview reloads when it changes. */
  url: string;
  /** The vault source file the snapshot came from (vault relative path), used for publishing and refreshing. */
  source: string;
  version: number;
}

/** Geometry of the placeholder element in the middle column (viewport coordinates are window content coordinates, the title bar is an Overlay). */
function previewBounds(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * The middle column of creative mode: after the agent generates or edits
 * HTML, the preview_html tool writes a versioned snapshot and pushes a
 * `creative-preview-updated` event; here the native child webview is glued
 * to the placeholder element and reloads with a new URL when the event
 * arrives, which is where the "live preview" comes from.
 *
 * It collaborates with the native view the same way ContentPane (the middle
 * column of study mode) does: a ResizeObserver plus the divider drag event
 * report the geometry again, and the native view is hidden while an HTML
 * overlay (settings / publish dialog) is open.
 */
export function CreativePreview() {
  const modal = useAppStore((s) => s.modal);
  const canvasOpen = useAppStore((s) => s.drawingSession !== null);
  const showToast = useAppStore((s) => s.showToast);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /** The source file shown in the publish dialog (null = closed). */
  const [publishSource, setPublishSource] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<{ url: string; source: string; version: number }>(
      "creative-preview-updated",
      (event) => {
        setPreview(event.payload);
      },
    ).then((un) => {
      off = un;
    });
    return () => off?.();
  }, []);

  // Preview webview sync: a changed URL creates or navigates it, a changed geometry only reports the bounds.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let closed = false;
    let lastKey = "";
    const sync = (create: boolean) => {
      const bounds = previewBounds(el);
      const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      const call = create
        ? agentApi.showCreativePreview(preview?.url ?? "", bounds)
        : agentApi.setCreativePreviewBounds(bounds);
      void call.catch((e: unknown) => {
        // The browser harness has no webview commands; an unavailable preview is only reported, it must not interrupt the creative flow.
        if (create && !closed) {
          console.warn("[creative] 预览不可用", e);
          showToast("预览仅在桌面应用中可用");
        }
      });
    };
    if (preview) sync(true);
    const observer = new ResizeObserver(() => sync(false));
    observer.observe(el);
    const onLayoutResize = () => sync(false);
    window.addEventListener("bnote:study-layout-resize", onLayoutResize);
    return () => {
      closed = true;
      observer.disconnect();
      window.removeEventListener("bnote:study-layout-resize", onLayoutResize);
    };
  }, [preview, showToast]);

  // Switching back to study mode / unmounting: take down the native view of the creative preview.
  useEffect(() => {
    return () => {
      void agentApi.closeCreativePreview().catch(() => {});
    };
  }, []);

  // Hide the native view while an HTML overlay (global modal / canvas /
  // publish dialog) is open (the native view always paints above the DOM).
  useEffect(() => {
    if (!preview) return;
    void agentApi
      .setCreativePreviewVisible(modal === null && !canvasOpen && publishSource === null)
      .catch(() => {});
  }, [preview, modal, canvasOpen, publishSource]);

  const refresh = useCallback(() => {
    const el = bodyRef.current;
    if (!preview || !el) return;
    void agentApi
      .showCreativePreview(preview.url, previewBounds(el))
      .catch(() => {});
  }, [preview]);

  const sourceName = preview?.source.split("/").pop() ?? "";
  return (
    <section className="content-pane creative-pane" data-key-region="reading">
      <div className="content-toolbar" data-tauri-drag-region="deep">
        <div className="content-tool-left">
          <span className="creative-title" title={preview?.source}>
            {sourceName ? `预览 · ${sourceName}` : "创作预览"}
          </span>
        </div>
        <div className="content-tool-right">
          {preview && (
            <>
              <button
                className="icon-btn"
                title="重新加载预览"
                onClick={refresh}
              >
                ⟳
              </button>
              <button
                className="btn btn-ghost creative-publish"
                title="把当前预览的 HTML 发布到 bblog"
                onClick={() => setPublishSource(preview.source)}
              >
                发布
              </button>
            </>
          )}
        </div>
      </div>
      <div className="creative-body" ref={bodyRef}>
        {!preview && (
          <div className="creative-empty">
            <p className="creative-empty-title">还没有可预览的内容</p>
            <p className="creative-empty-hint">
              让左侧的 agent 生成 HTML(它会写入仓库文件并推送到这里预览),满意后点「发布」。
            </p>
          </div>
        )}
      </div>
      {publishSource && (
        <PublishDialog source={publishSource} onClose={() => setPublishSource(null)} />
      )}
    </section>
  );
}

interface BblogAuth {
  server: string;
  token: string;
}

/** Reads .bnote/bblog/auth.json from the vault (returns null when it is missing or malformed). */
export async function readBblogAuth(vaultPath: string | null): Promise<BblogAuth | null> {
  if (!vaultPath) return null;
  try {
    const raw = await api.readFile(vaultDotPath(vaultPath, "bblog/auth.json"));
    const parsed = JSON.parse(raw) as Partial<BblogAuth>;
    if (typeof parsed.server === "string" && typeof parsed.token === "string" && parsed.server && parsed.token) {
      return { server: parsed.server, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The publish dialog: pick the section / topic (they come from the
 * /api/sections of bblog, a hand written directory has the same weight) and
 * upload the content of the previewed source file of the repository to
 * /api/upload with the Bearer token.
 */
export function PublishDialog({ source, onClose }: { source: string; onClose: () => void }) {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const showToast = useAppStore((s) => s.showToast);
  const [auth, setAuth] = useState<BblogAuth | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [categories, setCategories] = useState<BblogCategory[]>([]);
  const [category, setCategory] = useState("");
  const [topic, setTopic] = useState("");
  const [filename, setFilename] = useState(source.split("/").pop() || "article.html");
  const [error, setError] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readBblogAuth(vaultPath).then((a) => {
      if (cancelled) return;
      setAuth(a);
      setAuthChecked(true);
      if (!a) return;
      void bblogApi
        .sections(a.server)
        .then((data) => {
          if (cancelled) return;
          setCategories(data.categories);
          const firstCat = data.categories[0];
          if (firstCat) {
            setCategory(firstCat.name);
            const firstTopic = firstCat.topics[0];
            if (firstTopic) setTopic(firstTopic.name);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(String(e).replace(/^[A-Z_]+:\s*/, ""));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  const current = categories.find((c) => c.name === category);

  async function publish() {
    if (!auth || !category || !topic) return;
    setBusy(true);
    setError("");
    try {
      const content = await api.readFile(source);
      const result = await bblogApi.publish({
        server: auth.server,
        token: auth.token,
        category,
        topic,
        filename,
        content,
      });
      setPublishedUrl(`${auth.server.replace(/\/+$/, "")}${result.url}`);
      showToast("已发布到 bblog");
    } catch (e) {
      setError(String(e).replace(/^[A-Z_]+:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="publish-overlay" onClick={onClose}>
      <div className="publish-box" onClick={(e) => e.stopPropagation()}>
        <div className="publish-head">
          <span className="publish-title">发布到 bblog</span>
          <button className="publish-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {!authChecked ? (
          <p className="publish-hint">读取认证信息…</p>
        ) : !auth ? (
          <div className="publish-hint">
            <p>缺少认证信息。请在仓库里创建 <code>.bnote/bblog/auth.json</code>:</p>
            <pre>{`{
  "server": "http://101.96.243.197",
  "token": "<bblog 后台的上传令牌>"
}`}</pre>
            <p className="publish-hint-sub">令牌在 bblog 登录管理员后访问 /blog/api/admin/token 获取。</p>
          </div>
        ) : (
          <>
            <label className="publish-row">
              栏目
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  const next = categories.find((c) => c.name === e.target.value);
                  setTopic(next?.topics[0]?.name ?? "");
                }}
              >
                {categories.length === 0 && <option value="">(服务器还没有栏目)</option>}
                {categories.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="publish-row">
              主题
              <select value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!current}>
                {(current?.topics ?? []).map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="publish-row">
              文件名
              <input value={filename} onChange={(e) => setFilename(e.target.value)} />
            </label>
            <p className="publish-source" title={source}>
              发布内容:{source}
            </p>
            {error && <p className="publish-error">{error}</p>}
            {publishedUrl ? (
              <p className="publish-ok">
                已发布:<a href={publishedUrl} target="_blank" rel="noreferrer">
                  {publishedUrl}
                </a>
              </p>
            ) : (
              <div className="publish-actions">
                <button className="btn btn-ghost" onClick={onClose}>
                  取消
                </button>
                <button
                  className="btn btn-primary publish-go"
                  disabled={busy || !category || !topic || !filename.trim()}
                  onClick={() => void publish()}
                >
                  {busy ? "发布中…" : "发布"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

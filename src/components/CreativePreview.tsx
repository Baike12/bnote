import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { agentApi, api, bblogApi, type BblogCategory } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { vaultDotPath } from "@/study/vaultJson";

interface PreviewState {
  /** preview_html 落下的快照(file:// URL),子 webview 换它即重载。 */
  url: string;
  /** 快照对应的仓库源文件(vault 相对路径),发布与刷新都用它。 */
  source: string;
  version: number;
}

/** 中栏占位元素的几何(视口坐标即窗口内容区坐标,标题栏为 Overlay)。 */
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
 * 创作模式的中栏:agent 生成/修改 HTML 后,preview_html 工具落一份带版本
 * 的快照并推 `creative-preview-updated` 事件;这里把原生子 webview 粘在
 * 占位元素上,事件到达就换 URL 重载——「实时预览」由此而来。
 *
 * 与 ContentPane(学习模式中栏)同一套原生视图协作模型:ResizeObserver +
 * 分隔条拖动事件补报几何;HTML 弹层(设置/发布对话框)打开时藏原生视图。
 */
export function CreativePreview() {
  const modal = useAppStore((s) => s.modal);
  const canvasOpen = useAppStore((s) => s.drawingSession !== null);
  const showToast = useAppStore((s) => s.showToast);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /** 发布对话框展示的源文件(null = 关闭)。 */
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

  // 预览 webview 同步:URL 变化 → 创建/导航;几何变化 → 只报 bounds。
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
        // 浏览器 harness 没有 webview 命令;预览不可用只提示,不打断创作。
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

  // 切回学习模式/组件卸载:撤掉创作预览的原生视图。
  useEffect(() => {
    return () => {
      void agentApi.closeCreativePreview().catch(() => {});
    };
  }, []);

  // HTML 浮层(全局 modal / 画布 / 发布对话框)打开时藏原生视图
  // (原生视图永远画在 DOM 之上)。
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

/** 读 vault 的 .bnote/bblog/auth.json(不存在或格式不对返回 null)。 */
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
 * 发布对话框:选择栏目/主题(来自 bblog 的 /api/sections,手工目录同权),
 * 把预览的仓库源文件内容经 Bearer 令牌上传到 /api/upload。
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

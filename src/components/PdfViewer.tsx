// Must be first: pdf.js 6 reads `Iterator.prototype.join` while its module is
// evaluated, and WebKit on macOS 15 has no Iterator global yet.
import "@/study/pdfjsCompat";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
// Our worker entry (not pdf.js's own URL) so the worker global gets the shim.
import PdfWorker from "@/study/pdfWorker?worker";
import "pdfjs-dist/web/pdf_viewer.css";
import { api } from "@/lib/tauri";
import { bindingsForCommand, formatBinding } from "@/commands/keys";
import { useAppStore } from "@/state/appStore";
import { cropFromDrag, loadPdfCrop, savePdfCrop, type PdfCrop } from "@/study/crop";
import {
  PAGE_TOP_PAD,
  basePageWidth,
  contentWidthForRenderedPage,
  normalizeSplit,
} from "@/study/layoutModel";
import { clampOutlineWidth, loadOutlineWidth, saveOutlineWidth } from "@/study/pdfLayout";
import { setPdfNavHandlers } from "@/study/pdfNav";
import { filterOutline, type PdfOutlineNode } from "@/study/pdfOutline";

/**
 * Study-mode PDF reader.
 *
 * pdf.js renders pages into canvases in the middle column — the file is shown
 * as a PDF, nothing is converted. Only pages near the viewport get a canvas:
 * an A4 page at 2× DPR is ~11 MB of pixels, so rendering a whole paper at once
 * would both stall the first paint and exhaust GPU memory.
 *
 * The middle column can be dragged narrow, which is the same kind of resize
 * the app already treats as a hot path: page width is debounced before any
 * canvas is re-rendered, and render tasks are cancelled when a page leaves the
 * window or the width changes mid-render.
 */

// A dedicated port instead of `workerSrc`: Vite bundles our entry (shim +
// pdf.js worker) and pdf.js talks to it directly.
GlobalWorkerOptions.workerPort = new PdfWorker();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
/** Page width in CSS px is clamped to this range (column can be very narrow). */
const MIN_PAGE_WIDTH = 220;
/** 框选后完整页面会被放大(见 basePageWidth),上限比栏宽宽松。 */
const MAX_PAGE_WIDTH = 3200;
/** 画布后备存储的最大宽度(物理像素)。页面再大也只降 DPR,不按比例涨内存。 */
const MAX_CANVAS_WIDTH = 3200;
/** How far outside the viewport a page keeps its canvas (px). */
const RENDER_MARGIN = 1000;
/** Width changes settle before re-rendering every visible page. */
const RESIZE_DEBOUNCE_MS = 140;

interface PdfViewerProps {
  /** Absolute path inside the vault. */
  path: string;
  /** Eye-care tint (pale green paper), persisted in settings. */
  eyeCare: boolean;
  onToggleEyeCare: () => void;
}

export function PdfViewer({ path, eyeCare, onToggleEyeCare }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [ratio, setRatio] = useState(1 / 1.414);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [outline, setOutline] = useState<PdfOutlineNode[]>([]);
  /** 目录解析完(哪怕没有目录)才量一次中栏宽度:书签栏占的横向空间要算进
   *  「一页正好放下」的目标宽度里。 */
  const [outlineLoaded, setOutlineLoaded] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(true);
  /** 用户偏好宽度(持久化);实际显示宽度按当前栏宽再夹一次,见下面的 effect。 */
  const preferredOutlineWidth = useRef(loadOutlineWidth());
  const [outlineWidth, setOutlineWidth] = useState(() => preferredOutlineWidth.current);
  const [outlineQuery, setOutlineQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [activePages, setActivePages] = useState<Set<number>>(() => new Set());
  /** 只显示每页的这一块(归一化比例);null = 整页。 */
  const [crop, setCrop] = useState<PdfCrop | null>(() => loadPdfCrop(path));
  /** 框选进行中:页面临时铺回整页,才能框到被裁掉的留白。 */
  const [cropping, setCropping] = useState(false);
  const cropShown = cropping ? null : crop;

  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const visiblePages = useRef(new Set<number>());
  const activeRef = useRef(new Set<number>());
  const currentPageRef = useRef(1);
  const outlineRef = useRef<HTMLElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  /** 每个 PDF 只自动适配一次,之后窗口/栏宽变化都不再改中栏宽度。
   *  分几趟量:改宽会让滚动条出现/消失,页面实际宽度随之变化,一趟量不准;
   *  最多三趟,收敛即停。 */
  const autoFitPass = useRef(0);
  const autoFitFrom = useRef(0);
  /** 最近一趟写进设置的中栏宽度;下一趟前比对,被手动改过就不再动。 */
  const autoFitTarget = useRef<number | null>(null);

  // 页面宽度 = 中间栏可用宽度,贴边(不再留 14px 横向内边距)。
  // 框选后只剩裁出来的那一块:100% 要让可见部分贴边,所以完整页面按裁剪宽度
  // 等比放大,而不是让裁剪窗口缩在栏中间留两条灰边。
  const fitWidth = Math.max(containerWidth, MIN_PAGE_WIDTH);
  const baseWidth = basePageWidth(fitWidth, cropShown?.w ?? 1);
  const minZoom = Math.max(MIN_ZOOM, MIN_PAGE_WIDTH / baseWidth);
  const maxZoom = Math.max(minZoom, Math.min(MAX_ZOOM, MAX_PAGE_WIDTH / baseWidth));
  // Clamp for *display* too: a window resize can push the stored zoom outside
  // the range where it still changes the page width.
  const zoomValue = Math.min(Math.max(zoom, minZoom), maxZoom);
  const targetWidth = useMemo(
    () => Math.round(Math.min(Math.max(baseWidth * zoomValue, MIN_PAGE_WIDTH), MAX_PAGE_WIDTH)),
    [baseWidth, zoomValue],
  );

  // --- load the document ---------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentLoadingTask | null = null;
    setLoading(true);
    setError(null);
    setDoc(null);
    setNumPages(0);
    setOutline([]);
    setOutlineLoaded(false);
    autoFitPass.current = 0;
    autoFitTarget.current = null;
    setCurrentPage(1);
    currentPageRef.current = 1;
    setCrop(loadPdfCrop(path));
    setCropping(false);
    setActivePages(new Set());
    activeRef.current = new Set();
    visiblePages.current = new Set();

    void (async () => {
      try {
        const base64 = await api.readFileBase64(path);
        if (cancelled) return;
        const bytes = base64ToBytes(base64);
        const task = getDocument({
          data: bytes,
          cMapUrl: "/pdfjs-assets/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs-assets/standard_fonts/",
        });
        loaded = task;
        const doc = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        const first = await doc.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        setRatio(viewport.height / viewport.width);
        setNumPages(doc.numPages);
        setDoc(doc);
        setLoading(false);
        const raw = await doc.getOutline().catch(() => null);
        const nodes = await resolveOutline(doc, raw);
        if (!cancelled) {
          setOutline(nodes);
          setOutlineLoaded(true);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e).replace(/^[A-Z_]+:\s*/, ""));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [path]);

  // --- track column width (divider drag / window resize / outline toggle) ---
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = (immediate: boolean) => {
      if (timer) clearTimeout(timer);
      timer = null;
      const width = el.clientWidth;
      if (immediate) {
        setContainerWidth((prev) => (prev === width ? prev : width));
        return;
      }
      // A divider drag reflows the column at 60 Hz. Re-rendering the reader
      // (and re-measuring every visible page's canvas) on each of those frames
      // is pure jank; one update after the drag settles is enough.
      timer = setTimeout(() => {
        timer = null;
        setContainerWidth((prev) => (prev === width ? prev : width));
      }, RESIZE_DEBOUNCE_MS);
    };
    measure(true);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // --- page visibility: current-page readout + render window ----------------
  useEffect(() => {
    if (!doc || numPages === 0) return;
    const scroll = scrollRef.current;
    if (!scroll) return;

    const visible = new IntersectionObserver(
      (entries) => {
        const set = visiblePages.current;
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) set.add(n);
          else set.delete(n);
        }
        if (set.size > 0) setCurrentPage(Math.min(...set));
      },
      { root: scroll, threshold: 0 },
    );
    const windowed = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) {
            if (!activeRef.current.has(n)) {
              activeRef.current.add(n);
              changed = true;
            }
          } else if (activeRef.current.delete(n)) {
            changed = true;
          }
        }
        if (changed) setActivePages(new Set(activeRef.current));
      },
      { root: scroll, rootMargin: `${RENDER_MARGIN}px 0px`, threshold: 0 },
    );
    for (const el of pageEls.current.values()) {
      visible.observe(el);
      windowed.observe(el);
    }
    return () => {
      visible.disconnect();
      windowed.disconnect();
    };
  }, [doc, numPages]);

  const registerPage = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) pageEls.current.set(n, el);
    else pageEls.current.delete(n);
  }, []);

  function goToPage(n: number) {
    const el = pageEls.current.get(n);
    const scroll = scrollRef.current;
    if (!el || !scroll) return;
    if (n > numPages || n < 1) return;
    const top = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 10;
    scroll.scrollTo({ top: Math.max(0, top) });
    setCurrentPage(n);
    currentPageRef.current = n;
  }

  /** 视口顶端那一页(可能已经滚过半页)。 */
  function pageAtScroll(): number {
    const scroll = scrollRef.current;
    if (!scroll) return 1;
    const top = scroll.scrollTop + 4;
    let found = 1;
    for (const [n, el] of [...pageEls.current].sort((a, b) => a[0] - b[0])) {
      const elTop = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      if (elTop + el.offsetHeight > top) {
        found = n;
        break;
      }
    }
    return found;
  }

  /** 整页翻页:跳到上一页/下一页的页首,而不是按视口高度滚一段。 */
  const flipPage = useCallback(
    (delta: 1 | -1) => {
      goToPage(pageAtScroll() + delta);
    },
    // goToPage/pageAtScroll 只读 ref 与 numPages;numPages 变化时重建即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [numPages],
  );

  const applyCrop = useCallback(
    (next: PdfCrop | null) => {
      setCrop(next);
      savePdfCrop(path, next);
    },
    [path],
  );

  // 书签栏宽度:拖动只改这一栏,中栏的 PDF 区域吃剩余宽度,左右两栏不受影响。
  // 拖动期间写 CSS 变量(不 setState):书签可能有几百项,60Hz 重渲染整棵树不划算,
  // 而且 ResizeObserver 在拖动中途触发的重渲染会把内联宽度弹回旧值。
  function startOutlineDrag(event: React.PointerEvent<HTMLDivElement>) {
    const aside = outlineRef.current;
    const body = aside?.parentElement;
    const viewer = viewerRef.current;
    if (!aside || !body || !viewer) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    const bodyWidth = body.getBoundingClientRect().width;
    const handle = event.currentTarget;
    let latest = Math.round(startWidth);
    handle.classList.add("dragging");
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件/没有活动指针
    }
    const onMove = (move: PointerEvent) => {
      latest = clampOutlineWidth(startWidth + move.clientX - startX, bodyWidth);
      viewer.style.setProperty("--pdf-outline-w", `${latest}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      handle.classList.remove("dragging");
      preferredOutlineWidth.current = latest;
      setOutlineWidth(latest);
      saveOutlineWidth(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // 窗口/中栏变窄时,把显示宽度夹回"给页面留出最小宽度"的范围;只夹显示,
  // 不回写偏好——栏恢复宽了还能回到用户拖出来的宽度。
  useLayoutEffect(() => {
    const body = outlineRef.current?.parentElement;
    if (!body) return;
    const clamped = clampOutlineWidth(
      preferredOutlineWidth.current,
      body.getBoundingClientRect().width,
    );
    if (clamped !== outlineWidth) setOutlineWidth(clamped);
    // 书签栏刚展开/目录刚加载出来时也要按当前栏宽夹一次。
  }, [outlineWidth, containerWidth, outlineOpen, outline.length]);

  // 打开 PDF 时把中栏调成「一页刚好完整显示」的宽度。只在文档与目录都就绪
  // 后跑一次:之后拖窗口不改中栏宽度(那样会连带改变纵向能看到的内容),用户
  // 手动拖分隔线也以手动值为准。
  useLayoutEffect(() => {
    // 三趟足够收敛:第一趟按页面高度差折算,后两趟用重排后的真实页面高度校正
    // (滚动条出现/消失改变页面实际宽度;一次量不准)。
    const MAX_FIT_PASSES = 3;
    if (!doc || !outlineLoaded || autoFitPass.current >= MAX_FIT_PASSES) return;
    // 上一趟之后只在页面宽度真的重排过才量下一趟,免得被无关的依赖重跑。
    if (autoFitPass.current > 0 && targetWidth === autoFitFrom.current) return;
    const scroll = scrollRef.current;
    const viewer = viewerRef.current;
    const page = pageEls.current.get(1);
    if (!scroll || !viewer || !page) return;
    // 用已经渲染出来的页面反推:差多少高度就折算成多少宽度,滚动条占多少
    // 像素都不影响(量的是真实布局)。
    const target = contentWidthForRenderedPage({
      contentWidth: viewer.getBoundingClientRect().width,
      pageWidth: targetWidth,
      pageHeight: page.getBoundingClientRect().height,
      availableHeight: scroll.clientHeight - PAGE_TOP_PAD,
      pageRatio: ratio,
      cropHeight: crop?.h ?? 1,
      cropWidth: crop?.w ?? 1,
      minPageWidth: MIN_PAGE_WIDTH,
      maxPageWidth: MAX_PAGE_WIDTH,
    });
    if (target === null) return;
    const store = useAppStore.getState();
    const [agentWidth, currentContent] = normalizeSplit(
      store.settings.studySplit,
      window.innerWidth,
    );
    if (autoFitPass.current > 0 && currentContent !== autoFitTarget.current) {
      // 上一趟之后用户已经手动拖过中栏:手动值优先,放弃校正。
      autoFitPass.current = MAX_FIT_PASSES;
      return;
    }
    autoFitPass.current += 1;
    autoFitFrom.current = targetWidth;
    if (Math.abs(currentContent - target) >= 2) {
      autoFitTarget.current = target;
      store.patchSettings({ studySplit: [agentWidth, target] });
    } else {
      // 已经收敛(页面高度差不到 1px),收工。
      autoFitPass.current = MAX_FIT_PASSES;
    }
  }, [doc, outlineLoaded, ratio, crop, targetWidth]);

  // 裁剪框改变每页高度:重排后把当前页重新顶到视口顶部,阅读位置不丢。
  useEffect(() => {
    if (cropping) return;
    const raf = requestAnimationFrame(() => goToPage(currentPageRef.current));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop, cropping]);

  // 翻页快捷键走命令系统(默认 PageUp/PageDown/方向键,可在设置里改):这里只
  // 把「能不能翻、翻哪一页」登记给命令层。焦点归属由分发层处理——裸导航键在
  // 编辑器/输入框里归它们自己,带修饰键的绑定(如 ⌃J)在哪儿都生效。
  useEffect(() => {
    setPdfNavHandlers({
      canFlip: () => cropping === false && useAppStore.getState().modal === null,
      prev: () => flipPage(-1),
      next: () => flipPage(1),
    });
    return () => setPdfNavHandlers(null);
  }, [cropping, flipPage]);

  const filteredOutline = filterOutline(outline, outlineQuery);
  const hasOutline = outline.length > 0;
  const prevKeys = bindingsForCommand("study.pdf-prev-page").map(formatBinding).join(" / ");
  const nextKeys = bindingsForCommand("study.pdf-next-page").map(formatBinding).join(" / ");

  return (
    <div
      className={`pdf-viewer${eyeCare ? " eye-care" : ""}`}
      ref={viewerRef}
      style={{ "--pdf-outline-w": `${outlineWidth}px` } as React.CSSProperties}
    >
      <div className="pdf-toolbar">
        {hasOutline && (
          <button
            className={`icon-btn pdf-tool-btn${outlineOpen ? " active" : ""}`}
            title={outlineOpen ? "收起书签" : "展开书签"}
            onClick={() => setOutlineOpen((v) => !v)}
          >
            ☰ 书签
          </button>
        )}
        <span className="spacer" />
        <button
          className="icon-btn pdf-tool-btn"
          title={prevKeys ? `上一页(${prevKeys})` : "上一页"}
          disabled={currentPage <= 1}
          onClick={() => flipPage(-1)}
        >
          ‹
        </button>
        <span className="pdf-page-indicator">
          {currentPage} / {numPages || "—"}
        </span>
        <button
          className="icon-btn pdf-tool-btn"
          title={nextKeys ? `下一页(${nextKeys})` : "下一页"}
          disabled={numPages === 0 || currentPage >= numPages}
          onClick={() => flipPage(1)}
        >
          ›
        </button>
        <span className="pdf-tool-sep" aria-hidden />
        <button
          className="icon-btn pdf-tool-btn"
          title="缩小"
          onClick={() => setZoom((z) => Math.max(minZoom, Math.round((z - ZOOM_STEP) * 10) / 10))}
        >
          −
        </button>
        <button
          className="pdf-zoom-label"
          title="点击恢复适合宽度"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoomValue * 100)}%
        </button>
        <button
          className="icon-btn pdf-tool-btn"
          title="放大"
          onClick={() => setZoom((z) => Math.min(maxZoom, Math.round((z + ZOOM_STEP) * 10) / 10))}
        >
          ＋
        </button>
        <button
          className={`icon-btn pdf-tool-btn${eyeCare ? " active" : ""}`}
          title={eyeCare ? "关闭护眼模式" : "护眼模式(浅绿纸面)"}
          onClick={onToggleEyeCare}
        >
          🌿
        </button>
        <button
          className={`icon-btn pdf-tool-btn${cropping ? " active" : ""}`}
          title={
            cropping
              ? "取消框选(Esc)"
              : "框选显示范围:在页面上拖出一个矩形,所有页都只显示这一块"
          }
          onClick={() => setCropping((v) => !v)}
        >
          框选
        </button>
        {crop && !cropping && (
          <button
            className="icon-btn pdf-tool-btn"
            title="恢复整页显示"
            onClick={() => applyCrop(null)}
          >
            整页
          </button>
        )}
      </div>
      <div className="pdf-body">
        {outlineOpen && hasOutline && (
          <>
            <aside className="pdf-outline" ref={outlineRef}>
              <input
                className="pdf-outline-search"
                type="text"
                placeholder="书签查找"
                value={outlineQuery}
                onChange={(e) => setOutlineQuery(e.target.value)}
              />
              <div className="pdf-outline-list">
                {filteredOutline.length === 0 ? (
                  <p className="pdf-outline-empty">没有匹配的书签</p>
                ) : (
                  filteredOutline.map((node, i) => (
                    <OutlineNodeView
                      key={`${i}-${node.title}`}
                      node={node}
                      depth={0}
                      forceOpen={outlineQuery.trim().length > 0}
                      onPick={goToPage}
                    />
                  ))
                )}
              </div>
            </aside>
            <div
              className="pdf-outline-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整书签栏宽度"
              title="拖动调整书签栏宽度"
              onPointerDown={startOutlineDrag}
            />
          </>
        )}
        <div className="pdf-scroll-wrap">
          <div className="pdf-scroll" ref={scrollRef}>
            {loading && <div className="pdf-status">正在打开 PDF…</div>}
            {error && (
              <div className="pdf-status pdf-status-fail">
                <p>PDF 打开失败</p>
                <p className="pdf-status-msg">{error}</p>
              </div>
            )}
            {doc && containerWidth > 0 && (
              <div className="pdf-pages">
                {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
                  <PdfPage
                    key={n}
                    doc={doc}
                    pageNumber={n}
                    width={targetWidth}
                    ratio={ratio}
                    crop={cropShown}
                    active={activePages.has(n)}
                    eyeCare={eyeCare}
                    register={registerPage}
                  />
                ))}
              </div>
            )}
          </div>
          {cropping && (
            <CropLayer
              pageEls={pageEls}
              scrollRef={scrollRef}
              onApply={(next) => {
                setCropping(false);
                // 框太小(单击/手抖)当取消,保留原来的范围。
                if (next) applyCrop(next);
              }}
              onCancel={() => setCropping(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crop selection
// ---------------------------------------------------------------------------

interface CropLayerProps {
  pageEls: React.RefObject<Map<number, HTMLDivElement>>;
  /** 框选层盖住了滚动容器:滚轮事件在这里转交给它,否则框选模式下翻不动页。 */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 只按页比例给出结果;单击/手抖为 null(调用方当取消)。 */
  onApply: (crop: PdfCrop | null) => void;
  onCancel: () => void;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 框选层:盖住 PDF 视口,在一个页面内拖出矩形。
 *
 * 坐标一律现算(`getBoundingClientRect`),不用缓存的布局——拖动期间页面
 * 不滚动,但列宽/缩放可能刚好在变,缓存会框错位置。框是相对页面的比例,
 * 所以同一块范围会原样套到每一页。
 */
function CropLayer({ pageEls, scrollRef, onApply, onCancel }: CropLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const dragRef = useRef<{
    pageRect: DOMRect;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function pageAt(clientX: number, clientY: number): DOMRect | null {
    for (const el of pageEls.current?.values() ?? []) {
      const rect = el.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return rect;
      }
    }
    return null;
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const rect = pageAt(event.clientX, event.clientY);
    if (!rect) return;
    event.preventDefault();
    // 合成事件/没有活动指针时 setPointerCapture 会抛(同 StudyLayout 的拖拽)。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败不影响拖拽:move/up 仍从元素上冒泡过来。
    }
    const x = clampPx(event.clientX - rect.left, rect.width);
    const y = clampPx(event.clientY - rect.top, rect.height);
    dragRef.current = { pageRect: rect, startX: x, startY: y, lastX: x, lastY: y };
    setBox(null);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const layer = layerRef.current;
    if (!drag || !layer) return;
    const pr = drag.pageRect;
    const x = clampPx(event.clientX - pr.left, pr.width);
    const y = clampPx(event.clientY - pr.top, pr.height);
    drag.lastX = x;
    drag.lastY = y;
    const lr = layer.getBoundingClientRect();
    setBox({
      left: Math.min(drag.startX, x) + pr.left - lr.left,
      top: Math.min(drag.startY, y) + pr.top - lr.top,
      width: Math.abs(x - drag.startX),
      height: Math.abs(y - drag.startY),
    });
  }

  function finish() {
    const drag = dragRef.current;
    dragRef.current = null;
    setBox(null);
    if (!drag) return;
    const pr = drag.pageRect;
    onApply(
      cropFromDrag(
        drag.startX / pr.width,
        drag.startY / pr.height,
        drag.lastX / pr.width,
        drag.lastY / pr.height,
      ),
    );
  }

  return (
    <div
      className="pdf-crop-layer"
      ref={layerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => {
        dragRef.current = null;
        setBox(null);
        onCancel();
      }}
      onWheel={(event) => {
        // 拖动期间页面矩形是缓存的,滚动会让框错位——只在没拖的时候放行。
        const scroll = scrollRef.current;
        if (!scroll || dragRef.current) return;
        scroll.scrollTop += event.deltaY;
        scroll.scrollLeft += event.deltaX;
      }}
    >
      {box && <div className="pdf-crop-box" style={box} />}
      <div className="pdf-crop-hint">拖动框选要显示的区域 · Esc 取消</div>
    </div>
  );
}

function clampPx(value: number, size: number): number {
  return Math.min(size, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  /** CSS width of the page (already zoomed). */
  width: number;
  /** Free-standing estimate used until the page itself is measured. */
  ratio: number;
  /** 显示范围(比例);null = 整页。 */
  crop: PdfCrop | null;
  active: boolean;
  eyeCare: boolean;
  register: (n: number, el: HTMLDivElement | null) => void;
}

const PdfPage = memo(function PdfPage({
  doc,
  pageNumber,
  width,
  ratio,
  crop,
  active,
  eyeCare,
  register,
}: PdfPageProps) {
  // Aspect ratio of *this* page once measured. Keeping the ratio (not a pixel
  // height) means a zoom or divider drag can update the placeholder height
  // without re-rendering the page.
  const [pageRatio, setPageRatio] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    register(pageNumber, el);
    return () => register(pageNumber, null);
  }, [pageNumber, register]);

  useEffect(() => {
    if (!active) return;
    // Captured now: the cleanup must clear the same nodes it rendered into.
    const canvas = canvasRef.current;
    const textDiv = textRef.current;
    if (!canvas || !textDiv) return;
    let cancelled = false;
    let task: RenderTask | null = null;

    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });

      setPageRatio(viewport.height / viewport.width);
      const dpr = Math.min(
        window.devicePixelRatio || 1,
        2,
        MAX_CANVAS_WIDTH / viewport.width,
      );
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      task = page.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      await task.promise;
      if (cancelled) return;

      // The selection layer must use the same scale variables as the canvas;
      // pdf.js positions every run with `calc(var(--total-scale-factor) * …)`.
      textDiv.replaceChildren();
      textDiv.style.setProperty("--scale-factor", String(viewport.scale));
      textDiv.style.setProperty("--total-scale-factor", String(viewport.scale));
      textDiv.style.setProperty("--scale-round-x", "1px");
      textDiv.style.setProperty("--scale-round-y", "1px");
      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport,
      });
      await textLayer.render();
      // The cleanup may have run while the text layer was being built.
      if (cancelled) textDiv.replaceChildren();
    })().catch((e: unknown) => {
      if (cancelled) return;
      if (e instanceof Error && e.name === "RenderingCancelledException") return;
      console.warn("[pdf] page render failed", pageNumber, e);
    });

    return () => {
      cancelled = true;
      task?.cancel();
      // Free the backing store: leaving ~10 MB canvases behind for every page
      // scrolled past is how a long paper turns into a memory leak.
      canvas.width = 0;
      canvas.height = 0;
      textDiv.replaceChildren();
    };
  }, [active, doc, pageNumber, width]);

  const height = Math.round(width * (pageRatio ?? ratio));
  // 裁剪后页面只占这块:整页仍在里面,靠负偏移把框外的部分推出裁剪窗口。
  const shownWidth = crop ? Math.max(1, Math.round(width * crop.w)) : width;
  const shownHeight = crop ? Math.max(1, Math.round(height * crop.h)) : height;
  const offsetX = crop ? Math.round(width * crop.x) : 0;
  const offsetY = crop ? Math.round(height * crop.y) : 0;
  return (
    <div
      className="pdf-page"
      data-page={pageNumber}
      ref={wrapperRef}
      style={{ width: shownWidth, height: shownHeight }}
    >
      <div
        className="pdf-page-full"
        style={{ width, height, left: -offsetX, top: -offsetY }}
      >
        <canvas ref={canvasRef} />
        <div className="textLayer" ref={textRef} />
        {eyeCare && <div className="pdf-page-tint" aria-hidden />}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Outline tree
// ---------------------------------------------------------------------------

interface OutlineNodeViewProps {
  node: PdfOutlineNode;
  depth: number;
  forceOpen: boolean;
  onPick: (page: number) => void;
}

function OutlineNodeView({ node, depth, forceOpen, onPick }: OutlineNodeViewProps) {
  const [open, setOpen] = useState(depth < 2);
  const expanded = forceOpen || open;
  const hasChildren = node.items.length > 0;
  return (
    <div className="pdf-outline-node">
      <div className="pdf-outline-row" style={{ paddingLeft: 8 + depth * 14 }}>
        {hasChildren ? (
          <button
            className="pdf-outline-chevron"
            title={expanded ? "收起" : "展开"}
            onClick={() => setOpen((v) => !v)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="pdf-outline-chevron placeholder" />
        )}
        <button
          className="pdf-outline-title"
          title={node.title}
          onClick={() => node.page !== null && onPick(node.page)}
        >
          {node.title}
        </button>
        {node.page !== null && <span className="pdf-outline-page">{node.page}</span>}
      </div>
      {hasChildren && expanded && (
        <div>
          {node.items.map((child, i) => (
            <OutlineNodeView
              key={`${i}-${child.title}`}
              node={child}
              depth={depth + 1}
              forceOpen={forceOpen}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** pdf.js outline destinations are either named (async lookup) or ref arrays. */
async function resolveOutline(
  doc: PDFDocumentProxy,
  raw: unknown,
): Promise<PdfOutlineNode[]> {
  const list = Array.isArray(raw) ? raw : [];
  const resolveOne = async (item: unknown): Promise<PdfOutlineNode | null> => {
    if (!item || typeof item !== "object") return null;
    const record = item as {
      title?: unknown;
      dest?: unknown;
      items?: unknown;
    };
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) return null;
    let page: number | null = null;
    try {
      let dest = record.dest;
      if (typeof dest === "string") dest = await doc.getDestination(dest);
      if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
        page = (await doc.getPageIndex(dest[0])) + 1;
      }
    } catch {
      page = null;
    }
    const children = Array.isArray(record.items)
      ? (await Promise.all(record.items.map(resolveOne))).filter(
          (n): n is PdfOutlineNode => n !== null,
        )
      : [];
    return { title, page, items: children };
  };
  const nodes = await Promise.all(list.map(resolveOne));
  return nodes.filter((n): n is PdfOutlineNode => n !== null);
}

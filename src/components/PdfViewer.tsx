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
import { api, translateApi } from "@/lib/tauri";
import { bindingsForCommand, formatBinding } from "@/commands/keys";
import { imeOnChineseFocus, imeSyncToEditor } from "@/editor/imeSwitch";
import { useAppStore } from "@/state/appStore";
import { TranslateCard, type TranslateCardState } from "./TranslateCard";
import { cropFromDrag, loadPdfCrop, savePdfCrop, type PdfCrop } from "@/study/crop";
import {
  annotationAt,
  EMPTY_PDF_ANNOTATIONS,
  flushPdfAnnotations,
  isNoteAnnotation,
  lineRectsAtPoint,
  loadPdfAnnotations,
  MAX_NOTE_TEXT,
  mergeLineRects,
  newPdfAnnotationId,
  normalizeRects,
  rectsAnchor,
  savePdfAnnotations,
  sortNotes,
  stackNoteTops,
  type BoxLike,
  type PdfAnnotation,
  type NormRect,
} from "@/study/pdfAnnotations";
import {
  createAnnotationHistory,
  recordAnnotationHistory,
  redoAnnotationHistory,
  resetAnnotationHistory,
  undoAnnotationHistory,
  type AnnotationHistory,
} from "@/study/annotationHistory";
import { vaultRelPath } from "@/lib/path";
import { ensureMaterial } from "@/study/materials";
import {
  PAGE_TOP_PAD,
  basePageWidth,
  contentWidthForRenderedPage,
} from "@/study/layoutModel";
import {
  clampOutlineWidth,
  loadOutlineWidth,
  notesRailWidth,
  saveOutlineWidth,
} from "@/study/pdfLayout";
import { setPdfNavHandlers } from "@/study/pdfNav";
import {
  canvasToFile,
  paintSnapshot,
  planSnapshot,
  registerPdfSnapshotSource,
  snapshotRect,
  type SnapshotPage,
} from "@/study/pdfSnapshot";
import { filterOutline, type PdfOutlineNode } from "@/study/pdfOutline";
import {
  flushReadPositions,
  loadReadPositions,
  pdfPositionAt,
  savePdfReadPosition,
  scrollTopForPdfPosition,
  type PageMetric,
} from "@/study/readPositions";
import { snapScrollTopToLine, steppedScrollTop } from "@/study/reading";

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

/** 文字批注卡:高度跟文字行数走,堆叠时用实测高度。 */
const NOTE_INPUT_MIN_HEIGHT = 26;
/** 再长就在卡内滚动,不把下面的卡片一路推到底。 */
const NOTE_INPUT_MAX_HEIGHT = 240;
const NOTE_BOX_GAP = 10;
/** 连线从卡片顶部下移这么多像素(指向抬头,不是卡片正中)。 */
const NOTE_HEAD_OFFSET = 14;
/** 卡片左右内缩;连线终点 = 留白左缘 + 这个值。 */
const NOTE_BOX_INSET = 8;
/** 同一个批注连续改字在这个窗口内并成一步撤销。 */
const TEXT_UNDO_GROUP_MS = 1000;

export type PdfTool = "highlight" | "note";

/** 批注提交方式:结构改动记一步;改字按输入会话合并;加载/撤销不记。 */
type AnnotationCommit = "none" | "structure" | "text";

interface NotePlacement {
  id: string;
  /** 卡片 top(相对整个 PDF 内容区)。 */
  top: number;
  /** 选区锚点(相对内容区),连线起点。 */
  anchorX: number;
  anchorY: number;
  /** 卡片左缘(相对内容区);留白在右时是连线终点。 */
  boxX: number;
  /** 卡片右缘(相对内容区);留白在左时是连线终点。 */
  boxRight: number;
}

interface PdfViewerProps {
  /** Absolute path inside the vault. */
  path: string;
  /** Eye-care tint (pale green paper), persisted in settings. */
  eyeCare: boolean;
  onToggleEyeCare: () => void;
  /** 每次翻页滚动的可见高度比例（0.1–1，默认 0.5）。 */
  pageStep: number;
}

export function PdfViewer({ path, eyeCare, onToggleEyeCare, pageStep }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [ratio, setRatio] = useState(1 / 1.414);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  /** 滚动区视口宽度(clientWidth,不含纵向滚动条)与面板总宽(含滚动条)。 */
  const [scrollWidth, setScrollWidth] = useState(0);
  const [panelWidth, setPanelWidth] = useState(0);
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
  /** 滚动区是否已到首/尾：翻页改为按步长滚动后，按钮的可用性由滚动位置决定，
   *  不再由「当前页是不是第一/最后一页」决定（最后一页可能还有半屏没看）。 */
  const [atScrollTop, setAtScrollTop] = useState(true);
  const [atScrollBottom, setAtScrollBottom] = useState(false);
  const [activePages, setActivePages] = useState<Set<number>>(() => new Set());
  /** 只显示每页的这一块(归一化比例);null = 整页。 */
  const [crop, setCrop] = useState<PdfCrop | null>(() => loadPdfCrop(path));
  /** 框选进行中:页面临时铺回整页,才能框到被裁掉的留白。 */
  const [cropping, setCropping] = useState(false);
  const cropShown = cropping ? null : crop;
  /** 当前批注工具:亮黄高亮 / 亮蓝文字批注;null = 普通阅读。 */
  const [tool, setTool] = useState<PdfTool | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  /** 初始批注文件读完之前不允许进入批注模式:否则第一次提交会覆盖掉还没读进来的旧批注。 */
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const annotationsRef = useRef<PdfAnnotation[]>([]);
  /** 异步读盘回来时用它自证「还是当前文档/没有被本地编辑抢先」。 */
  const annotationsEpoch = useRef(0);
  /** Ctrl+Z/Ctrl+Shift+Z 的批注快照栈(每份 PDF 独立,换文档清空)。 */
  const historyRef = useRef<AnnotationHistory<PdfAnnotation[]> | null>(null);
  if (historyRef.current === null) historyRef.current = createAnnotationHistory(100);
  const history = historyRef.current;
  /** 改字撤销的分组:同一个批注连续输入只记一步。 */
  const textEditRef = useRef<{ id: string; at: number } | null>(null);
  /** 最近一次 pointerdown 是否落在 PDF 阅读器里(Ctrl+Z 的归属判断)。 */
  const pdfActiveRef = useRef(false);
  /** 右侧留白里批注卡的位置(连线用同一份坐标)。 */
  const [notePlacements, setNotePlacements] = useState<NotePlacement[]>([]);
  /** 刚建/刚点中的批注卡:nonce 变化让输入框重新聚焦。 */
  const [focusNote, setFocusNote] = useState<{ id: string; nonce: number } | null>(null);
  const focusNonce = useRef(0);
  /**
   * 正文选中翻译卡片。`translateSeq` 是唯一的写入者令牌:换选区、关卡片、
   * 切批注工具、关开关都会 +1,迟到的 IPC 结果自证不过就丢弃。
   */
  const translateEnabled = useAppStore((s) => s.settings.studyTranslate.enabled);
  const [translateCard, setTranslateCard] = useState<TranslateCardState | null>(null);
  const translateSeq = useRef(0);
  /**
   * mouseup 到 setTimeout 之间用户可能已经点中批注工具。setTimeout 闭包里的
   * `tool` 是旧值,所以用 ref 读当前值:批注工具一旦生效,翻译请求连创建都
   * 不做,避免「工具已选但翻译卡还弹出来」的竞争。
   */
  const toolRef = useRef<PdfTool | null>(tool);
  useLayoutEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  const stageRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLElement>(null);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const docKey = vaultRelPath(path, vaultPath ?? "");

  /**
   * 一次选中翻译。Rust 决定单词/句子:单词只查内置词典(未收录返回 miss,
   * 不联网);两个及以上单词才走模型 API。迟到的结果用 translateSeq 丢弃。
   */
  const requestTranslation = useCallback(
    async (text: string, x: number, y: number) => {
      if (!useAppStore.getState().settings.studyTranslate.enabled) return;
      if (toolRef.current) return;
      const id = ++translateSeq.current;
      setTranslateCard({ id, status: "loading", text, x, y });
      try {
        const result = await translateApi.selection(text);
        if (
          !useAppStore.getState().settings.studyTranslate.enabled ||
          translateSeq.current !== id ||
          toolRef.current
        ) {
          return;
        }
        if (result.kind === "none") {
          setTranslateCard(null);
        } else if (result.kind === "word") {
          setTranslateCard({ id, status: "word", text, x, y, entry: result.entry });
        } else if (result.kind === "miss") {
          setTranslateCard({ id, status: "miss", text, x, y, word: result.word });
        } else {
          setTranslateCard({
            id,
            status: "sentence",
            text,
            x,
            y,
            translation: result.translation,
          });
        }
      } catch (e) {
        if (
          !useAppStore.getState().settings.studyTranslate.enabled ||
          translateSeq.current !== id ||
          toolRef.current
        ) {
          return;
        }
        setTranslateCard({
          id,
          status: "error",
          text,
          x,
          y,
          message: String(e).replace(/^[A-Z_]+:\s*/, ""),
        });
      }
    },
    [],
  );

  // 关开关/换文档/进入批注工具:立即作废未返回的请求并收卡片。批注工具
  // 优先是硬规则——页面在 tool 非空时根本不挂翻译 mouseup。
  useEffect(() => {
    if (!translateEnabled) {
      translateSeq.current++;
      setTranslateCard(null);
    }
  }, [translateEnabled]);
  useEffect(() => {
    translateSeq.current++;
    setTranslateCard(null);
  }, [path]);
  useEffect(() => {
    if (tool) {
      translateSeq.current++;
      setTranslateCard(null);
    }
  }, [tool]);

  // 卡片是 fixed 定位:滚动后选区位置不再对应,直接收掉;点卡片外或 Esc
  // 同样收掉。点正文开始新选区时会先收旧卡,新卡在 mouseup 后重开。
  useEffect(() => {
    if (!translateCard) return;
    const close = () => {
      translateSeq.current++;
      setTranslateCard(null);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".translate-card")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const scroll = scrollRef.current;
    scroll?.addEventListener("scroll", close, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    return () => {
      scroll?.removeEventListener("scroll", close);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    };
  }, [translateCard]);
  /**
   * 这份 PDF 的材料目录(`materials/pdfs/<拼音目录>`):批注和 agent 会话
   * 记录都落在那里。解析完成前不读批注,避免先读到旧路径又被迁移覆盖。
   */
  const [materialDir, setMaterialDir] = useState<string | null>(null);
  const [materialReady, setMaterialReady] = useState(false);
  /** 右侧留白从面板宽度里切出去;能放下一页最小宽度才留。 */
  const railWidth = notesRailWidth(panelWidth);
  const containerWidth = Math.max(0, scrollWidth - railWidth);

  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const noteEls = useRef(new Map<string, HTMLDivElement>());
  /** 每个批注卡上次的自适应高度依据(文字 + 卡宽),避免重复量布局。 */
  const noteFits = useRef(new Map<string, { text: string; width: number }>());
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

  // --- 阅读位置 -------------------------------------------------------------
  /** 打开文档时的落点(页码 + 页内偏移);用户一动手就清掉。 */
  const positionAnchor = useRef<{ page: number; offset: number } | null>(null);
  /** 位置文件读完之前不许存盘,否则初始的 scrollTop=0 会覆盖上次的锚点。 */
  const positionLoaded = useRef(false);
  /** 至少落过一次位才允许存盘(或本来就没有锚点)。 */
  const positionApplied = useRef(false);
  /** 用户已经主动滚动/翻页/跳转,之后的布局变化不再把位置拉回去。 */
  const userScrolled = useRef(false);
  const [positionEpoch, setPositionEpoch] = useState(0);

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
    setTool(null);
    setFocusNote(null);
    setNotePlacements([]);
    resetAnnotationHistory(history);
    textEditRef.current = null;
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
  }, [path, history]);

  // --- annotations ---------------------------------------------------------
  // 换文档先清空,再读这一份的批注;读盘回来时比对 epoch,期间用户已经
  // 开始批注(本地编辑推进了 epoch)就丢弃这份旧结果。
  useEffect(() => {
    const epoch = ++annotationsEpoch.current;
    annotationsRef.current = [];
    setAnnotations([]);
    setTool(null);
    setFocusNote(null);
    setNotePlacements([]);
    resetAnnotationHistory(history);
    textEditRef.current = null;
    setAnnotationsLoaded(false);
    if (!vaultPath) {
      setAnnotationsLoaded(true);
      return;
    }
    if (!materialReady) return;
    void loadPdfAnnotations(vaultPath, docKey, materialDir)
      .then((list) => {
        if (annotationsEpoch.current !== epoch) return;
        annotationsRef.current = list;
        setAnnotations(list);
      })
      .catch(() => {
        // 读不到批注文件(尚无批注/权限问题)不影响阅读。
      })
      .finally(() => {
        if (annotationsEpoch.current === epoch) setAnnotationsLoaded(true);
      });
  }, [vaultPath, docKey, history, materialReady, materialDir]);

  // 材料目录:换 PDF 就重新解析(后端按「仓库相对路径」登记,同一份永远同一个目录)。
  useEffect(() => {
    setMaterialDir(null);
    setMaterialReady(false);
    if (!vaultPath) {
      setMaterialReady(true);
      return;
    }
    let cancelled = false;
    const title = path.split("/").pop()?.replace(/\.pdf$/i, "") ?? "";
    void ensureMaterial(vaultPath, { kind: "pdf", path, title }).then((info) => {
      if (cancelled) return;
      setMaterialDir(info?.relDir ?? null);
      setMaterialReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, path]);

  // --- 阅读位置 -------------------------------------------------------------
  // 换文档先作废旧锚点,再读这份 PDF 上次停下的位置。异步读盘回来时比对
  // docKey(闭包里的 key),过期结果丢弃。
  useEffect(() => {
    positionAnchor.current = null;
    positionLoaded.current = false;
    positionApplied.current = false;
    userScrolled.current = false;
    const key = docKey;
    if (!vaultPath) {
      positionLoaded.current = true;
      positionApplied.current = true;
      return;
    }
    let cancelled = false;
    // 页码对不上(文件被替换、裁页)时不能让存盘一直被锁住:2 秒后无论是否
    // 落位成功都允许记录新位置。
    const fallback = setTimeout(() => {
      positionApplied.current = true;
    }, 2000);
    void loadReadPositions(vaultPath)
      .then((data) => {
        if (cancelled) return;
        const saved = data.pdfs[key];
        // 读盘期间用户已经开始滚动:位置归用户,不再还原。
        positionAnchor.current =
          saved && !userScrolled.current
            ? { page: saved.page, offset: saved.offset }
            : null;
        positionLoaded.current = true;
        if (!positionAnchor.current) positionApplied.current = true;
        // 读盘可能晚于文档/页面就绪:epoch 变化让恢复 effect 再跑一次。
        setPositionEpoch((n) => n + 1);
      })
      .catch(() => {
        if (cancelled) return;
        positionLoaded.current = true;
        positionApplied.current = true;
      });
    return () => {
      cancelled = true;
      clearTimeout(fallback);
    };
  }, [vaultPath, docKey]);

  /** 把锚点落到当前布局上;页面还没挂载/宽度变化后都可以反复调用。 */
  const applyReadPosition = useCallback(() => {
    const anchor = positionAnchor.current;
    if (!anchor) return;
    if (userScrolled.current || !scrollRef.current) return;
    const el = pageEls.current.get(anchor.page);
    if (!el) return;
    const scroll = scrollRef.current;
    const scrollRect = scroll.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const metrics: PageMetric[] = [
      { page: anchor.page, top: rect.top - scrollRect.top + scroll.scrollTop, height: rect.height },
    ];
    const top = scrollTopForPdfPosition(metrics, anchor);
    if (top === null) return;
    if (Math.abs(scroll.scrollTop - top) > 1) scroll.scrollTop = top;
    positionApplied.current = true;
  }, []);

  // 文档/页面挂载、自动适配改宽、裁剪重排后都重新落一次:锚点是「第几页的
  // 百分之几」,布局怎么变都还能回到同一处。用户一动手下面的监听就清掉
  // 锚点,不会把用户拽回旧位置。
  useEffect(() => {
    if (!positionAnchor.current || userScrolled.current) return;
    const raf = requestAnimationFrame(() => applyReadPosition());
    return () => cancelAnimationFrame(raf);
  }, [positionEpoch, doc, targetWidth, cropShown, applyReadPosition]);

  // 用户主动滚动/翻页/跳转后,位置归用户所有:之后只存不还原。
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const release = () => {
      userScrolled.current = true;
      positionAnchor.current = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(event.key)) release();
    };
    scroll.addEventListener("wheel", release, { passive: true });
    scroll.addEventListener("touchstart", release, { passive: true });
    scroll.addEventListener("pointerdown", release, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      scroll.removeEventListener("wheel", release);
      scroll.removeEventListener("touchstart", release);
      scroll.removeEventListener("pointerdown", release, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [doc]);

  // 离开阅读器/退出学习模式时把挂起的写盘冲刷掉。
  useEffect(() => () => flushReadPositions(), []);

  const commitAnnotations = useCallback(
    (next: PdfAnnotation[], mode: AnnotationCommit = "structure", textId?: string) => {
      if (mode === "structure") {
        recordAnnotationHistory(history, annotationsRef.current);
        textEditRef.current = null;
      } else if (mode === "text" && textId) {
        const now = Date.now();
        const last = textEditRef.current;
        // 连续输入并成一步;换批注或停顿超过窗口就另起一步。
        if (!last || last.id !== textId || now - last.at > TEXT_UNDO_GROUP_MS) {
          recordAnnotationHistory(history, annotationsRef.current);
        }
        textEditRef.current = { id: textId, at: now };
      }
      annotationsEpoch.current += 1;
      annotationsRef.current = next;
      setAnnotations(next);
      if (vaultPath) savePdfAnnotations(vaultPath, docKey, next, materialDir);
    },
    [vaultPath, docKey, history, materialDir],
  );

  const applyHistory = useCallback(
    (next: PdfAnnotation[]) => {
      textEditRef.current = null;
      commitAnnotations(next, "none");
    },
    [commitAnnotations],
  );

  const undoAnnotations = useCallback(() => {
    const previous = undoAnnotationHistory(history, annotationsRef.current);
    if (previous !== null) applyHistory(previous);
  }, [applyHistory, history]);

  const redoAnnotations = useCallback(() => {
    const next = redoAnnotationHistory(history, annotationsRef.current);
    if (next !== null) applyHistory(next);
  }, [applyHistory, history]);

  // 键盘归属只看「最近一次鼠标按在哪儿」,不给阅读器加 tabindex / focus()。
  // 在 mousedown 里 focus 可聚焦容器会让 WebKit 的文字选区锚点跳变,小小的
  // 拖选会变成一大片;选择行为必须保持浏览器原生。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      pdfActiveRef.current = !!viewerRef.current?.contains(event.target as Node);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // 批注撤销:只在这个 PDF 阅读器是当前活动面时接管 Ctrl/Cmd+Z。
  // 批注输入框里也走批注历史(空输入框撤销就是撤掉刚建的批注);
  // 书签搜索框保留原生撤销。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const active = document.activeElement;
      const inViewer = !!(active && viewerRef.current?.contains(active));
      if (!pdfActiveRef.current && !inViewer) return;
      if (event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo =
        (key === "z" && event.shiftKey) ||
        (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey);
      if (!isUndo && !isRedo) return;
      const target = event.target as HTMLElement | null;
      const editable = target?.closest(
        "input, textarea, select, [contenteditable='true']",
      ) as HTMLElement | null;
      if (editable && !editable.classList.contains("pdf-note-input")) return;
      if (active && active !== document.body && !inViewer) return;
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (isRedo) redoAnnotations();
      else undoAnnotations();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [redoAnnotations, undoAnnotations]);

  const addAnnotation = useCallback(
    (page: number, rects: NormRect[], kind: PdfAnnotation["kind"]): string | null => {
      if (rects.length === 0) return null;
      const id = newPdfAnnotationId();
      commitAnnotations([
        ...annotationsRef.current,
        { id, page, rects, kind, text: "", createdAt: Date.now() },
      ]);
      return id;
    },
    [commitAnnotations],
  );

  const addHighlight = useCallback(
    (page: number, rects: NormRect[]) => {
      addAnnotation(page, rects, "highlight");
    },
    [addAnnotation],
  );

  /** 选中文字 → 建文字批注并把光标送进右侧留白的输入框。 */
  const addNote = useCallback(
    (page: number, rects: NormRect[]) => {
      const id = addAnnotation(page, rects, "note");
      if (id) setFocusNote({ id, nonce: ++focusNonce.current });
    },
    [addAnnotation],
  );

  const focusNoteById = useCallback((id: string) => {
    setFocusNote({ id, nonce: ++focusNonce.current });
  }, []);

  const removeAnnotation = useCallback(
    (id: string) => {
      commitAnnotations(annotationsRef.current.filter((a) => a.id !== id));
    },
    [commitAnnotations],
  );

  const updateNoteText = useCallback(
    (id: string, text: string) => {
      const list = annotationsRef.current;
      const index = list.findIndex((a) => a.id === id);
      if (index < 0) return;
      const clean = text.slice(0, MAX_NOTE_TEXT);
      if (list[index].text === clean) return;
      const next = list.slice();
      next[index] = { ...list[index], text: clean };
      commitAnnotations(next, "text", id);
    },
    [commitAnnotations],
  );

  /**
   * 每页一份数组;对象身份没变的页复用上一份数组,文字批注改字时只有那一页
   * 重渲染,别让整篇 PDF 跟着输入抖动。
   */
  const pageCacheRef = useRef(
    new Map<number, { items: PdfAnnotation[]; list: PdfAnnotation[] }>(),
  );
  const annotationsByPage = useMemo(() => {
    const grouped = new Map<number, PdfAnnotation[]>();
    for (const a of annotations) {
      const list = grouped.get(a.page);
      if (list) list.push(a);
      else grouped.set(a.page, [a]);
    }
    const cache = pageCacheRef.current;
    const out = new Map<number, PdfAnnotation[]>();
    for (const [page, items] of grouped) {
      const prev = cache.get(page);
      if (
        prev &&
        prev.items.length === items.length &&
        prev.items.every((a, i) => a === items[i])
      ) {
        out.set(page, prev.list);
      } else {
        cache.set(page, { items, list: items });
        out.set(page, items);
      }
    }
    for (const page of [...cache.keys()]) if (!out.has(page)) cache.delete(page);
    return out;
  }, [annotations]);

  // --- 阅读区截图(⌘⇧E → 学习助手) ---------------------------------------
  // 把可见页面拼成一张 PNG:只取「滚动视口 ∩ 页面列」,目录栏/批注留白/
  // 页框阴影都不进图。页面 canvas 还没画完时等下一帧,最多 12 帧(≈200ms);
  // 仍不齐返回 null,由命令提示「还没渲染完」。
  useEffect(
    () =>
      registerPdfSnapshotSource(async () => {
        for (let attempt = 0; attempt < 12; attempt++) {
          const scroll = scrollRef.current;
          if (!scroll) return null;
          const view = scroll.getBoundingClientRect();
          const viewport = {
            left: view.left + scroll.clientLeft,
            top: view.top + scroll.clientTop,
            width: scroll.clientWidth,
            height: scroll.clientHeight,
          };
          const pages: SnapshotPage[] = [];
          const canvases: HTMLCanvasElement[] = [];
          let styleOwner: HTMLElement | null = null;
          for (const [n, el] of pageEls.current) {
            const full = el.firstElementChild as HTMLElement | null;
            const canvas = full?.querySelector("canvas");
            if (!full || !canvas) continue;
            if (!styleOwner) styleOwner = el;
            pages.push({
              box: snapshotRect(el),
              full: snapshotRect(full),
              pixels: canvas.width,
              annotations: (annotationsByPage.get(n) ?? []).map((a) => ({
                kind: a.kind,
                rects: a.rects,
              })),
            });
            canvases.push(canvas);
          }
          const plan = planSnapshot(viewport, pages);
          if (plan) {
            const cssVar = (name: string, fallback: string) =>
              (styleOwner ? getComputedStyle(styleOwner).getPropertyValue(name) : "").trim() ||
              fallback;
            return canvasToFile(
              paintSnapshot(plan, canvases, {
                background: getComputedStyle(scroll).backgroundColor,
                paper: cssVar("--pdf-paper", "#ffffff"),
                tint: eyeCare ? cssVar("--pdf-tint", "#cfe4c4") : null,
                highlight: cssVar("--pdf-anno", "rgb(255 224 0 / 42%)"),
                note: cssVar("--pdf-note", "rgb(0 140 255 / 42%)"),
              }),
            );
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return null;
      }),
    [annotationsByPage, eyeCare],
  );

  // Esc 退出批注模式(与框选的 Esc 不冲突:进入框选会先退出批注)。
  useEffect(() => {
    if (!tool) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTool(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  // 离页前把 300ms 防抖里的改动冲刷掉。
  useEffect(() => {
    const flush = () => flushPdfAnnotations();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flushPdfAnnotations();
    };
  }, []);

  // --- track column width (divider drag / window resize / outline toggle) ---
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = (immediate: boolean) => {
      if (timer) clearTimeout(timer);
      timer = null;
      const width = el.clientWidth;
      const outer = el.offsetWidth;
      const apply = () => {
        setScrollWidth((prev) => (prev === width ? prev : width));
        // 留白宽度按面板总宽(含滚动条)算,滚动条出现/消失时留白不跟着抖。
        setPanelWidth((prev) => (prev === outer ? prev : outer));
      };
      if (immediate) {
        apply();
        return;
      }
      // A divider drag reflows the column at 60 Hz. Re-rendering the reader
      // (and re-measuring every visible page's canvas) on each of those frames
      // is pure jank; one update after the drag settles is enough.
      timer = setTimeout(() => {
        timer = null;
        apply();
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

  // --- 文字批注的右侧留白:几何 ---------------------------------------------
  // 批注卡对齐选区锚点的纵向位置;同一行选了多次就按从左到右、从上到下排,
  // 互相重叠时整体往下推。坐标都相对整个 PDF 内容区(stage),连线用同一份。
  const noteList = useMemo(
    () => sortNotes(annotations.filter(isNoteAnnotation)),
    [annotations],
  );
  /** 只由「页 + 矩形」决定;改批注文字不重新量布局。 */
  const noteLayoutKey = useMemo(
    () =>
      noteList
        .map(
          (a) =>
            `${a.id}:${a.page}:${a.rects
              .map((r) => `${r.x},${r.y},${r.w},${r.h}`)
              .join(";")}`,
        )
        .join("|"),
    [noteList],
  );
  /** 改字会改变卡片高度,重排要跟着文字走;key 只用来触发,不参与几何。 */
  const noteTextKey = useMemo(
    () => noteList.map((a) => `${a.id}\u0000${a.text}`).join("\u0001"),
    [noteList],
  );
  const noteListRef = useRef(noteList);
  useLayoutEffect(() => {
    noteListRef.current = noteList;
  });

  const computeNotePlacements = useCallback(() => {
    const list = noteListRef.current;
    const stage = stageRef.current;
    const rail = notesRef.current;
    if (!stage || !rail || list.length === 0) {
      setNotePlacements((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    // 卡片高度由文字行数决定:文字/宽度没变就不重写,避免长批注每次重排
    // 都把输入框高度归零、滚动位置跳回顶部。
    const refits: {
      id: string;
      text: string;
      width: number;
      input: HTMLTextAreaElement;
      scrollTop: number;
    }[] = [];
    for (const a of list) {
      const card = noteEls.current.get(a.id);
      const input = card?.querySelector<HTMLTextAreaElement>(".pdf-note-input");
      if (!card || !input) continue;
      const width = card.clientWidth;
      const fit = noteFits.current.get(a.id);
      if (fit && fit.text === a.text && fit.width === width) continue;
      refits.push({
        id: a.id,
        text: a.text,
        width,
        input,
        scrollTop: input.scrollTop,
      });
      input.style.height = "auto";
      input.style.overflowY = "hidden";
    }
    const naturals = refits.map((f) => f.input.scrollHeight);
    refits.forEach((f, i) => {
      const natural = naturals[i] ?? NOTE_INPUT_MIN_HEIGHT;
      f.input.style.height = `${Math.min(
        NOTE_INPUT_MAX_HEIGHT,
        Math.max(NOTE_INPUT_MIN_HEIGHT, natural),
      )}px`;
      f.input.style.overflowY =
        natural > NOTE_INPUT_MAX_HEIGHT ? "auto" : "hidden";
      f.input.scrollTop = f.scrollTop;
      noteFits.current.set(f.id, { text: f.text, width: f.width });
    });
    const anchors: { id: string; x: number; y: number }[] = [];
    const desired: number[] = [];
    const heights: number[] = [];
    for (const a of list) {
      const pageEl = pageEls.current.get(a.page);
      const anchor = rectsAnchor(a.rects);
      if (!pageEl || !anchor) continue;
      const full = (pageEl.firstElementChild as HTMLElement | null) ?? pageEl;
      const fullRect = full.getBoundingClientRect();
      const pageRect = pageEl.getBoundingClientRect();
      if (fullRect.width <= 0 || fullRect.height <= 0) continue;
      const clampX = (value: number) =>
        Math.min(
          Math.max(value, pageRect.left - stageRect.left + 2),
          pageRect.right - stageRect.left - 2,
        );
      const clampY = (value: number) =>
        Math.min(
          Math.max(value, pageRect.top - stageRect.top + 2),
          pageRect.bottom - stageRect.top - 2,
        );
      const x = clampX(fullRect.left - stageRect.left + anchor.x * fullRect.width);
      const y = clampY(fullRect.top - stageRect.top + anchor.y * fullRect.height);
      anchors.push({ id: a.id, x, y });
      // 卡片顶端比锚点高半张卡;夹进内容区顶部,再统一做防重叠堆叠。
      desired.push(Math.max(4, y - NOTE_HEAD_OFFSET));
      // 卡片在留白里始终渲染(未定位时透明),所以这里量得到真实高度。
      heights.push(
        noteEls.current.get(a.id)?.offsetHeight ?? NOTE_INPUT_MIN_HEIGHT,
      );
    }
    if (anchors.length === 0) {
      setNotePlacements((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const tops = stackNoteTops(desired, heights, NOTE_BOX_GAP);
    const boxX = railRect.left - stageRect.left + NOTE_BOX_INSET;
    const boxRight = boxX + Math.max(0, railRect.width - NOTE_BOX_INSET * 2);
    const next = anchors.map((p, i) => ({
      id: p.id,
      anchorX: p.x,
      anchorY: p.y,
      top: tops[i],
      boxX,
      boxRight,
    }));
    setNotePlacements((prev) => (samePlacements(prev, next) ? prev : next));
  }, []);

  useLayoutEffect(() => {
    // 几何一律现场量(DOM 是唯一来源);这些依赖只负责在页面重排后重算:
    // 换文档、缩放/栏宽变化、裁剪改变都会让锚点像素位置变。
    void targetWidth;
    void cropShown;
    void railWidth;
    void doc;
    void noteTextKey;
    computeNotePlacements();
  }, [computeNotePlacements, noteLayoutKey, noteTextKey, targetWidth, cropShown, railWidth, doc]);

  // 页面高度从「按第一页比例估」变成真实高度、窗口缩放等都会改变锚点 y:
  // 观察内容区尺寸,收敛后重排(用 rAF 合并同一帧的多次回调)。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        computeNotePlacements();
      });
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [computeNotePlacements]);

  const placementById = useMemo(
    () => new Map(notePlacements.map((p) => [p.id, p])),
    [notePlacements],
  );

  const registerNote = useCallback(
    (id: string, el: HTMLDivElement | null) => {
      if (el) noteEls.current.set(id, el);
      else noteEls.current.delete(id);
    },
    [],
  );

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
        if (set.size > 0) {
          const top = Math.min(...set);
          setCurrentPage(top);
          // 滚动式翻页不再经过 goToPage；裁剪等重排要用「当前可见的顶页」
          // 做落点，ref 必须跟着可见页一起走。
          currentPageRef.current = top;
        }
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

  const registerPage = useCallback(
    (n: number, el: HTMLDivElement | null) => {
      if (el) {
        pageEls.current.set(n, el);
        // 锚点页挂载的那一刻就落位:所有页的占位框已经在同一批提交里,
        // scrollHeight 是完整的,不必等首帧画完再跳一下。
        applyReadPosition();
      } else {
        pageEls.current.delete(n);
      }
    },
    [applyReadPosition],
  );

  // 首/尾状态只用于翻页按钮的 disabled：按步长翻页后，页号不再是边界
  // （最后一页也可能还有半屏）。滚动的每帧只读已缓存的 scrollTop/Height，
  // 状态只在跨过边界时变一次；内容高度由 stage 的 ResizeObserver 补触发。
  // 阅读位置也在这里存：滚动停止 350ms 后量一次所有页（一次批量布局读取），
  // 不在每帧做几何计算。
  useEffect(() => {
    const scroll = scrollRef.current;
    const stage = stageRef.current;
    if (!scroll) return;
    let raf = 0;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const saveNow = () => {
      saveTimer = null;
      if (!vaultPath || !positionLoaded.current || !positionApplied.current) return;
      const position = pdfPositionAt(
        pageMetrics(scroll, pageEls.current),
        scroll.scrollTop,
      );
      if (position) savePdfReadPosition(vaultPath, docKey, position);
    };
    const scheduleSave = () => {
      if (!positionLoaded.current || !positionApplied.current) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 350);
    };
    const sync = () => {
      raf = 0;
      const top = scroll.scrollTop <= 1;
      const bottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
      setAtScrollTop((value) => (value === top ? value : top));
      setAtScrollBottom((value) => (value === bottom ? value : bottom));
      scheduleSave();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };
    scroll.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    if (stage) observer.observe(stage);
    sync();
    return () => {
      scroll.removeEventListener("scroll", schedule);
      if (raf) cancelAnimationFrame(raf);
      if (saveTimer) clearTimeout(saveTimer);
      observer.disconnect();
    };
  }, [doc, numPages, vaultPath, docKey]);

  function goToPage(n: number) {
    const el = pageEls.current.get(n);
    const scroll = scrollRef.current;
    if (!el || !scroll) return;
    if (n > numPages || n < 1) return;
    userScrolled.current = true;
    positionAnchor.current = null;
    const top = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 10;
    scroll.scrollTo({ top: Math.max(0, top) });
    setCurrentPage(n);
    currentPageRef.current = n;
  }

  /**
   * 翻页 = 以「可见高度 × step」滚动，而不是跳到下一页页首。
   * 默认 50% 时上一屏的下半部分刚好留在屏幕上半区，新内容从下半屏进入；
   * 眼睛不必每次都回到屏幕顶部。首尾由 steppedScrollTop 夹紧。
   * 落点若切在文字行内，在 2% 视口内把最近的行边对齐到分界线。
   */
  const flipPage = useCallback(
    (delta: 1 | -1) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      // 主动翻页 = 阅读位置归用户,不再按打开时的锚点还原。
      userScrolled.current = true;
      positionAnchor.current = null;
      const viewport = scroll.clientHeight;
      const content = scroll.scrollHeight;
      const max = Math.max(0, content - viewport);
      const nominal = steppedScrollTop(
        scroll.scrollTop,
        viewport,
        content,
        delta,
        pageStep,
      );
      scroll.scrollTop = nominal;
      // 已经在首尾时不微调：PageUp 在顶部就该停在顶部。
      if (nominal <= 0 || nominal >= max) return;
      const snapped = snapFlipToLine(scroll, nominal, pageStep);
      if (snapped !== nominal) scroll.scrollTop = snapped;
    },
    [pageStep],
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
    const currentContent = store.settings.studyContentWidth;
    if (autoFitPass.current > 0 && currentContent !== autoFitTarget.current) {
      // 上一趟之后用户已经手动拖过中栏:手动值优先,放弃校正。
      autoFitPass.current = MAX_FIT_PASSES;
      return;
    }
    autoFitPass.current += 1;
    autoFitFrom.current = targetWidth;
    if (Math.abs(currentContent - target) >= 2) {
      autoFitTarget.current = target;
      store.patchSettings({ studyContentWidth: target });
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

  /** 框选与批注互斥:框选层盖住页面,批注的点击/拖选交给谁必须唯一。 */
  function toggleCropping() {
    const next = !cropping;
    setCropping(next);
    if (next) setTool(null);
  }

  function toggleTool(next: PdfTool) {
    setTool((current) => (current === next ? null : next));
    setCropping(false);
  }

  /**
   * 右键在高亮/文字批注之间切换——只有已经点过其中一种批注才接管右键,
   * 普通阅读时的右键菜单原样保留。输入框里的右键也不拦(用户可能要复制/粘贴)。
   */
  function handleContextMenu(event: React.MouseEvent) {
    if (!tool) return;
    const target = event.target as Element | null;
    if (target?.closest(".pdf-note-box")) return;
    event.preventDefault();
    setTool(tool === "note" ? "highlight" : "note");
  }

  return (
    <div
      className={`pdf-viewer${eyeCare ? " eye-care" : ""}${tool ? ` tool-${tool}` : ""}`}
      ref={viewerRef}
      onContextMenu={handleContextMenu}
      style={
        {
          "--pdf-outline-w": `${outlineWidth}px`,
          // 翻页后旧内容占视口上方 1-step，新内容从下方 step 处开始。
          "--read-old": `${Math.round((1 - pageStep) * 100)}%`,
        } as React.CSSProperties
      }
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
          title={prevKeys ? `向上翻页(${prevKeys})` : "向上翻页"}
          disabled={atScrollTop}
          onClick={() => flipPage(-1)}
        >
          ‹
        </button>
        <span className="pdf-page-indicator">
          {currentPage} / {numPages || "—"}
        </span>
        <button
          className="icon-btn pdf-tool-btn"
          title={nextKeys ? `向下翻页(${nextKeys})` : "向下翻页"}
          disabled={numPages === 0 || atScrollBottom}
          onClick={() => flipPage(1)}
        >
          ›
        </button>
        <span className="pdf-tool-sep" aria-hidden />
        <button
          className={`icon-btn pdf-tool-btn${tool === "highlight" ? " active" : ""}`}
          title={
            !annotationsLoaded
              ? "正在读取批注…"
              : tool === "highlight"
                ? "退出高亮批注(Esc)"
                : "高亮批注:单击一行或拖选文字,标成亮黄色;点已有高亮可取消。右键切换到文字批注"
          }
          disabled={!annotationsLoaded}
          onClick={() => toggleTool("highlight")}
        >
          ✎ 高亮
        </button>
        <button
          className={`icon-btn pdf-tool-btn${tool === "note" ? " active" : ""}`}
          title={
            !annotationsLoaded
              ? "正在读取批注…"
              : tool === "note"
                ? "退出文字批注(Esc)"
                : "文字批注:拖选一段文字,右侧留白出现批注框。右键切换到高亮批注"
          }
          disabled={!annotationsLoaded}
          onClick={() => toggleTool("note")}
        >
          ✍ 文字
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
          onClick={toggleCropping}
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
            <div className="pdf-stage" ref={stageRef}>
              {/* 批注留白在页面左侧(贴着书签栏),阅读区仍贴右边。 */}
              {railWidth > 0 && (
                <aside
                  className="pdf-notes"
                  ref={notesRef}
                  style={{ width: railWidth }}
                  aria-label="文字批注"
                >
                  {tool === "note" && noteList.length === 0 && (
                    <p className="pdf-notes-hint">拖选文字后，批注写在这里</p>
                  )}
                  {noteList.map((annotation) => {
                    const placement = placementById.get(annotation.id);
                    return (
                      <NoteBox
                        key={annotation.id}
                        annotation={annotation}
                        top={placement?.top ?? 4}
                        placed={placement !== undefined}
                        focusToken={
                          focusNote?.id === annotation.id ? focusNote.nonce : 0
                        }
                        register={registerNote}
                        onChange={updateNoteText}
                        onRemove={removeAnnotation}
                      />
                    );
                  })}
                </aside>
              )}
              <div className="pdf-page-area">
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
                        tool={tool}
                        translateEnabled={translateEnabled}
                        annotations={annotationsByPage.get(n)}
                        onAddHighlight={addHighlight}
                        onAddNote={addNote}
                        onFocusNote={focusNoteById}
                        onRemoveAnnotation={removeAnnotation}
                        onTranslateSelection={requestTranslation}
                        register={registerPage}
                      />
                    ))}
                  </div>
                )}
              </div>
              {notePlacements.length > 0 && (
                <svg className="pdf-note-lines" aria-hidden>
                  {notePlacements.map((placement) => (
                    <g key={placement.id}>
                      <path d={noteConnectorPath(placement)} />
                      <circle
                        cx={placement.anchorX}
                        cy={placement.anchorY}
                        r={3}
                      />
                    </g>
                  ))}
                </svg>
              )}
            </div>
          </div>
          {/* 翻页后的阅读分区：上方旧内容压暗，下方新内容顶部用一条圆角线
              标出。线横贯整个 PDF 组件（含左侧批注栏）。
              整层不接鼠标事件，选中/批注/链接照常。 */}
          <div className="pdf-read-guide" aria-hidden>
            <div className="pdf-read-shade" />
            <div className="pdf-read-frame" />
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
      {translateCard && (
        <TranslateCard
          state={translateCard}
          onClose={() => {
            translateSeq.current++;
            setTranslateCard(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crop selection
// ---------------------------------------------------------------------------

/** 所有页在滚动内容里的位置;一次批量读布局,只在滚动停止/落位时调用。 */
function pageMetrics(
  scroll: HTMLElement,
  pages: Map<number, HTMLDivElement>,
): PageMetric[] {
  const offset = scroll.scrollTop - scroll.getBoundingClientRect().top;
  const out: PageMetric[] = [];
  for (const [page, el] of pages) {
    const rect = el.getBoundingClientRect();
    out.push({ page, top: rect.top + offset, height: rect.height });
  }
  return out;
}

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
  /** 当前批注工具;null = 普通阅读,页面不接管点击。 */
  tool: PdfTool | null;
  /** 选中翻译开关;tool 非空时父层不会挂翻译 handler。 */
  translateEnabled: boolean;
  annotations: PdfAnnotation[] | undefined;
  onAddHighlight: (page: number, rects: NormRect[]) => void;
  onAddNote: (page: number, rects: NormRect[]) => void;
  onFocusNote: (id: string) => void;
  onRemoveAnnotation: (id: string) => void;
  onTranslateSelection: (text: string, x: number, y: number) => void;
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
  tool,
  translateEnabled,
  annotations,
  onAddHighlight,
  onAddNote,
  onFocusNote,
  onRemoveAnnotation,
  onTranslateSelection,
  register,
}: PdfPageProps) {
  // Aspect ratio of *this* page once measured. Keeping the ratio (not a pixel
  // height) means a zoom or divider drag can update the placeholder height
  // without re-rendering the page.
  const [pageRatio, setPageRatio] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
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
  const pageAnnotations = annotations ?? EMPTY_PDF_ANNOTATIONS;

  /**
   * 普通阅读模式的选中翻译。只在 tool 为空时挂载(见下面的 onMouseUp),
   * 批注工具一旦选中,这个 handler 连挂都不挂——两种手势不共享任何状态。
   *
   * 延迟到宏任务再读选区(mouseup 默认行为之后选区才落定);起止节点都
   * 必须落在 pdf.js 的 .textLayer 里,排除右侧批注留白等非正文选中。
   */
  function handleTranslateMouseUp(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || tool) return;
    const clientX = event.clientX;
    const clientY = event.clientY;
    window.setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const start =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement;
      const end =
        range.endContainer instanceof Element
          ? range.endContainer
          : range.endContainer.parentElement;
      if (!start?.closest(".textLayer") || !end?.closest(".textLayer")) return;
      const text = sel.toString().trim();
      if (!text) return;
      onTranslateSelection(text, clientX, clientY);
    }, 0);
  }

  /**
   * 批注模式的鼠标落点:
   *  - 拖选/双击 → 选区矩形(按行切分后合并):高亮模式标黄,文字模式标蓝并
   *    在建卡后把光标送进右侧留白;
   *  - 高亮模式单击 → 点在已有高亮上就取消它,否则取光标所在那一行;
   *  - 文字模式单击 → 点中蓝色批注就聚焦它的输入框,不新建。
   * 延迟到宏任务再读选区:mouseup 默认行为之后选区才是最终状态。
   */
  function handleMouseUp(event: React.MouseEvent<HTMLDivElement>) {
    // 只认左键:右键用于切换批注工具,它的 mouseup 若当成「拖选结束」,
    // 会拿右键顺手挪出来的那点选区去建批注(或误删点中的高亮)。
    if (event.button !== 0) return;
    const full = fullRef.current;
    const textDiv = textRef.current;
    if (!full || !textDiv || !tool) return;
    const pageRect = full.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return;
    const clientX = event.clientX;
    const clientY = event.clientY;
    window.setTimeout(() => {
      if (!full.isConnected) return;
      const selected = selectionRects(window.getSelection(), textDiv, pageRect);
      if (selected.length > 0) {
        const rects = mergeLineRects(selected, Math.max(0.006, 18 / pageRect.width));
        if (tool === "note") onAddNote(pageNumber, rects);
        else onAddHighlight(pageNumber, rects);
        window.getSelection()?.removeAllRanges();
        return;
      }
      const x = (clientX - pageRect.left) / pageRect.width;
      const y = (clientY - pageRect.top) / pageRect.height;
      const hit = annotationAt(pageAnnotations, pageNumber, x, y);
      if (hit) {
        if (tool === "note") {
          if (hit.kind === "note") onFocusNote(hit.id);
        } else if (hit.kind === "highlight") {
          onRemoveAnnotation(hit.id);
        }
        return;
      }
      if (tool === "note") return;
      const line = lineRectsAtPoint(
        spanRects(textDiv),
        pageRect,
        clientX,
        clientY,
        Math.max(0.008, 24 / pageRect.width),
      );
      if (line.length > 0) onAddHighlight(pageNumber, line);
    }, 0);
  }

  return (
    <div
      className="pdf-page"
      data-page={pageNumber}
      ref={wrapperRef}
      style={{ width: shownWidth, height: shownHeight }}
    >
      <div
        className="pdf-page-full"
        ref={fullRef}
        style={{ width, height, left: -offsetX, top: -offsetY }}
        onMouseUp={
          tool
            ? handleMouseUp
            : translateEnabled
              ? handleTranslateMouseUp
              : undefined
        }
      >
        <canvas ref={canvasRef} />
        <div className="pdf-anno-layer" aria-hidden>
          {pageAnnotations.map((a) =>
            a.rects.map((r, i) => (
              <div
                key={`${a.id}:${i}`}
                className={`pdf-anno-mark${a.kind === "note" ? " note" : ""}`}
                data-annotation-id={a.id}
                style={{
                  left: `${r.x * width}px`,
                  top: `${r.y * height}px`,
                  width: `${r.w * width}px`,
                  height: `${r.h * height}px`,
                }}
              />
            )),
          )}
        </div>
        <div className="textLayer" ref={textRef} />
        {eyeCare && <div className="pdf-page-tint" aria-hidden />}
      </div>
    </div>
  );
});

/** 选区落在本页的部分(正常化矩形)。跨页拖选时只取本页那段。 */
function selectionRects(
  sel: Selection | null,
  textDiv: HTMLElement,
  pageRect: DOMRect,
): NormRect[] {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  if (!textDiv.contains(range.startContainer) && !textDiv.contains(range.endContainer)) {
    return [];
  }
  const boxes = Array.from(range.getClientRects()).filter(
    (r) =>
      r.width > 0.5 &&
      r.height > 0.5 &&
      r.bottom > pageRect.top &&
      r.top < pageRect.bottom &&
      r.right > pageRect.left &&
      r.left < pageRect.right,
  );
  return normalizeRects(boxes, pageRect);
}

/** 文本层所有 span 的客户区矩形;单击取行用。 */
function spanRects(textDiv: HTMLElement): BoxLike[] {
  const out: BoxLike[] = [];
  for (const span of textDiv.querySelectorAll("span")) {
    for (const r of span.getClientRects()) {
      if (r.width <= 0.5 || r.height <= 0.5) continue;
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return out;
}

/**
 * 分界线所在的文字行：只量当前页文本层里与分界线相交的 span。
 * 分界线落在页缝/页边距时没有相交行，返回空数组（保持原落点）。
 */
function lineBandsAtY(
  scroll: HTMLElement,
  y: number,
): Array<{ top: number; bottom: number }> {
  for (const page of scroll.querySelectorAll<HTMLElement>(".pdf-page")) {
    const pageRect = page.getBoundingClientRect();
    if (pageRect.top > y || pageRect.bottom < y) continue;
    const textDiv = page.querySelector<HTMLElement>(".textLayer");
    if (!textDiv) return [];
    return spanRects(textDiv)
      .filter(
        (r) =>
          r.bottom > y &&
          r.top < y &&
          r.right > pageRect.left &&
          r.left < pageRect.right,
      )
      .map((r) => ({ top: r.top, bottom: r.bottom }));
  }
  return [];
}

/** 按分界线的实际 DOM 位置量文字行，算出微调后的落点。 */
function snapFlipToLine(scroll: HTMLElement, nominal: number, step: number): number {
  const wrap = scroll.parentElement;
  const guide = wrap?.querySelector<HTMLElement>(".pdf-read-guide") ?? null;
  const height = (guide ?? scroll).clientHeight;
  const top = (guide ?? scroll).getBoundingClientRect().top;
  // 与 --read-old 的取整保持一致，线、阴影、量出来的分界线三者同一条。
  const old = Math.round((1 - step) * 100);
  const boundary = top + (height * old) / 100;
  const viewport = scroll.clientHeight;
  return snapScrollTopToLine(
    nominal,
    viewport,
    scroll.scrollHeight,
    boundary,
    lineBandsAtY(scroll, boundary),
    viewport * 0.02,
  );
}

// ---------------------------------------------------------------------------
// Text-annotation cards (right margin)
// ---------------------------------------------------------------------------

interface NoteBoxProps {
  annotation: PdfAnnotation;
  top: number;
  /** 还没算好锚点时为 false:卡片照常排版(供测量),只是不显示。 */
  placed: boolean;
  /** 非 0 时聚焦并把光标放到末尾(新建/点中蓝色高亮)。 */
  focusToken: number;
  register: (id: string, el: HTMLDivElement | null) => void;
  onChange: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}

function NoteBox({
  annotation,
  top,
  placed,
  focusToken,
  register,
  onChange,
  onRemove,
}: NoteBoxProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    register(annotation.id, cardRef.current);
    return () => register(annotation.id, null);
  }, [register, annotation.id]);
  useEffect(() => {
    if (!focusToken) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [focusToken]);
  return (
    <div
      ref={cardRef}
      className="pdf-note-box"
      data-annotation-id={annotation.id}
      data-focus-token={focusToken}
      style={{ top, opacity: placed ? 1 : 0 }}
    >
      <div className="pdf-note-head">
        <span className="pdf-note-page">P{annotation.page}</span>
        <button
          className="pdf-note-remove"
          title="删除这条文字批注"
          onClick={() => onRemove(annotation.id)}
        >
          ×
        </button>
      </div>
      <textarea
        ref={inputRef}
        className="pdf-note-input"
        rows={1}
        value={annotation.text}
        placeholder="写批注…"
        maxLength={MAX_NOTE_TEXT}
        data-ime-chinese="true"
        onChange={(event) => onChange(annotation.id, event.target.value)}
        onFocus={() => imeOnChineseFocus()}
        onBlur={(event) => {
          // 两张批注卡之间换焦点时保持中文;真正离开批注才交还输入源。
          const next = event.relatedTarget as Element | null;
          if (!next?.closest(".pdf-note-box")) imeSyncToEditor();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      />
    </div>
  );
}

/**
 * 锚点到卡片抬头的一条柔和曲线:先竖直离开选区底边,再横向进留白。
 * 留白在左(当前布局)时从卡片右缘接入,曲线整体向左收。
 */
function noteConnectorPath(placement: NotePlacement): string {
  const { anchorX, anchorY, boxX, boxRight, top } = placement;
  const endY = top + NOTE_HEAD_OFFSET;
  const toLeft = boxRight <= anchorX;
  const endX = toLeft ? boxRight : boxX;
  const dx = Math.max(16, Math.abs(anchorX - endX));
  const dir = toLeft ? -1 : 1;
  // 起点切线朝下:线从文字底部「落」出来,而不是贴着同一行的字横跑。
  const c1x = anchorX + dir * Math.min(18, dx * 0.2);
  const c1y = anchorY + 10;
  const c2x = endX - dir * dx * 0.45;
  return `M ${anchorX} ${anchorY} C ${c1x} ${c1y}, ${c2x} ${endY}, ${endX} ${endY}`;
}

function samePlacements(a: NotePlacement[], b: NotePlacement[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    return (
      p.id === q.id &&
      Math.abs(p.top - q.top) < 0.5 &&
      Math.abs(p.anchorX - q.anchorX) < 0.5 &&
      Math.abs(p.anchorY - q.anchorY) < 0.5 &&
      Math.abs(p.boxX - q.boxX) < 0.5 &&
      Math.abs(p.boxRight - q.boxRight) < 0.5
    );
  });
}

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

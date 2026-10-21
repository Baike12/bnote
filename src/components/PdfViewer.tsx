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
import {
  PAGE_TOP_PAD,
  basePageWidth,
  contentWidthForRenderedPage,
  normalizeSplit,
} from "@/study/layoutModel";
import {
  clampOutlineWidth,
  loadOutlineWidth,
  notesRailWidth,
  saveOutlineWidth,
} from "@/study/pdfLayout";
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

/** 文字批注卡:固定高度,右侧留白里的纵向排布才有确定几何。 */
const NOTE_BOX_HEIGHT = 108;
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
  /** 卡片左缘(相对内容区),连线终点。 */
  boxX: number;
}

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
  const stageRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLElement>(null);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const docKey = vaultRelPath(path, vaultPath ?? "");
  /** 右侧留白从面板宽度里切出去;能放下一页最小宽度才留。 */
  const railWidth = notesRailWidth(panelWidth);
  const containerWidth = Math.max(0, scrollWidth - railWidth);

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
    void loadPdfAnnotations(vaultPath, docKey)
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
  }, [vaultPath, docKey, history]);

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
      if (vaultPath) savePdfAnnotations(vaultPath, docKey, next);
    },
    [vaultPath, docKey, history],
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
    const anchors: { id: string; x: number; y: number }[] = [];
    const desired: number[] = [];
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
    }
    if (anchors.length === 0) {
      setNotePlacements((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const tops = stackNoteTops(desired, NOTE_BOX_HEIGHT, NOTE_BOX_GAP);
    const boxX = railRect.left - stageRect.left + NOTE_BOX_INSET;
    const next = anchors.map((p, i) => ({
      id: p.id,
      anchorX: p.x,
      anchorY: p.y,
      top: tops[i],
      boxX,
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
    computeNotePlacements();
  }, [computeNotePlacements, noteLayoutKey, targetWidth, cropShown, railWidth, doc]);

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
                        annotations={annotationsByPage.get(n)}
                        onAddHighlight={addHighlight}
                        onAddNote={addNote}
                        onFocusNote={focusNoteById}
                        onRemoveAnnotation={removeAnnotation}
                        register={registerPage}
                      />
                    ))}
                  </div>
                )}
              </div>
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
                    if (!placement) return null;
                    return (
                      <NoteBox
                        key={annotation.id}
                        annotation={annotation}
                        top={placement.top}
                        focusToken={
                          focusNote?.id === annotation.id ? focusNote.nonce : 0
                        }
                        onChange={updateNoteText}
                        onRemove={removeAnnotation}
                      />
                    );
                  })}
                </aside>
              )}
              {notePlacements.length > 0 && (
                <svg className="pdf-note-lines" aria-hidden>
                  {notePlacements.map((placement) => (
                    <g key={placement.id}>
                      <path d={noteConnectorPath(placement)} />
                      <circle
                        cx={placement.anchorX}
                        cy={placement.anchorY}
                        r={2.4}
                      />
                    </g>
                  ))}
                </svg>
              )}
            </div>
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
  /** 当前批注工具;null = 普通阅读,页面不接管点击。 */
  tool: PdfTool | null;
  annotations: PdfAnnotation[] | undefined;
  onAddHighlight: (page: number, rects: NormRect[]) => void;
  onAddNote: (page: number, rects: NormRect[]) => void;
  onFocusNote: (id: string) => void;
  onRemoveAnnotation: (id: string) => void;
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
  annotations,
  onAddHighlight,
  onAddNote,
  onFocusNote,
  onRemoveAnnotation,
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
   * 批注模式的鼠标落点:
   *  - 拖选/双击 → 选区矩形(按行切分后合并):高亮模式标黄,文字模式标蓝并
   *    在建卡后把光标送进右侧留白;
   *  - 高亮模式单击 → 点在已有高亮上就取消它,否则取光标所在那一行;
   *  - 文字模式单击 → 点中蓝色批注就聚焦它的输入框,不新建。
   * 延迟到宏任务再读选区:mouseup 默认行为之后选区才是最终状态。
   */
  function handleMouseUp(event: React.MouseEvent<HTMLDivElement>) {
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
        onMouseUp={tool ? handleMouseUp : undefined}
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

// ---------------------------------------------------------------------------
// Text-annotation cards (right margin)
// ---------------------------------------------------------------------------

interface NoteBoxProps {
  annotation: PdfAnnotation;
  top: number;
  /** 非 0 时聚焦并把光标放到末尾(新建/点中蓝色高亮)。 */
  focusToken: number;
  onChange: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}

function NoteBox({ annotation, top, focusToken, onChange, onRemove }: NoteBoxProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
      className="pdf-note-box"
      data-annotation-id={annotation.id}
      data-focus-token={focusToken}
      style={{ top, height: NOTE_BOX_HEIGHT }}
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
        value={annotation.text}
        placeholder="写批注…"
        maxLength={MAX_NOTE_TEXT}
        onChange={(event) => onChange(annotation.id, event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      />
    </div>
  );
}

/** 锚点到卡片抬头的一条柔和曲线(三次贝塞尔,两端各留一段水平切线)。 */
function noteConnectorPath(placement: NotePlacement): string {
  const { anchorX, anchorY, boxX, top } = placement;
  const endY = top + NOTE_HEAD_OFFSET;
  const dx = Math.max(16, boxX - anchorX);
  const c1 = anchorX + dx * 0.45;
  const c2 = boxX - dx * 0.45;
  return `M ${anchorX} ${anchorY} C ${c1} ${anchorY}, ${c2} ${endY}, ${boxX} ${endY}`;
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
      Math.abs(p.boxX - q.boxX) < 0.5
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

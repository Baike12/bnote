// Must be first: pdf.js 6 reads `Iterator.prototype.join` while its module is
// evaluated, and WebKit on macOS 15 has no Iterator global yet.
import "@/study/pdfjsCompat";
import {
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
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist";
// Our worker entry (not pdf.js's own URL) so the worker global gets the shim.
import PdfWorker from "@/study/pdfWorker?worker";
import "pdfjs-dist/web/pdf_viewer.css";
import { api, translateApi } from "@/lib/tauri";
import { bindingsForCommand, formatBinding } from "@/commands/keys";
import { useAppStore } from "@/state/appStore";
import { TranslateCard, type TranslateCardState } from "./TranslateCard";
import { loadPdfCrop, savePdfCrop, type PdfCrop } from "@/study/crop";
import {
  flushPdfAnnotations,
  loadPdfAnnotations,
  newPdfAnnotationId,
  savePdfAnnotations,
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
import { steppedScrollTop } from "@/study/reading";
import { pageMetrics, snapFlipToLine } from "@/components/study/pdf/geometry";
import { CropLayer } from "@/components/study/pdf/CropLayer";
import { PdfPage } from "@/components/study/pdf/page";
import { OutlineNodeView, base64ToBytes, resolveOutline } from "@/components/study/pdf/Outline";
import type { PdfTool } from "@/components/study/pdf/types";

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
/** After a crop the full page is scaled up (see basePageWidth), the upper limit is more generous than the column width. */
const MAX_PAGE_WIDTH = 3200;
/** How far outside the viewport a page keeps its canvas (px). */
const RENDER_MARGIN = 1000;
/** Width changes settle before re-rendering every visible page. */
const RESIZE_DEBOUNCE_MS = 140;


/** How an annotation change is committed: a structural change counts as one step, loading and undo do not. */
type AnnotationCommit = "none" | "structure";


interface PdfViewerProps {
  /** Absolute path inside the vault. */
  path: string;
  /** Eye-care tint (pale green paper), persisted in settings. */
  eyeCare: boolean;
  onToggleEyeCare: () => void;
  /** Fraction of the visible height scrolled per page turn (0.1-1, default 0.5). */
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
  /** Width of the scroll viewport (clientWidth, without the vertical scrollbar). */
  const [scrollWidth, setScrollWidth] = useState(0);
  const [outline, setOutline] = useState<PdfOutlineNode[]>([]);
  /** The middle column width is measured once, after the outline is parsed (even when there is none): the horizontal space taken by the bookmarks bar has to be counted into the target width for "exactly one page fits". */
  const [outlineLoaded, setOutlineLoaded] = useState(false);
  /** The bookmarks bar starts collapsed: opening a PDF shows the body first, the outline is opened with the "Bookmarks" button in the toolbar. */
  const [outlineOpen, setOutlineOpen] = useState(false);
  /** The preferred width (persisted); the actually displayed width is clamped once more against the current column width, see the effect below. */
  const preferredOutlineWidth = useRef(loadOutlineWidth());
  const [outlineWidth, setOutlineWidth] = useState(() => preferredOutlineWidth.current);
  const [outlineQuery, setOutlineQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  /** Whether the scroll area is already at the top or the bottom: since paging scrolls by a step, the availability of the buttons is decided by the scroll position and no longer by "is the current page the first or the last one" (the last page may still have half a screen left). */
  const [atScrollTop, setAtScrollTop] = useState(true);
  const [atScrollBottom, setAtScrollBottom] = useState(false);
  const [activePages, setActivePages] = useState<Set<number>>(() => new Set());
  /** The block of each page that is shown (normalized ratios); null = the whole page. */
  const [crop, setCrop] = useState<PdfCrop | null>(() => loadPdfCrop(path));
  /** While cropping, the page temporarily spreads back to the full page, so the cropped away margin can be framed. */
  const [cropping, setCropping] = useState(false);
  const cropShown = cropping ? null : crop;
  /** The current annotation tool: only the highlight is left; null = plain reading. */
  const [tool, setTool] = useState<PdfTool | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  /** The annotation mode is not allowed before the initial annotation file was read: otherwise the first commit would overwrite the old annotations that were not read in yet. */
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const annotationsRef = useRef<PdfAnnotation[]>([]);
  /** Lets an async read prove that it is still the current document and that no local edit got in first. */
  const annotationsEpoch = useRef(0);
  /** The annotation snapshot stack for Ctrl+Z / Ctrl+Shift+Z (one per PDF, cleared when the document changes). */
  const historyRef = useRef<AnnotationHistory<PdfAnnotation[]> | null>(null);
  if (historyRef.current === null) historyRef.current = createAnnotationHistory(100);
  const history = historyRef.current;
  /** Whether the last pointerdown landed inside the PDF reader (decides who owns Ctrl+Z). */
  const pdfActiveRef = useRef(false);
  /**
   * The translation card for a selection in the body text. `translateSeq` is
   * the only writer token: changing the selection, closing the card,
   * switching the annotation tool and turning the switch off all increment
   * it, and a late IPC result that cannot prove its token is dropped.
   */
  const translateEnabled = useAppStore((s) => s.settings.studyTranslate.enabled);
  const [translateCard, setTranslateCard] = useState<TranslateCardState | null>(null);
  const translateSeq = useRef(0);
  /**
   * Between the mouseup and the setTimeout the user may already have hit the
   * annotation tool. The `tool` inside the setTimeout closure is a stale
   * value, so the current value is read through a ref: as soon as an
   * annotation tool is active the translation request is not even created,
   * which avoids the race of "a tool is selected but the translation card
   * still pops up".
   */
  const toolRef = useRef<PdfTool | null>(tool);
  useLayoutEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  const stageRef = useRef<HTMLDivElement>(null);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const docKey = vaultRelPath(path, vaultPath ?? "");

  /**
   * One selection translation. Rust decides word vs. sentence: a single word
   * only queries the built-in dictionary (a miss is returned without
   * network access), two or more words go to the model API. A late result is
   * dropped with translateSeq.
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

  // Turning the switch off, changing the document or picking an annotation
  // tool invalidates the pending requests immediately and takes the card
  // away. The annotation tool wins as a hard rule: the page does not even
  // attach the translation mouseup while tool is not null.
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

  // The card is positioned fixed: after a scroll the selection position no
  // longer matches, so it is taken away directly; a click outside the card or
  // Esc does the same. Starting a new selection in the body first closes the
  // old card, the new one opens again after the mouseup.
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
   * The material directory of this PDF (`materials/pdfs/<pinyin dir>`): the
   * annotations and the agent session records are stored there. The
   * annotations are not read before it is resolved, so nothing is read from
   * an old path first and then overwritten by a migration.
   */
  const [materialDir, setMaterialDir] = useState<string | null>(null);
  const [materialReady, setMaterialReady] = useState(false);
  /** The page column is the whole scroll viewport: there is no annotation gutter, the PDF is laid out flush with the left edge of the column. */
  const containerWidth = Math.max(0, scrollWidth);

  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const visiblePages = useRef(new Set<number>());
  const activeRef = useRef(new Set<number>());
  const currentPageRef = useRef(1);
  const outlineRef = useRef<HTMLElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  /** Every PDF is auto-fitted only once, later window or column width changes do not change the middle column width again.
   *  It is measured in several passes: changing the width makes the scrollbar appear or disappear, the real page width changes with it, so a single pass is not accurate; at most three passes, and it stops as soon as it converged. */
  const autoFitPass = useRef(0);
  const autoFitFrom = useRef(0);
  /** The middle column width written to the settings in the last pass; it is compared before the next pass and left alone once it was changed by hand. */
  const autoFitTarget = useRef<number | null>(null);

  // --- reading position ----------------------------------------------------
  /** The landing spot when the document is opened (page number plus the offset inside the page); it is cleared as soon as the user does something. */
  const positionAnchor = useRef<{ page: number; offset: number } | null>(null);
  /** Saving is not allowed before the position file was read, otherwise the initial scrollTop=0 would overwrite the anchor of the last session. */
  const positionLoaded = useRef(false);
  /** Saving is only allowed after the position was applied at least once (or when there was no anchor anyway). */
  const positionApplied = useRef(false);
  /** The user has scrolled, turned a page or jumped by themselves, so later layout changes no longer pull the position back. */
  const userScrolled = useRef(false);
  /**
   * The viewport anchor before a reflow (dragging the column width, a wider
   * window, a zoom, the auto fit). The difference to `positionAnchor`: that
   * one is "where the user left off last time" and should not matter anymore
   * after a single scroll, this one is "what is at the top of the screen
   * right now" and has to stay the same after a reflow, otherwise the same
   * scrollTop lands several pages further down once the page gets smaller.
   */
  const reflowAnchor = useRef<{ page: number; offset: number } | null>(null);
  const [positionEpoch, setPositionEpoch] = useState(0);

  // The page width is the usable width of the middle column, flush to the
  // edge (no 14 px horizontal padding anymore).
  // After a crop only the cropped block is left: at 100% the visible part
  // has to be flush with the edge, so the full page is scaled up by the crop
  // width instead of letting the crop window shrink in the middle of the
  // column with two grey bars.
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
    resetAnnotationHistory(history);
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
  // Changing the document clears the annotations first and then reads the
  // annotations of this one; when the read comes back the epoch is
  // compared, and a result that got stale because the user already started
  // annotating (a local edit advanced the epoch) is dropped.
  useEffect(() => {
    const epoch = ++annotationsEpoch.current;
    annotationsRef.current = [];
    setAnnotations([]);
    setTool(null);
    resetAnnotationHistory(history);
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
        // Not being able to read the annotation file (no annotations yet, a permission problem) does not affect reading.
      })
      .finally(() => {
        if (annotationsEpoch.current === epoch) setAnnotationsLoaded(true);
      });
  }, [vaultPath, docKey, history, materialReady, materialDir]);

  // Material directory: it is resolved again for every new PDF (the backend registers it by the vault relative path, so the same file always lands in the same directory).
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

  // --- reading position ----------------------------------------------------
  // Changing the document voids the old anchor first, then reads where this
  // PDF was left off last time. When the async read comes back the docKey
  // (the key in the closure) is compared and a stale result is dropped.
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
    // When the page number does not match (the file was replaced, the pages
    // were cropped) saving must not stay locked forever: after 2 seconds
    // recording a new position is allowed whether the landing worked or
    // not.
    const fallback = setTimeout(() => {
      positionApplied.current = true;
    }, 2000);
    void loadReadPositions(vaultPath)
      .then((data) => {
        if (cancelled) return;
        const saved = data.pdfs[key];
        // The user already started scrolling while the file was read: the position belongs to the user and is not restored.
        positionAnchor.current =
          saved && !userScrolled.current
            ? { page: saved.page, offset: saved.offset }
            : null;
        positionLoaded.current = true;
        if (!positionAnchor.current) positionApplied.current = true;
        // The read may come back after the document and the pages are ready: the epoch change lets the restore effect run once more.
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

  /** Lands the anchor on the current layout; it can be called again while the pages are not mounted yet or after a width change. */
  const applyAnchor = useCallback((anchor: { page: number; offset: number } | null) => {
    if (!anchor || !scrollRef.current) return;
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

  /** The landing spot when the document is opened: it only applies while the user has not acted yet (the anchor is "where the user left off last time"). */
  const applyReadPosition = useCallback(() => {
    if (userScrolled.current) return;
    applyAnchor(positionAnchor.current);
  }, [applyAnchor]);

  /**
   * Records "which page and which percent of it is at the top of the viewport
   * before the reflow". The page width follows the middle column, the window
   * width and the zoom, and the page height follows it, so the same
   * `scrollTop` in pixels points at completely different content (measured:
   * at 981 px wide, scrollTop=2900 rests at 53% of page 3; narrowed to
   * 390 px, the same scrollTop lands at 632% of page 6). So before every
   * state update that changes the page size the content anchor is captured,
   * and after the commit applyReflowAnchor lands it again.
   */
  const captureReflowAnchor = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const position = pdfPositionAt(pageMetrics(scroll, pageEls.current), scroll.scrollTop);
    if (position) reflowAnchor.current = { page: position.page, offset: position.offset };
  }, []);

  /** Lands on the same spot after a reflow: only once, and it is cleared afterwards so it does not fight the user's later scrolling. */
  const applyReflowAnchor = useCallback(() => {
    const anchor = reflowAnchor.current;
    if (!anchor) return false;
    reflowAnchor.current = null;
    applyAnchor(anchor);
    return true;
  }, [applyAnchor]);

  // The landing happens again after the document or the pages are mounted,
  // after the auto fit changed the width and after a crop reflow: the anchor
  // is "which page and which percent of it", so no matter how the layout
  // changes it lands in the same place. As soon as the user acts, the
  // listener below clears the anchor and never drags the user back to the
  // old position.
  //
  // A **reflow** like a column width or zoom change prefers the reflow
  // anchor (it is the line the user is looking at right now), and it has to
  // land inside the commit: the browser only paints that frame after the
  // layout effect wrote the scrollTop, and one frame late is a jump the user
  // can see.
  useLayoutEffect(() => {
    if (applyReflowAnchor()) return;
    if (!positionAnchor.current || userScrolled.current) return;
    const raf = requestAnimationFrame(() => applyReadPosition());
    return () => cancelAnimationFrame(raf);
  }, [positionEpoch, doc, targetWidth, cropShown, applyReadPosition, applyReflowAnchor]);

  // After the user scrolled, turned a page or jumped by themselves, the position belongs to the user: from then on it is only stored, never restored.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const release = () => {
      userScrolled.current = true;
      positionAnchor.current = null;
      reflowAnchor.current = null;
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

  // The pending write is flushed when the reader is left or study mode is exited.
  useEffect(() => () => flushReadPositions(), []);

  const commitAnnotations = useCallback(
    (next: PdfAnnotation[], mode: AnnotationCommit = "structure") => {
      if (mode === "structure") recordAnnotationHistory(history, annotationsRef.current);
      annotationsEpoch.current += 1;
      annotationsRef.current = next;
      setAnnotations(next);
      if (vaultPath) savePdfAnnotations(vaultPath, docKey, next, materialDir);
    },
    [vaultPath, docKey, history, materialDir],
  );

  const applyHistory = useCallback(
    (next: PdfAnnotation[]) => {
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

  // Keyboard ownership only looks at "where the mouse was pressed last", the
  // reader gets neither a tabindex nor a focus(). Focusing a focusable
  // container in mousedown makes the WebKit text selection anchor jump, a
  // small drag becomes a huge area; the selection behaviour has to stay
  // native to the browser.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      pdfActiveRef.current = !!viewerRef.current?.contains(event.target as Node);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // Annotation undo: Ctrl/Cmd+Z is only taken over when this PDF reader is the active surface.
  // Input fields (the bookmark search) keep the native undo.
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
      if (editable) return;
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

  const removeAnnotation = useCallback(
    (id: string) => {
      commitAnnotations(annotationsRef.current.filter((a) => a.id !== id));
    },
    [commitAnnotations],
  );

  /**
   * One array per page; a page whose object identities did not change reuses
   * the previous array, which avoids a re-render of the whole document.
   *
   * Only the highlights are shown: the text annotation entries of old files
   * no longer appear on screen (the data is still on disk and is written
   * back unchanged when saving, so nothing is lost).
   */
  const pageCacheRef = useRef(
    new Map<number, { items: PdfAnnotation[]; list: PdfAnnotation[] }>(),
  );
  const annotationsByPage = useMemo(() => {
    const grouped = new Map<number, PdfAnnotation[]>();
    for (const a of annotations) {
      if (a.kind === "note") continue;
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

  // --- screenshot of the reading area (⌘⇧E -> study assistant) ---------------
  // The visible pages are stitched into one PNG: only "scroll viewport ∩
  // current content area ∩ page column" is taken, the dimmed old content,
  // the outline bar, the annotation gutter and the page frame shadows stay
  // out of the image. While the page canvas is not painted yet it waits for
  // the next frame, at most 12 frames (~200 ms); if it is still incomplete
  // it returns null and the command reports "not rendered yet".
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
          // Reading split: the lower edge of the dimming overlay is the
          // boundary between "the old content just read" and "the current
          // content", and the screenshot only takes the current content area
          // below it. The overlay is a DOM layer, so measuring its lower edge
          // is enough and the step does not have to be converted again.
          const shade = scroll.parentElement?.querySelector<HTMLElement>(
            ".pdf-read-shade",
          );
          const shadeBox = shade ? snapshotRect(shade) : null;
          const currentTop = shadeBox ? shadeBox.top + shadeBox.height : null;
          const plan = planSnapshot(viewport, pages, { currentTop });
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

  // Esc leaves the annotation mode (it does not collide with the Esc of the crop: entering the crop leaves the annotation mode first).
  useEffect(() => {
    if (!tool) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTool(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  // The changes in the 300 ms debounce are flushed before leaving the page.
  useEffect(() => {
    const flush = () => flushPdfAnnotations();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flushPdfAnnotations();
    };
  }, []);

  // --- track column width (divider drag / window resize / outline toggle) ---
  const appliedWidthRef = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = (immediate: boolean) => {
      if (timer) clearTimeout(timer);
      timer = null;
      const width = el.clientWidth;
      const apply = (capture: boolean) => {
        // Nothing happens when the width did not change: the ResizeObserver
        // reports the same size again and again, and landing the anchor
        // repeatedly would fight the scrolling.
        if (width === appliedWidthRef.current) return;
        appliedWidthRef.current = width;
        // The top of the viewport is remembered first (the pages still have
        // the old size at this moment), then the pages reflow to the new
        // width.
        if (capture) captureReflowAnchor();
        setScrollWidth((prev) => (prev === width ? prev : width));
      };
      if (immediate) {
        apply(false);
        return;
      }
      // A divider drag reflows the column at 60 Hz. Re-rendering the reader
      // (and re-measuring every visible page's canvas) on each of those frames
      // is pure jank; one update after the drag settles is enough.
      timer = setTimeout(() => {
        timer = null;
        apply(true);
      }, RESIZE_DEBOUNCE_MS);
    };
    measure(true);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [captureReflowAnchor]);

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
          // The scrolling paging no longer goes through goToPage; a reflow
          // such as a crop has to land on "the topmost visible page", so the
          // ref has to follow the visible page.
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
        // The landing happens the moment the anchor page is mounted: the
        // placeholder boxes of all pages are already in the same commit, so
        // the scrollHeight is complete and there is no need to wait for the
        // first frame and jump afterwards.
        applyReadPosition();
      } else {
        pageEls.current.delete(n);
      }
    },
    [applyReadPosition],
  );

  // The top/bottom state only drives the disabled state of the paging
  // buttons: after paging by a step the page number is no longer the border
  // (the last page may still have half a screen left). Every frame of the
  // scrolling only reads the cached scrollTop/Height and the state changes
  // once when a border is crossed; the content height is triggered by the
  // ResizeObserver of the stage.
  // The reading position is stored here as well: 350 ms after the scrolling
  // stopped all pages are measured once (one batched layout read), no
  // geometry is computed per frame.
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
    reflowAnchor.current = null;
    const top = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 10;
    scroll.scrollTo({ top: Math.max(0, top) });
    setCurrentPage(n);
    currentPageRef.current = n;
  }

  /**
   * Paging scrolls by "visible height x step" instead of jumping to the top
   * of the next page. With the default 50% the lower half of the previous
   * screen stays in the upper half of the viewport and the new content
   * enters from the lower half; the eye does not have to travel back to the
   * top of the screen every time. The ends are clamped by steppedScrollTop.
   * When the landing point cuts a text line, the nearest line edge is
   * aligned to the boundary within 2% of the viewport.
   */
  const flipPage = useCallback(
    (delta: 1 | -1) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      // Paging by hand means the reading position belongs to the user, it is not restored from the anchor of the open anymore.
      userScrolled.current = true;
      positionAnchor.current = null;
      reflowAnchor.current = null;
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
      // No fine adjustment at the ends: PageUp at the top has to stay at the top.
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

  /** Zooming is a reflow of the page size: it takes the same path as dragging the column width, the top of the viewport is remembered before the size changes.
   *  The value uses a functional update: two quick clicks (two clicks in the same tick) have to accumulate two steps and must not both start from the stale value of the render. */
  function zoomStep(step: (z: number) => number) {
    captureReflowAnchor();
    setZoom((z) => {
      const next = Math.min(maxZoom, Math.max(minZoom, Math.round(step(z) * 10) / 10));
      return next === z ? z : next;
    });
  }

  // Width of the bookmarks bar: dragging only changes this column, the PDF area of the middle column takes the remaining width and the two outer columns are unaffected.
  // During the drag the value goes into a CSS variable (no setState): the
  // bookmarks may number in the hundreds and re-rendering the whole tree at
  // 60 Hz is not worth it, and a re-render triggered by the ResizeObserver in
  // the middle of the drag would spring the inline width back to its old
  // value.
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
      // Synthetic event / no active pointer
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

  // When the window or the middle column narrows, the displayed width is clamped back into the range that "leaves a minimum width for the pages"; only the display is clamped, the preference is not written back, so a column that gets wide again returns to the width the user dragged.
  useLayoutEffect(() => {
    const body = outlineRef.current?.parentElement;
    if (!body) return;
    const clamped = clampOutlineWidth(
      preferredOutlineWidth.current,
      body.getBoundingClientRect().width,
    );
    if (clamped !== outlineWidth) setOutlineWidth(clamped);
    // The bookmarks bar has to be clamped once against the current column width right after it expanded or the outline was loaded.
  }, [outlineWidth, containerWidth, outlineOpen, outline.length]);

  // When a PDF is opened, the middle column is set to the width where "one
  // page fits completely". It runs once, after the document and the outline
  // are ready: later window resizes do not change the middle column width
  // (that would also change how much can be seen vertically), and a divider
  // the user dragged by hand wins over the fitted value.
  useLayoutEffect(() => {
    // Three passes are enough to converge: the first pass converts the page
    // height difference, the two later ones correct it with the real page
    // height after the reflow (the scrollbar appearing or disappearing
    // changes the real page width, so one measurement is not accurate).
    const MAX_FIT_PASSES = 3;
    if (!doc || !outlineLoaded || autoFitPass.current >= MAX_FIT_PASSES) return;
    // After the previous pass the next one is only measured when the page
    // width really reflowed, so an unrelated dependency cannot rerun it.
    if (autoFitPass.current > 0 && targetWidth === autoFitFrom.current) return;
    const scroll = scrollRef.current;
    const viewer = viewerRef.current;
    const page = pageEls.current.get(1);
    if (!scroll || !viewer || !page) return;
    // The target is derived backwards from the page that was already
    // rendered: the height difference is converted into a width difference,
    // and how many pixels the scrollbar takes does not matter (the real
    // layout is measured).
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
      // The user dragged the middle column by hand after the previous pass: the manual value wins, the correction is dropped.
      autoFitPass.current = MAX_FIT_PASSES;
      return;
    }
    autoFitPass.current += 1;
    autoFitFrom.current = targetWidth;
    if (Math.abs(currentContent - target) >= 2) {
      autoFitTarget.current = target;
      store.patchSettings({ studyContentWidth: target });
    } else {
      // It converged (the page height differs by less than 1 px), done.
      autoFitPass.current = MAX_FIT_PASSES;
    }
  }, [doc, outlineLoaded, ratio, crop, targetWidth]);

  // The crop box changes the height of every page: after the reflow the current page is pushed to the top of the viewport again, so the reading position is not lost.
  useEffect(() => {
    if (cropping) return;
    const raf = requestAnimationFrame(() => goToPage(currentPageRef.current));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop, cropping]);

  // The paging shortcuts go through the command system (PageUp/PageDown/arrow
  // keys by default, rebindable in the settings): here only "can it flip and
  // which page" is registered with the command layer. Focus ownership is
  // handled by the dispatch layer: a bare navigation key belongs to the
  // editor or the input field it is in, a binding with a modifier (such as
  // ⌃J) works everywhere.
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

  /** The crop and the annotation are mutually exclusive: the crop layer covers the page, so who owns the click and the drag selection of the annotation has to be unique. */
  function toggleCropping() {
    const next = !cropping;
    setCropping(next);
    if (next) setTool(null);
  }

  function toggleTool(next: PdfTool) {
    setTool((current) => (current === next ? null : next));
    setCropping(false);
  }

  return (
    <div
      className={`pdf-viewer${eyeCare ? " eye-care" : ""}${tool ? ` tool-${tool}` : ""}`}
      ref={viewerRef}
      style={
        {
          "--pdf-outline-w": `${outlineWidth}px`,
          // After a page turn the old content takes the top 1-step of the viewport and the new content starts at the step from below.
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
                : "高亮批注:单击一行或拖选文字,标成亮黄色;点已有高亮可取消"
          }
          disabled={!annotationsLoaded}
          onClick={() => toggleTool("highlight")}
        >
          ✎ 高亮
        </button>
        <span className="pdf-tool-sep" aria-hidden />
        <button
          className="icon-btn pdf-tool-btn"
          title="缩小"
          onClick={() => zoomStep((z) => z - ZOOM_STEP)}
        >
          −
        </button>
        <button
          className="pdf-zoom-label"
          title="点击恢复适合宽度"
          onClick={() => zoomStep(() => 1)}
        >
          {Math.round(zoomValue * 100)}%
        </button>
        <button
          className="icon-btn pdf-tool-btn"
          title="放大"
          onClick={() => zoomStep((z) => z + ZOOM_STEP)}
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
                        translateEnabled={translateEnabled}
                        annotations={annotationsByPage.get(n)}
                        onAddHighlight={addHighlight}
                        onRemoveAnnotation={removeAnnotation}
                        onTranslateSelection={requestTranslation}
                        register={registerPage}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* The reading split after a page turn: the old content above is
              dimmed and fades out towards the boundary (no separator line is
              drawn, both ends close with the rounded tip of the shadow).
              The whole layer does not take mouse events, so selecting,
              annotating and links keep working as usual. */}
          <div className="pdf-read-guide" aria-hidden>
            <div className="pdf-read-shade" />
          </div>
          {cropping && (
            <CropLayer
              pageEls={pageEls}
              scrollRef={scrollRef}
              onApply={(next) => {
                setCropping(false);
                // A box that is too small (a single click, a shaky hand) counts as a cancel and keeps the previous range.
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



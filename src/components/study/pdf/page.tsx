import { memo, useEffect, useRef, useState } from "react";
import { TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { type PdfCrop } from "@/study/crop";
import type { PdfTool } from "./types";
import { spanRects } from "./geometry";
import { annotationAt, EMPTY_PDF_ANNOTATIONS, lineRectsAtPoint, mergeLineRects, normalizeRects, type PdfAnnotation, type NormRect } from "@/study/pdfAnnotations";

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

/** Maximum width of the canvas backing store (physical pixels). A bigger page only lowers the DPR, it does not grow the memory proportionally. */
const MAX_CANVAS_WIDTH = 3200;

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  /** CSS width of the page (already zoomed). */
  width: number;
  /** Free-standing estimate used until the page itself is measured. */
  ratio: number;
  /** The displayed range (ratios); null = the whole page. */
  crop: PdfCrop | null;
  active: boolean;
  eyeCare: boolean;
  /** The current annotation tool; null = plain reading, the page does not take the clicks. */
  tool: PdfTool | null;
  /** The selection translation switch; while tool is not null the parent does not attach the translation handler. */
  translateEnabled: boolean;
  annotations: PdfAnnotation[] | undefined;
  onAddHighlight: (page: number, rects: NormRect[]) => void;
  onRemoveAnnotation: (id: string) => void;
  onTranslateSelection: (text: string, x: number, y: number) => void;
  register: (n: number, el: HTMLDivElement | null) => void;
}

export const PdfPage = memo(function PdfPage({
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
  // After a crop the page only occupies this block: the whole page is still inside it and a negative offset pushes the part outside the box out of the crop window.
  const shownWidth = crop ? Math.max(1, Math.round(width * crop.w)) : width;
  const shownHeight = crop ? Math.max(1, Math.round(height * crop.h)) : height;
  const offsetX = crop ? Math.round(width * crop.x) : 0;
  const offsetY = crop ? Math.round(height * crop.y) : 0;
  const pageAnnotations = annotations ?? EMPTY_PDF_ANNOTATIONS;

  /**
   * The selection translation in plain reading mode. It is only mounted
   * while tool is null (see onMouseUp below); as soon as an annotation tool
   * is selected this handler is not even attached, the two gestures do not
   * share any state.
   *
   * The selection is read in a macro task (only after the default action of
   * the mouseup is the selection final); the start and the end node must
   * both lie inside the .textLayer of pdf.js, which excludes selections in
   * the annotation gutter on the right and other non-body text.
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
   * The mouse landing points of the annotation mode:
   *  - drag selection / double click -> the selection rectangle (split by
   *    line and merged): the highlight mode marks it yellow, the text mode
   *    marks it blue and moves the caret into the gutter on the right once
   *    the card was created;
   *  - a single click in the highlight mode -> it removes an existing
   *    highlight that was clicked, otherwise it takes the line the caret is
   *    on;
   *  - a single click in the text mode -> clicking a blue annotation focuses
   *    its input field instead of creating a new one.
   * The selection is read in a macro task: only after the default action of
   * the mouseup is the selection in its final state.
   */
  function handleMouseUp(event: React.MouseEvent<HTMLDivElement>) {
    // Only the left button counts: the right button switches the annotation
    // tool, and treating its mouseup as "the end of a drag selection" would
    // create an annotation from the selection the right button happened to
    // move out (or remove the highlight that was clicked).
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
        onAddHighlight(pageNumber, rects);
        window.getSelection()?.removeAllRanges();
        return;
      }
      const x = (clientX - pageRect.left) / pageRect.width;
      const y = (clientY - pageRect.top) / pageRect.height;
      const hit = annotationAt(pageAnnotations, pageNumber, x, y);
      if (hit) {
        if (hit.kind === "highlight") onRemoveAnnotation(hit.id);
        return;
      }
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
                className="pdf-anno-mark"
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

/** The part of the selection that falls on this page (normalized rectangles). A drag selection across pages only takes the piece of this page. */
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


/**
 * The text lines at the boundary: only the spans of the text layer of the current page that intersect the boundary are measured. When the boundary falls into a page gap or the margin there is no intersecting line and an empty array is returned (the original landing spot is kept).
 */

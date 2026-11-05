import { type PageMetric } from "@/study/readPositions";
import { snapScrollTopToLine } from "@/study/reading";
import type { BoxLike } from "@/study/pdfAnnotations";


// ---------------------------------------------------------------------------
// Crop selection
// ---------------------------------------------------------------------------

/** The position of every page inside the scroll content; one batched layout read, called when the scrolling stopped or when landing. */
export function pageMetrics(
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

export function clampPx(value: number, size: number): number {
  return Math.min(size, Math.max(0, value));
}

/** The client rectangles of all spans of the text layer; used to take the line of a single click. */
export function spanRects(textDiv: HTMLElement): BoxLike[] {
  const out: BoxLike[] = [];
  for (const span of textDiv.querySelectorAll("span")) {
    for (const r of span.getClientRects()) {
      if (r.width <= 0.5 || r.height <= 0.5) continue;
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return out;
}

/** The text lines at the boundary: only the spans of the text layer of the current page that intersect the boundary are measured. When the boundary falls into a page gap or the margin there is no intersecting line and an empty array is returned (the original landing spot is kept). */
export function lineBandsAtY(
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

/** Measures the text lines at the real DOM position of the boundary and computes the fine tuned landing spot. */
export function snapFlipToLine(scroll: HTMLElement, nominal: number, step: number): number {
  const wrap = scroll.parentElement;
  const guide = wrap?.querySelector<HTMLElement>(".pdf-read-guide") ?? null;
  const height = (guide ?? scroll).clientHeight;
  const top = (guide ?? scroll).getBoundingClientRect().top;
  // The rounding matches --read-old: the end of the shadow and the measured boundary are the same line.
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
// Outline tree
// ---------------------------------------------------------------------------

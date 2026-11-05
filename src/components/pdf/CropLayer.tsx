import { useEffect, useRef, useState } from "react";
import { cropFromDrag, type PdfCrop } from "@/study/crop";
import { clampPx } from "./geometry";

interface CropLayerProps {
  pageEls: React.RefObject<Map<number, HTMLDivElement>>;
  /** The crop layer covers the scroll container, so the wheel events are handed over to it here, otherwise the pages cannot be turned while cropping. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The result is given as page ratios only; a single click or a shaky hand yields null (the caller treats it as a cancel). */
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
 * The crop layer: it covers the PDF viewport and drags out a rectangle
 * inside one page.
 *
 * The coordinates are always computed fresh (`getBoundingClientRect`), a
 * cached layout is not used: the page does not scroll during the drag, but
 * the column width or the zoom may change at that very moment and a cached
 * rectangle would frame the wrong spot. The rectangle is a ratio relative to
 * the page, so the same area is applied to every page unchanged.
 */
export function CropLayer({ pageEls, scrollRef, onApply, onCancel }: CropLayerProps) {
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
    // setPointerCapture throws for a synthetic event or without an active pointer (same as the drag in StudyLayout).
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A failed capture does not affect the drag: move/up still bubble up from the element.
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
        // The page rectangle is cached during the drag, a scroll would put the box in the wrong spot, so the scroll is only let through while no drag is running.
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

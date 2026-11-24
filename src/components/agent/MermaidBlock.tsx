import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { MermaidConfig } from "mermaid";
import {
  ZOOM_STEP,
  parseViewBox,
  zoomAround,
  zoomBy as zoomView,
  type DiagramView,
} from "./mermaidView";

/** Render ids must be unique per mounted diagram, including across remounts. */
let renderSeq = 0;

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** Dark is the default; light is the [data-theme="light"] override (see agent-messages.css). */
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

interface Tint {
  fill: string;
  stroke: string;
}

interface DiagramPalette {
  /** Nodes rotate through nth-of-type so one diagram is not uniformly gray. */
  nodes: Tint[];
  /** Subgraph areas are large; they only get a faint same-family tint. */
  clusters: Tint[];
  /** Pie-class diagrams color by data category. */
  pies: string[];
}

const DARK_PALETTE: DiagramPalette = {
  nodes: [
    { fill: "#2a2415", stroke: "#6f5b2c" },
    { fill: "#152b27", stroke: "#2f6156" },
    { fill: "#1a2434", stroke: "#365378" },
    { fill: "#251e32", stroke: "#513e6d" },
    { fill: "#2c1d25", stroke: "#6b3b4d" },
    { fill: "#232a1a", stroke: "#4e6132" },
    { fill: "#1b242b", stroke: "#3d5367" },
    { fill: "#2c211b", stroke: "#6b4732" },
  ],
  clusters: [
    { fill: "rgba(233, 201, 110, 0.055)", stroke: "rgba(233, 201, 110, 0.20)" },
    { fill: "rgba(76, 211, 154, 0.05)", stroke: "rgba(76, 211, 154, 0.18)" },
    { fill: "rgba(127, 168, 255, 0.055)", stroke: "rgba(127, 168, 255, 0.20)" },
    { fill: "rgba(192, 140, 245, 0.055)", stroke: "rgba(192, 140, 245, 0.20)" },
    { fill: "rgba(255, 138, 157, 0.05)", stroke: "rgba(255, 138, 157, 0.18)" },
    { fill: "rgba(185, 207, 107, 0.05)", stroke: "rgba(185, 207, 107, 0.18)" },
    { fill: "rgba(143, 182, 207, 0.05)", stroke: "rgba(143, 182, 207, 0.18)" },
    { fill: "rgba(240, 164, 92, 0.055)", stroke: "rgba(240, 164, 92, 0.20)" },
  ],
  pies: ["#d9b45c", "#3fae82", "#6f93d8", "#a678d8", "#d96a7f", "#93a94f", "#6c92a8", "#c9834f"],
};

const LIGHT_PALETTE: DiagramPalette = {
  nodes: [
    { fill: "#f9edc9", stroke: "#c9a54a" },
    { fill: "#e4f2ec", stroke: "#6fae95" },
    { fill: "#e7eefb", stroke: "#7d9fd6" },
    { fill: "#f0eafb", stroke: "#a68bd0" },
    { fill: "#fbe9ee", stroke: "#d4899e" },
    { fill: "#edf3e0", stroke: "#93ac6a" },
    { fill: "#e9eff3", stroke: "#8aa3b3" },
    { fill: "#faece2", stroke: "#cd9976" },
  ],
  clusters: [
    { fill: "#fcf8ea", stroke: "#e3d3a5" },
    { fill: "#f1f9f5", stroke: "#c2e0d5" },
    { fill: "#f2f7fd", stroke: "#c8d9ef" },
    { fill: "#f7f3fc", stroke: "#ddcff0" },
    { fill: "#fdf4f6", stroke: "#efcbd4" },
    { fill: "#f6f9ef", stroke: "#d5e0c0" },
    { fill: "#f4f7f9", stroke: "#cfdbe3" },
    { fill: "#fdf7f1", stroke: "#ecd6c4" },
  ],
  pies: ["#c9a54a", "#3f8f72", "#4f74b8", "#8a63bd", "#b85a70", "#748c3b", "#517b92", "#b07445"],
};

/**
 * The styles injected into the SVG. Mermaid's node rules carry an #svg-id
 * prefix, so !important overrides the fill; the neo-look drop shadow is
 * switched off to keep the flat card hierarchy used everywhere in the app.
 */
function buildPaletteCss(palette: DiagramPalette): string {
  const shapeTags = ["rect", "polygon", "circle", "ellipse", "path"];
  const rules: string[] = [];

  palette.nodes.forEach((tint, index) => {
    const selectors = shapeTags
      .map((tag) => `.node:nth-of-type(${palette.nodes.length}n+${index + 1}) > ${tag}`)
      .join(",");
    rules.push(`${selectors}{fill:${tint.fill}!important;stroke:${tint.stroke}!important;}`);
  });

  palette.clusters.forEach((tint, index) => {
    rules.push(
      `.cluster:nth-of-type(${palette.clusters.length}n+${index + 1}) > rect{fill:${tint.fill}!important;stroke:${tint.stroke}!important;}`,
    );
  });

  rules.push(
    ".node rect,.node polygon,.node circle,.node ellipse,.node path,.cluster rect{filter:none!important;stroke-width:1px!important;}",
    ".cluster-label span p{background:transparent!important;}",
  );

  return rules.join("\n");
}

/**
 * Maps the app theme onto Mermaid's variables. securityLevel=strict sanitizes
 * label content; maxTextSize/maxEdges keep a hostile giant diagram from
 * blocking the render.
 */
function buildConfig(theme: "light" | "dark", fontSize: number): MermaidConfig {
  const styles = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => readVar(styles, name, fallback);
  const fg = v("--text", theme === "light" ? "#23262b" : "#d8d8da");
  const raised = v("--bg2", theme === "light" ? "#ffffff" : "#17171a");
  const surface = v("--bg1", theme === "light" ? "#f7f7f8" : "#101013");
  const panel = v("--bg1", theme === "light" ? "#f7f7f8" : "#101013");
  const hover = v("--bg3", theme === "light" ? "#ececee" : "#212125");
  const code = v("--code-block-bg", theme === "light" ? "#f6f8fa" : "#1a1a1f");
  const line = v("--border", theme === "light" ? "#e3e3e7" : "#27272c");
  // Between --border and --text-dim in both themes: node outlines read as
  // structure without turning into the brightest line in the column.
  const lineStrong = "color-mix(in srgb, var(--border) 45%, var(--text-dim))";
  const muted = v("--text-dim", theme === "light" ? "#6c7078" : "#9a9aa0");
  const accent = v("--accent", "#f5a83c");
  const accentSoft = "color-mix(in srgb, var(--accent) 16%, transparent)";
  const warnSoft = "color-mix(in srgb, var(--h4-color) 14%, transparent)";
  const warnLine = v("--h4-color", theme === "light" ? "#9a6b12" : "#e5b567");
  const warnText = warnLine;
  const palette = theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const pies = Object.fromEntries(palette.pies.map((color, index) => [`pie${index + 1}`, color]));
  const fontFamily = v(
    "--font-ui",
    "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
  );

  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: 50000,
    maxEdges: 500,
    theme: "base",
    themeCSS: buildPaletteCss(palette),
    themeVariables: {
      fontFamily,
      fontSize: `${fontSize}px`,
      background: surface,
      primaryColor: raised,
      primaryTextColor: fg,
      primaryBorderColor: lineStrong,
      secondaryColor: hover,
      secondaryTextColor: fg,
      secondaryBorderColor: lineStrong,
      tertiaryColor: code,
      tertiaryTextColor: fg,
      tertiaryBorderColor: line,
      lineColor: muted,
      textColor: fg,
      mainBkg: raised,
      nodeBorder: lineStrong,
      clusterBkg: panel,
      clusterBorder: line,
      edgeLabelBackground: surface,
      // sequenceDiagram
      actorBkg: raised,
      actorBorder: lineStrong,
      actorTextColor: fg,
      actorLineColor: muted,
      signalColor: muted,
      signalTextColor: fg,
      labelBoxBkgColor: raised,
      labelBoxBorderColor: lineStrong,
      labelTextColor: fg,
      loopTextColor: fg,
      noteBkgColor: warnSoft,
      noteTextColor: warnText,
      noteBorderColor: warnLine,
      activationBkgColor: accentSoft,
      activationBorderColor: accent,
      sequenceNumberColor: surface,
      // stateDiagram / classDiagram
      labelBackgroundColor: surface,
      compositeBackground: panel,
      compositeBorder: line,
      compositeTitleBackground: raised,
      ...pies,
    },
    flowchart: { htmlLabels: false, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    class: { useMaxWidth: true },
    state: { useMaxWidth: true },
    er: { useMaxWidth: true },
    pie: { useMaxWidth: true },
  };
}

/** The reply body's font size, so the diagram text matches the prose. */
function measureFontSize(host: Element | null): number {
  if (!host) return 14;
  const size = parseFloat(getComputedStyle(host).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 14;
}

interface MermaidBlockProps {
  code: string;
}

/**
 * One ```mermaid fence of an agent reply.
 *
 * The parser only emits this block for a **closed** top-level fence, so the
 * source is complete: an open fence keeps rendering as a code block while the
 * reply streams. Rendering is memoized on `code`, so a streaming reply does
 * not re-parse the diagram on every token. A parse failure falls back to the
 * source with the reason, and never breaks the surrounding message.
 *
 * Click opens a viewer with wheel zoom, drag pan and Esc close.
 */
export const MermaidBlock = memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  /** Bumped when the panel's --agent-fs changes, so the diagram font is re-measured. */
  const [fontRevision, setFontRevision] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<DiagramView>({ scale: 1, x: 0, y: 0 });
  const figureRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const diagramSize = useMemo(() => parseViewBox(svg), [svg]);

  const openViewer = () => {
    if (!svg) return;
    setView({ scale: 1, x: 0, y: 0 });
    setExpanded(true);
  };

  const resetView = () => setView({ scale: 1, x: 0, y: 0 });

  const zoomBy = (factor: number) => setView((prev) => zoomView(prev, factor));

  // Wheel zoom anchored on the pointer. This must be a non-passive listener:
  // React's onWheel cannot prevent the page from scrolling.
  useEffect(() => {
    if (!expanded) return;
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pointerX = event.clientX - rect.left - rect.width / 2;
      const pointerY = event.clientY - rect.top - rect.height / 2;
      const delta = Math.min(120, Math.max(-120, event.deltaY));
      const factor = Math.exp(-delta * 0.0015);
      setView((prev) => zoomAround(prev, factor, pointerX, pointerY));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [expanded]);

  // The viewer locks page scroll, takes focus and closes on Esc.
  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      dragRef.current = null;
    };
  }, [expanded]);

  // The theme is the data-theme attribute on the root; the conversation font
  // scale is the --agent-fs inline style on the nearest .agent-panel. Both
  // re-render the diagram with the matching colors and font size.
  useEffect(() => {
    const root = document.documentElement;
    const panel = figureRef.current?.closest(".agent-panel") ?? null;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target === root && record.attributeName === "data-theme") {
          setTheme(currentTheme());
        } else if (record.attributeName === "style") {
          setFontRevision((revision) => revision + 1);
        }
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const fontSize = measureFontSize(figureRef.current?.closest(".agent-md") ?? null);
    const id = `bnote-mermaid-${(renderSeq += 1)}`;
    let cancelled = false;
    setLoading(true);
    setError("");

    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (cancelled) return;
        mermaid.initialize(buildConfig(theme, fontSize));
        const result = await mermaid.render(id, code);
        if (cancelled) return;
        setSvg(result.svg);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, theme, fontRevision]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    // Pointer capture can fail on synthetic events; the drag state is already
    // recorded, and event bubbling still drives the gesture.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a convenience here; the drag works without it.
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((prev) => ({
      ...prev,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (error) {
    return (
      <div className="agent-mermaid-error" data-testid="mermaid-error">
        <p className="agent-mermaid-error-head">Mermaid 渲染失败：{error.split("\n")[0]}</p>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <figure
      ref={figureRef}
      data-testid="mermaid"
      role={svg ? "button" : undefined}
      tabIndex={svg ? 0 : undefined}
      aria-label={svg ? "放大 Mermaid 图表" : "Mermaid 图表"}
      onClick={svg ? openViewer : undefined}
      onKeyDown={
        svg
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openViewer();
              }
            }
          : undefined
      }
      className={svg ? "agent-mermaid is-zoomable" : "agent-mermaid"}
    >
      {svg ? (
        <div
          className="agent-mermaid-canvas"
          data-testid="mermaid-canvas"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="agent-mermaid-note">{loading ? "正在渲染图表…" : ""}</p>
      )}

      {expanded &&
        svg &&
        createPortal(
          <div
            data-testid="mermaid-fullscreen"
            role="dialog"
            aria-modal="true"
            aria-label="Mermaid 图表全屏预览"
            className="agent-mermaid-viewer"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="agent-mermaid-viewer-bar">
              <div className="agent-mermaid-viewer-title">
                <span aria-hidden="true">◇</span>
                <span>Mermaid 图表</span>
              </div>
              <div className="agent-mermaid-viewer-tools">
                <span className="agent-mermaid-viewer-hint">
                  滚轮缩放 · 拖动平移 · 双击复位 · Esc 关闭
                </span>
                <div className="agent-mermaid-zoom">
                  <button
                    type="button"
                    aria-label="缩小图表"
                    title="缩小"
                    onClick={() => zoomBy(1 / ZOOM_STEP)}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    data-testid="mermaid-zoom"
                    aria-label="重置缩放"
                    title="重置缩放"
                    className="agent-mermaid-zoom-value"
                    onClick={resetView}
                  >
                    {Math.round(view.scale * 100)}%
                  </button>
                  <button
                    type="button"
                    aria-label="放大图表"
                    title="放大"
                    onClick={() => zoomBy(ZOOM_STEP)}
                  >
                    +
                  </button>
                </div>
                <button
                  ref={closeRef}
                  type="button"
                  data-testid="mermaid-close"
                  aria-label="关闭图表预览"
                  className="agent-mermaid-close"
                  onClick={() => setExpanded(false)}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            <div
              ref={viewportRef}
              data-testid="mermaid-viewport"
              data-scale={view.scale.toFixed(2)}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              onDoubleClick={resetView}
              className="agent-mermaid-viewport"
            >
              <div
                className="agent-mermaid-stage"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              >
                <div
                  className={
                    diagramSize ? "agent-mermaid-stage-svg" : "agent-mermaid-stage-svg is-fill"
                  }
                  style={
                    diagramSize
                      ? { width: diagramSize.width, height: diagramSize.height }
                      : undefined
                  }
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </figure>
  );
});

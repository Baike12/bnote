import { describe, expect, it } from "vitest";
import {
  annotationAt,
  lineRectsAtPoint,
  mergeLineRects,
  normalizeRects,
  parsePdfAnnotationFile,
  pdfAnnotationPath,
  pdfAnnotationRelPath,
  pdfAnnotationMaterialPath,
  type PdfAnnotation,
} from "./pdfAnnotations";

const page = { left: 0, top: 0, right: 1000, bottom: 1000 };

function rect(x: number, y: number, w: number, h: number) {
  return { x, y, w, h };
}

function ann(
  id: string,
  pageNumber: number,
  r: ReturnType<typeof rect>,
  extra: Partial<PdfAnnotation> = {},
): PdfAnnotation {
  return {
    id,
    page: pageNumber,
    rects: [r],
    kind: "highlight",
    text: "",
    createdAt: 1,
    ...extra,
  };
}

describe("PDF annotation geometry", () => {
  it("a client-area rectangle is normalized to the full-page ratio and the out-of-page part is cut off", () => {
    const out = normalizeRects(
      [
        { left: 100, top: 200, right: 600, bottom: 230 },
        { left: -50, top: 990, right: 120, bottom: 1040 },
      ],
      page,
    );
    expect(out).toEqual([
      rect(0.1, 0.2, 0.5, 0.03),
      rect(0, 0.99, 0.12, 0.01),
    ]);
  });

  it("a degenerate or off-page rectangle produces no highlight", () => {
    expect(
      normalizeRects([{ left: 1100, top: 0, right: 1200, bottom: 20 }], page),
    ).toEqual([]);
    expect(
      normalizeRects([{ left: 0, top: 0, right: 0.2, bottom: 20 }], page),
    ).toEqual([]);
  });

  it("adjacent runs on the same line merge into one, runs in different columns do not merge", () => {
    const merged = mergeLineRects([
      rect(0.1, 0.2, 0.1, 0.02),
      rect(0.205, 0.2, 0.1, 0.02),
      rect(0.6, 0.2, 0.1, 0.02),
    ]);
    expect(merged).toEqual([rect(0.1, 0.2, 0.205, 0.02), rect(0.6, 0.2, 0.1, 0.02)]);
  });

  it("runs on different lines do not merge", () => {
    const merged = mergeLineRects([
      rect(0.1, 0.2, 0.3, 0.02),
      rect(0.1, 0.23, 0.3, 0.02),
    ]);
    expect(merged).toEqual([rect(0.1, 0.2, 0.3, 0.02), rect(0.1, 0.23, 0.3, 0.02)]);
  });

  it("the function can be serialized on its own (the web annotation runtime injects it through toString, it must not reference module symbols)", () => {
    const standalone = new Function(`return (${mergeLineRects.toString()});`)() as typeof mergeLineRects;
    expect(
      standalone([rect(0.1, 0.2, 0.1, 0.02), rect(0.205, 0.2, 0.1, 0.02)], 0.02),
    ).toEqual([rect(0.1, 0.2, 0.205, 0.02)]);
  });

  it("hitting an annotation: the later one is on top, with a little tolerance", () => {
    const annotations: PdfAnnotation[] = [
      ann("a", 1, rect(0.1, 0.1, 0.2, 0.05), { createdAt: 1 }),
      ann("b", 1, rect(0.12, 0.1, 0.2, 0.05), { createdAt: 2 }),
    ];
    expect(annotationAt(annotations, 1, 0.15, 0.12)?.id).toBe("b");
    expect(annotationAt(annotations, 2, 0.15, 0.12)).toBeNull();
    expect(annotationAt(annotations, 1, 0.105, 0.12)?.id).toBe("a");
  });
});

describe("a single click takes a line", () => {
  // Two columns, two lines: clicking the first line of the left column must only highlight that run.
  const boxes = [
    { left: 100, top: 100, right: 400, bottom: 120 }, // first line of the left column
    { left: 402, top: 100, right: 460, bottom: 120 }, // the run right next to it on the same line
    { left: 600, top: 100, right: 900, bottom: 120 }, // right column
    { left: 100, top: 122, right: 400, bottom: 142 }, // second line of the left column
  ];
  const pageRect = { left: 0, top: 0, right: 1000, bottom: 500 };

  it("the click takes the whole line of the same run and does not cross columns", () => {
    const rects = lineRectsAtPoint(boxes, pageRect, 200, 110, 0.02);
    expect(rects).toEqual([rect(0.1, 0.2, 0.36, 0.04)]);
  });

  it("clicking the right column highlights only the right column", () => {
    const rects = lineRectsAtPoint(boxes, pageRect, 700, 110, 0.02);
    expect(rects).toEqual([rect(0.6, 0.2, 0.3, 0.04)]);
  });

  it("a click in the gap between lines takes the nearest line", () => {
    const rects = lineRectsAtPoint(boxes, pageRect, 200, 121, 0.02);
    expect(rects.length).toBe(1);
    expect(rects[0].y).toBeCloseTo(0.2, 5);
  });

  it("a click on blank space produces no highlight", () => {
    expect(lineRectsAtPoint(boxes, pageRect, 500, 300, 0.02)).toEqual([]);
  });
});

describe("PDF annotation storage", () => {
  it("one file per PDF: the directory structure mirrors the vault", () => {
    expect(pdfAnnotationRelPath("pdfs/a.pdf")).toBe("pdf-annotations/pdfs/a.pdf.json");
    expect(pdfAnnotationPath("/vault", "papers/deep/a.pdf")).toBe(
      "/vault/.bnote/pdf-annotations/papers/deep/a.pdf.json",
    );
    // Out-of-bounds segments are dropped and never escape .bnote.
    expect(pdfAnnotationRelPath("../../etc/passwd")).toBe(
      "pdf-annotations/etc/passwd.json",
    );
  });

  it("annotations under a materials directory land in <vault>/.bnote/materials/<kind>/<dir>/annotations.json", () => {
    expect(pdfAnnotationMaterialPath("/vault", "materials/pdfs/ji_qi_xue_xi")).toBe(
      "/vault/.bnote/materials/pdfs/ji_qi_xue_xi/annotations.json",
    );
  });

  it("a bad file falls back to an empty library; old data (without kind) is read as a highlight", () => {
    expect(parsePdfAnnotationFile("not json").annotations).toEqual([]);
    expect(parsePdfAnnotationFile(null).annotations).toEqual([]);
    const good = parsePdfAnnotationFile(
      JSON.stringify({
        version: 1,
        annotations: [
          { id: "x", page: 2, rects: [rect(0.1, 0.2, 0.3, 0.01)], createdAt: 5 },
          {
            id: "y",
            page: 3,
            rects: [rect(0.2, 0.2, 0.3, 0.01)],
            kind: "note",
            text: "想法",
            createdAt: 6,
          },
          { id: "bad", page: "2", rects: [] },
        ],
      }),
    ).annotations;
    expect(good.map((a) => a.id)).toEqual(["x", "y"]);
    expect(good[0].kind).toBe("highlight");
    expect(good[0].text).toBe("");
    expect(good[1].kind).toBe("note");
    expect(good[1].text).toBe("想法");
  });
});

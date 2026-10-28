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

describe("PDF 批注几何", () => {
  it("客户区矩形归一化到整页比例,越界部分裁掉", () => {
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

  it("退化/页外矩形不产生高亮", () => {
    expect(
      normalizeRects([{ left: 1100, top: 0, right: 1200, bottom: 20 }], page),
    ).toEqual([]);
    expect(
      normalizeRects([{ left: 0, top: 0, right: 0.2, bottom: 20 }], page),
    ).toEqual([]);
  });

  it("同一行的相邻段合并成一条,两栏之间不合并", () => {
    const merged = mergeLineRects([
      rect(0.1, 0.2, 0.1, 0.02),
      rect(0.205, 0.2, 0.1, 0.02),
      rect(0.6, 0.2, 0.1, 0.02),
    ]);
    expect(merged).toEqual([rect(0.1, 0.2, 0.205, 0.02), rect(0.6, 0.2, 0.1, 0.02)]);
  });

  it("不同行不合并", () => {
    const merged = mergeLineRects([
      rect(0.1, 0.2, 0.3, 0.02),
      rect(0.1, 0.23, 0.3, 0.02),
    ]);
    expect(merged).toEqual([rect(0.1, 0.2, 0.3, 0.02), rect(0.1, 0.23, 0.3, 0.02)]);
  });

  it("函数可独立序列化(网页批注运行时靠 toString 注入,不能引用模块内符号)", () => {
    const standalone = new Function(`return (${mergeLineRects.toString()});`)() as typeof mergeLineRects;
    expect(
      standalone([rect(0.1, 0.2, 0.1, 0.02), rect(0.205, 0.2, 0.1, 0.02)], 0.02),
    ).toEqual([rect(0.1, 0.2, 0.205, 0.02)]);
  });

  it("点中批注:后加的在上层,带一点容差", () => {
    const annotations: PdfAnnotation[] = [
      ann("a", 1, rect(0.1, 0.1, 0.2, 0.05), { createdAt: 1 }),
      ann("b", 1, rect(0.12, 0.1, 0.2, 0.05), { createdAt: 2 }),
    ];
    expect(annotationAt(annotations, 1, 0.15, 0.12)?.id).toBe("b");
    expect(annotationAt(annotations, 2, 0.15, 0.12)).toBeNull();
    expect(annotationAt(annotations, 1, 0.105, 0.12)?.id).toBe("a");
  });
});

describe("单击取行", () => {
  // 两栏、两行:点击左栏第一行只应高亮左栏那一段。
  const boxes = [
    { left: 100, top: 100, right: 400, bottom: 120 }, // 左栏第一行
    { left: 402, top: 100, right: 460, bottom: 120 }, // 同行紧邻的一段
    { left: 600, top: 100, right: 900, bottom: 120 }, // 右栏
    { left: 100, top: 122, right: 400, bottom: 142 }, // 左栏第二行
  ];
  const pageRect = { left: 0, top: 0, right: 1000, bottom: 500 };

  it("点击处取同一段的整行,不跨栏", () => {
    const rects = lineRectsAtPoint(boxes, pageRect, 200, 110, 0.02);
    expect(rects).toEqual([rect(0.1, 0.2, 0.36, 0.04)]);
  });

  it("点击右栏只高亮右栏", () => {
    const rects = lineRectsAtPoint(boxes, pageRect, 700, 110, 0.02);
    expect(rects).toEqual([rect(0.6, 0.2, 0.3, 0.04)]);
  });

  it("点在行间空隙时取最近的一行", () => {
    const rects = lineRectsAtPoint(boxes, pageRect, 200, 121, 0.02);
    expect(rects.length).toBe(1);
    expect(rects[0].y).toBeCloseTo(0.2, 5);
  });

  it("点在空白处不产生高亮", () => {
    expect(lineRectsAtPoint(boxes, pageRect, 500, 300, 0.02)).toEqual([]);
  });
});

describe("PDF 批注存储", () => {
  it("一份 PDF 一个文件:目录结构镜像仓库", () => {
    expect(pdfAnnotationRelPath("pdfs/a.pdf")).toBe("pdf-annotations/pdfs/a.pdf.json");
    expect(pdfAnnotationPath("/vault", "papers/deep/a.pdf")).toBe(
      "/vault/.bnote/pdf-annotations/papers/deep/a.pdf.json",
    );
    // 越界片段被丢掉,不会逃出 .bnote。
    expect(pdfAnnotationRelPath("../../etc/passwd")).toBe(
      "pdf-annotations/etc/passwd.json",
    );
  });

  it("材料目录下的批注落在 <vault>/.bnote/materials/<kind>/<dir>/annotations.json", () => {
    expect(pdfAnnotationMaterialPath("/vault", "materials/pdfs/ji_qi_xue_xi")).toBe(
      "/vault/.bnote/materials/pdfs/ji_qi_xue_xi/annotations.json",
    );
  });

  it("坏文件退回空库;旧数据(无 kind)按高亮读", () => {
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

import { describe, expect, it } from "vitest";
import { compressToBase64 } from "lz-string";
import {
  DRAWING_FOLDER,
  drawingPngName,
  drawingStem,
  emptySceneJson,
  isDrawingFileName,
  newDrawingFileName,
  parseDrawingFile,
  serializeDrawingFile,
  serializeSceneJson,
  type DrawingScene,
} from "./excalidrawFile";

/**
 * The drawing format layer is shared with Obsidian's Excalidraw plugin:
 * `.excalidraw` is plain JSON, `.excalidraw.md` keeps frontmatter and a
 * `json`/`compressed-json` block. A regression here silently destroys a
 * user's existing drawings on the next save.
 */

const scene: DrawingScene = {
  elements: [{ id: "rect-1", type: "rectangle" }],
  appState: { viewBackgroundColor: "#fff", gridSize: 20, other: "dropped" },
  files: { "file-1": { mimeType: "image/png" } },
};

function mdFile(
  json: string,
  frontmatter = "---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---",
) {
  return `${frontmatter}\n\n# Excalidraw Data\n\n## Drawing\n\`\`\`${json.startsWith("{") ? "json" : "compressed-json"}\n${json}\n\`\`\`\n%%\n`;
}

describe("file names", () => {
  it("recognizes both formats case-insensitively", () => {
    expect(isDrawingFileName("a.excalidraw")).toBe(true);
    expect(isDrawingFileName("a.EXCALIDRAW.MD")).toBe(true);
    expect(isDrawingFileName("a.md")).toBe(false);
  });

  it("strips only the drawing suffix", () => {
    expect(drawingStem("草图.excalidraw")).toBe("草图");
    expect(drawingStem("草图.excalidraw.md")).toBe("草图");
    expect(drawingStem("草图.md")).toBe("草图.md");
    expect(drawingPngName("草图.excalidraw.md")).toBe("草图.png");
  });

  it("names a new drawing from the supplied clock", () => {
    const name = newDrawingFileName(new Date(2026, 8, 20, 20, 47, 6));
    expect(name).toBe("画图 2026-09-20 20.47.06.excalidraw");
    expect(DRAWING_FOLDER).toBe("Excalidraw");
  });
});

describe("serialization", () => {
  it("writes the upstream shape and drops unknown appState fields", () => {
    const json = serializeSceneJson(scene);
    expect(JSON.parse(json)).toEqual({
      type: "excalidraw",
      version: 2,
      source: "bnote",
      elements: scene.elements,
      appState: { viewBackgroundColor: "#fff", gridSize: 20 },
      files: scene.files,
    });
  });

  it("emptySceneJson is a valid empty scene", () => {
    expect(JSON.parse(emptySceneJson())).toMatchObject({
      type: "excalidraw",
      elements: [],
      files: {},
    });
  });

  it("plain files are the JSON document itself", () => {
    expect(serializeDrawingFile(scene, "a.excalidraw", null)).toBe(serializeSceneJson(scene));
  });

  it("markdown files keep the wrapper frontmatter and write plain json", () => {
    const text = serializeDrawingFile(scene, "a.excalidraw.md", "---\ncustom: yes\n---");
    expect(text.startsWith("---\ncustom: yes\n---")).toBe(true);
    expect(text).toContain("# Excalidraw Data");
    expect(text).toContain("```json");
    expect(text).toContain(serializeSceneJson(scene));
    expect(text).not.toContain("compressed-json");
  });

  it("refuses a non-drawing file name", () => {
    expect(() => serializeDrawingFile(scene, "a.md", null)).toThrow("不是画图文件");
  });
});

describe("parsing", () => {
  it("reads plain JSON", () => {
    const parsed = parseDrawingFile(serializeSceneJson(scene), "a.excalidraw");
    expect(parsed.mdWrapper).toBeNull();
    expect(parsed.scene).toEqual({
      elements: scene.elements,
      appState: { viewBackgroundColor: "#fff", gridSize: 20 },
      files: scene.files,
    });
  });

  it("reads an Obsidian markdown wrapper and returns its frontmatter verbatim", () => {
    const frontmatter = "---\nexcalidraw-plugin: parsed\ntags: [x]\n---";
    const parsed = parseDrawingFile(
      mdFile(serializeSceneJson(scene), frontmatter),
      "a.excalidraw.md",
    );
    expect(parsed.mdWrapper).toBe(frontmatter);
    expect(parsed.scene.elements).toEqual(scene.elements);
  });

  it("reads the compressed-json block", () => {
    const compressed = compressToBase64(serializeSceneJson(scene));
    const parsed = parseDrawingFile(mdFile(compressed), "a.excalidraw.md");
    expect(parsed.scene.elements).toEqual(scene.elements);
  });

  it("round-trips an md drawing without losing its wrapper", () => {
    const frontmatter = "---\nexcalidraw-plugin: parsed\ncustom: keep\n---";
    const parsed = parseDrawingFile(
      mdFile(serializeSceneJson(scene), frontmatter),
      "a.excalidraw.md",
    );
    const written = serializeDrawingFile(parsed.scene, "a.excalidraw.md", parsed.mdWrapper);
    expect(written.startsWith(frontmatter)).toBe(true);
    expect(parseDrawingFile(written, "a.excalidraw.md").scene.elements).toEqual(scene.elements);
  });

  it("rejects malformed input with a useful message", () => {
    expect(() => parseDrawingFile("not json", "a.excalidraw")).toThrow("场景数据不是合法 JSON");
    expect(() => parseDrawingFile("{}", "a.excalidraw")).toThrow("缺少 excalidraw 元素");
    expect(() => parseDrawingFile("no wrapper", "a.excalidraw.md")).toThrow(
      "不是有效的 Excalidraw markdown",
    );
    expect(() => parseDrawingFile(mdFile(compressToBase64("not json")), "a.excalidraw.md")).toThrow(
      "场景数据不是合法 JSON",
    );
  });
});

import { describe, expect, it } from "vitest";
import { absoluteInProject, formatBytes, isRasterImage } from "./image";

/**
 * Gate for image classification: which files render as images and how the
 * absolute path is built.
 *
 * A wrong classification sends the file down the wrong channel — a bitmap
 * opened in the editor is treated as empty text (saving wipes the file), and a
 * text image (svg) opened in `<img>` can never be edited as source again.
 */

describe("isRasterImage", () => {
  it("常见位图按图片渲染", () => {
    for (const p of [
      "a.png",
      "docs/b.JPG",
      "x/y/z.jpeg",
      "shot.webp",
      "anim.gif",
      "icon.ico",
      "pic.avif",
      "scan.tiff",
      "IMG_0001.HEIC",
    ]) {
      expect(isRasterImage(p), p).toBe(true);
    }
  });

  it("svg 不算:它是文本,要在编辑器里改", () => {
    expect(isRasterImage("logo.svg")).toBe(false);
  });

  it("没有扩展名 / 其它文本后缀不算", () => {
    expect(isRasterImage("README")).toBe(false);
    expect(isRasterImage("src/main.ts")).toBe(false);
  });

  it("只看最后一段文件名,目录名里的点不参与", () => {
    expect(isRasterImage("v1.2/README.md")).toBe(false);
  });
});

describe("absoluteInProject", () => {
  it("拼出绝对路径,双斜杠收成一个", () => {
    expect(absoluteInProject("/Users/me/proj", "assets/a.png")).toBe(
      "/Users/me/proj/assets/a.png",
    );
    expect(absoluteInProject("/Users/me/proj/", "/assets/a.png")).toBe(
      "/Users/me/proj/assets/a.png",
    );
  });
});

describe("formatBytes", () => {
  it("按 B / KB / MB 给一眼能读懂的大小", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

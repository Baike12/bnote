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
  it("common bitmaps are rendered as images", () => {
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

  it("svg does not count: it is text and has to be edited in the editor", () => {
    expect(isRasterImage("logo.svg")).toBe(false);
  });

  it("no extension or another text suffix does not count", () => {
    expect(isRasterImage("README")).toBe(false);
    expect(isRasterImage("src/main.ts")).toBe(false);
  });

  it("only the last path segment is looked at, dots in directory names do not count", () => {
    expect(isRasterImage("v1.2/README.md")).toBe(false);
  });
});

describe("absoluteInProject", () => {
  it("the absolute path is joined and a double slash collapses into one", () => {
    expect(absoluteInProject("/Users/me/proj", "assets/a.png")).toBe("/Users/me/proj/assets/a.png");
    expect(absoluteInProject("/Users/me/proj/", "/assets/a.png")).toBe(
      "/Users/me/proj/assets/a.png",
    );
  });
});

describe("formatBytes", () => {
  it("the size is formatted as B / KB / MB, readable at a glance", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

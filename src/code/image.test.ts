import { afterEach, describe, expect, it, vi } from "vitest";
import { absoluteInProject, formatBytes, imageSrc, isRasterImage } from "./image";

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

  it("negative or non-finite sizes have no caption instead of a nonsense number", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(NaN)).toBe("");
    expect(formatBytes(Infinity)).toBe("");
  });
});

/**
 * The asset URL is what `<img>` loads; outside Tauri (the pure browser harness)
 * there is no `convertFileSrc`. The module must fall back to an empty string —
 * the pane then shows the load failure — instead of throwing and taking the
 * whole panel down.
 */
describe("imageSrc", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the absolute path to the asset protocol", () => {
    const convertFileSrc = vi.fn((path: string) => `asset://localhost/${path}`);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { convertFileSrc } });
    expect(imageSrc("/proj/", "/img/a.png")).toBe("asset://localhost//proj/img/a.png");
    expect(convertFileSrc).toHaveBeenCalledWith("/proj/img/a.png", "asset");
  });

  it("outside Tauri it returns an empty string instead of throwing", () => {
    expect(imageSrc("/proj", "a.png")).toBe("");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two mutable in-memory structures the storage assertions drive. `vi.hoisted`
 * makes them available inside the `vi.mock` factory, which is hoisted above
 * the imports.
 */
const disk = vi.hoisted(() => {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const reads: string[] = [];
  const api = {
    readFile: async (path: string): Promise<string> => {
      reads.push(path);
      const raw = files.get(path);
      if (raw === undefined) throw new Error(`READ_FAILED: ${path}`);
      return raw;
    },
    writeFile: async (path: string, text: string): Promise<void> => {
      files.set(path, text);
      writes.push(path);
    },
  };
  return { files, writes, reads, api };
});

vi.mock("@/lib/tauri", () => ({ api: disk.api }));

import {
  flushPdfAnnotations,
  loadPdfAnnotations,
  savePdfAnnotations,
  type PdfAnnotation,
} from "./pdfAnnotations";

/**
 * Annotation persistence: one file per material under
 * `<vault>/.bnote/materials/pdfs/<dir>/annotations.json`, and nothing at all
 * without a material directory (no vault, a failed backend call). The write is
 * debounced and `flush` is the leave-the-page guarantee, so both are asserted
 * through the real IPC boundary.
 *
 * The store is a module singleton: each test uses its own material directory so
 * the cache of one cannot answer for another.
 */

function ann(id: string): PdfAnnotation {
  return {
    id,
    page: 1,
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.01 }],
    kind: "highlight",
    text: "",
    createdAt: 1,
  };
}

function fileFor(materialDir: string): string {
  return `/vault/.bnote/${materialDir}/annotations.json`;
}

/** Wait for the store's queued read->write chain to land; no fixed sleeps. */
async function writesLanded(count: number): Promise<void> {
  await vi.waitFor(() => expect(disk.writes).toHaveLength(count));
}

beforeEach(() => {
  disk.files.clear();
  disk.writes.length = 0;
  disk.reads.length = 0;
});

describe("loadPdfAnnotations", () => {
  it("without a material directory it returns an empty list and touches no file", async () => {
    await expect(loadPdfAnnotations("/vault", null)).resolves.toEqual([]);
    expect(disk.reads).toEqual([]);
  });

  it("reads only that material's file", async () => {
    const path = fileFor("materials/pdfs/a");
    disk.files.set(path, JSON.stringify({ version: 1, annotations: [ann("x")] }));

    await expect(loadPdfAnnotations("/vault", "materials/pdfs/a")).resolves.toEqual([ann("x")]);
    expect(disk.reads).toEqual([path]);
  });

  it("a missing or broken file reads as no annotations", async () => {
    disk.files.set(fileFor("materials/pdfs/b"), "{oops");

    await expect(loadPdfAnnotations("/vault", "materials/pdfs/b")).resolves.toEqual([]);
    await expect(loadPdfAnnotations("/vault", "materials/pdfs/none")).resolves.toEqual([]);
  });
});

describe("savePdfAnnotations", () => {
  it("without a material directory it persists nothing", async () => {
    savePdfAnnotations("/vault", [ann("x")], null);
    flushPdfAnnotations();
    await Promise.resolve();

    expect(disk.writes).toEqual([]);
  });

  it("flush writes the file in the material directory with the versioned envelope", async () => {
    savePdfAnnotations("/vault", [ann("x")], "materials/pdfs/c");
    flushPdfAnnotations();
    await writesLanded(1);

    expect(disk.writes).toEqual([fileFor("materials/pdfs/c")]);
    expect(JSON.parse(disk.files.get(disk.writes[0]) ?? "{}")).toEqual({
      version: 1,
      annotations: [ann("x")],
    });
  });

  it("opening a second PDF does not disturb the first file (one cache per material)", async () => {
    savePdfAnnotations("/vault", [ann("a1")], "materials/pdfs/d");
    flushPdfAnnotations();
    await writesLanded(1);
    savePdfAnnotations("/vault", [ann("b1")], "materials/pdfs/e");
    flushPdfAnnotations();
    await writesLanded(2);

    expect(disk.writes).toEqual([fileFor("materials/pdfs/d"), fileFor("materials/pdfs/e")]);
    expect(JSON.parse(disk.files.get(disk.writes[0]) ?? "{}").annotations).toEqual([ann("a1")]);
    expect(JSON.parse(disk.files.get(disk.writes[1]) ?? "{}").annotations).toEqual([ann("b1")]);
  });

  it("the newest save wins: a later write replaces the whole list", async () => {
    savePdfAnnotations("/vault", [ann("old")], "materials/pdfs/f");
    flushPdfAnnotations();
    await writesLanded(1);
    savePdfAnnotations("/vault", [ann("new")], "materials/pdfs/f");
    flushPdfAnnotations();
    await writesLanded(2);

    const last = disk.writes[disk.writes.length - 1];
    expect(JSON.parse(disk.files.get(last) ?? "{}").annotations).toEqual([ann("new")]);
  });
});

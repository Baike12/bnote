import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const api = {
    readFile: async (path: string): Promise<string> => {
      const raw = files.get(path);
      if (raw === undefined) throw new Error(`READ_FAILED: ${path}`);
      return raw;
    },
    writeFile: async (path: string, text: string): Promise<void> => {
      files.set(path, text);
      writes.push(path);
    },
  };
  return { files, writes, api };
});

vi.mock("@/lib/tauri", () => ({ api: disk.api }));

import {
  flushWebAnnotations,
  loadWebAnnotations,
  saveWebAnnotations,
  type WebAnnotation,
} from "./webAnnotations";

/**
 * Web annotation persistence: one file per URL under
 * `<vault>/.bnote/materials/webpages/<dir>/annotations.json`. A page with no
 * material directory (no vault, a failed backend call) still works in the
 * page; it just is not persisted, and the module must not write anywhere else.
 *
 * The store is a module singleton: each test uses its own material directory.
 */

function ann(id: string, quote = "q"): WebAnnotation {
  return {
    id,
    quote,
    prefix: "",
    suffix: "",
    offset: 0,
    kind: "highlight",
    text: "",
    createdAt: 1,
  };
}

function fileFor(materialDir: string): string {
  return `/vault/.bnote/${materialDir}/annotations.json`;
}

async function writesLanded(count: number): Promise<void> {
  await vi.waitFor(() => expect(disk.writes).toHaveLength(count));
}

beforeEach(() => {
  disk.files.clear();
  disk.writes.length = 0;
});

describe("loadWebAnnotations", () => {
  it("without a material directory there is nothing to read", async () => {
    await expect(loadWebAnnotations("/vault", null)).resolves.toEqual([]);
  });

  it("reads that material's annotations and keeps the original URL in the file", async () => {
    disk.files.set(
      fileFor("materials/webpages/a"),
      JSON.stringify({ version: 1, url: "https://x.com/p", annotations: [ann("x")] }),
    );

    await expect(loadWebAnnotations("/vault", "materials/webpages/a")).resolves.toEqual([ann("x")]);
  });

  it("a missing or malformed file reads as no annotations", async () => {
    disk.files.set(fileFor("materials/webpages/b"), "{oops");

    await expect(loadWebAnnotations("/vault", "materials/webpages/b")).resolves.toEqual([]);
    await expect(loadWebAnnotations("/vault", "materials/webpages/none")).resolves.toEqual([]);
  });
});

describe("saveWebAnnotations", () => {
  it("without a material directory nothing is written", async () => {
    saveWebAnnotations("/vault", "https://x.com/p", [ann("x")], null);
    flushWebAnnotations();
    await Promise.resolve();

    expect(disk.writes).toEqual([]);
  });

  it("flush writes the URL and the validated list into the material file", async () => {
    saveWebAnnotations("/vault", "https://x.com/p", [ann("x")], "materials/webpages/c");
    flushWebAnnotations();
    await writesLanded(1);

    expect(disk.writes).toEqual([fileFor("materials/webpages/c")]);
    expect(JSON.parse(disk.files.get(disk.writes[0]) ?? "{}")).toEqual({
      version: 1,
      url: "https://x.com/p",
      annotations: [ann("x")],
    });
  });

  it("the page's list is re-validated on the way out, so junk never reaches disk", async () => {
    const junk = [{ id: "", quote: "x", offset: 0 }, ann("good")] as unknown as WebAnnotation[];

    saveWebAnnotations("/vault", "https://x.com/p", junk, "materials/webpages/d");
    flushWebAnnotations();
    await writesLanded(1);

    expect(JSON.parse(disk.files.get(disk.writes[0]) ?? "{}").annotations).toEqual([ann("good")]);
  });

  it("the file's URL is written once: a later save keeps the first URL", async () => {
    saveWebAnnotations("/vault", "https://x.com/first", [ann("a")], "materials/webpages/e");
    flushWebAnnotations();
    await writesLanded(1);
    saveWebAnnotations("/vault", "https://x.com/second", [ann("b")], "materials/webpages/e");
    flushWebAnnotations();
    await writesLanded(2);

    const written = JSON.parse(disk.files.get(disk.writes[1]) ?? "{}");
    expect(written.url).toBe("https://x.com/first");
    expect(written.annotations).toEqual([ann("b")]);
  });
});

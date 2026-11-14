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
  emptyReadPositions,
  flushReadPositions,
  loadReadPositions,
  MAX_TRACKED_POSITIONS,
  parseReadPositions,
  savePdfReadPosition,
} from "./readPositions";

/**
 * Reading positions live in one file (`read-positions.json`): the PDF's page +
 * in-page ratio, keyed by the document path. They are volatile traces, so a
 * missing file is empty data and the entry count is capped — a long reading
 * history must not grow the file without bound.
 */

const FILE = "/vault/.bnote/read-positions.json";

async function writesLanded(count: number): Promise<void> {
  await vi.waitFor(() => expect(disk.writes).toHaveLength(count));
}

function stored(): {
  version: 1;
  pdfs: Record<string, { page: number; offset: number; at: number }>;
  urls: Record<string, { ratio: number; at: number }>;
} {
  return JSON.parse(disk.files.get(FILE) ?? "{}") as ReturnType<typeof stored>;
}

beforeEach(() => {
  disk.files.clear();
  disk.writes.length = 0;
});

describe("loadReadPositions", () => {
  it("a missing file reads as empty positions", async () => {
    await expect(loadReadPositions("/vault")).resolves.toEqual(emptyReadPositions());
  });

  it("a stored position comes back normalized (page floored, offset clamped)", async () => {
    // A separate vault root: the store caches each file, so a root already
    // read in another test would answer from its cache instead of the disk.
    disk.files.set(
      "/seeded/.bnote/read-positions.json",
      JSON.stringify({
        version: 1,
        pdfs: { "papers/a.pdf": { page: 3.9, offset: 1.4, at: 7 } },
        urls: {},
      }),
    );

    const positions = await loadReadPositions("/seeded");

    expect(positions.pdfs["papers/a.pdf"]).toMatchObject({ page: 3, offset: 1 });
  });

  it("a hand-edited file cannot take the reader down", async () => {
    disk.files.set("/broken/.bnote/read-positions.json", "{not json");

    await expect(loadReadPositions("/broken")).resolves.toEqual(emptyReadPositions());
  });
});

describe("savePdfReadPosition", () => {
  it("flush writes the position into the one positions file, stamped with a time", async () => {
    savePdfReadPosition("/vault", "papers/a.pdf", { page: 4, offset: 0.5 });
    flushReadPositions();
    await writesLanded(1);

    expect(disk.writes).toEqual([FILE]);
    const file = stored();
    expect(file.pdfs["papers/a.pdf"]).toMatchObject({ page: 4, offset: 0.5 });
    expect(file.pdfs["papers/a.pdf"].at).toBeGreaterThan(0);
  });

  it("saving a second document keeps the first one's entry", async () => {
    savePdfReadPosition("/vault", "papers/a.pdf", { page: 1, offset: 0 });
    flushReadPositions();
    await writesLanded(1);
    savePdfReadPosition("/vault", "papers/b.pdf", { page: 2, offset: 0.25 });
    flushReadPositions();
    await writesLanded(2);

    const file = stored();
    expect(Object.keys(file.pdfs).sort()).toEqual(["papers/a.pdf", "papers/b.pdf"]);
    expect(file.pdfs["papers/b.pdf"]).toMatchObject({ page: 2, offset: 0.25 });
  });

  it("the same document overwrites its previous position", async () => {
    savePdfReadPosition("/vault", "papers/a.pdf", { page: 1, offset: 0 });
    flushReadPositions();
    await writesLanded(1);
    savePdfReadPosition("/vault", "papers/a.pdf", { page: 9, offset: 0.75 });
    flushReadPositions();
    await writesLanded(2);

    expect(stored().pdfs["papers/a.pdf"]).toMatchObject({ page: 9, offset: 0.75 });
  });

  it("a long reading history is pruned to the newest entries instead of growing without bound", async () => {
    // More documents than the cap, each with its own increasing timestamp.
    for (let i = 0; i < MAX_TRACKED_POSITIONS + 5; i++) {
      savePdfReadPosition("/vault", `papers/${i}.pdf`, { page: 1, offset: 0 });
    }
    flushReadPositions();
    await writesLanded(1);

    const file = stored();
    expect(Object.keys(file.pdfs).length).toBeLessThanOrEqual(MAX_TRACKED_POSITIONS);
    // The newest document survived the prune.
    expect(file.pdfs[`papers/${MAX_TRACKED_POSITIONS + 4}.pdf`]).toBeDefined();
  });
});

describe("parseReadPositions", () => {
  it("rejects a non-object payload instead of trusting its fields", () => {
    expect(parseReadPositions("[]")).toEqual(emptyReadPositions());
    expect(parseReadPositions(null)).toEqual(emptyReadPositions());
  });
});

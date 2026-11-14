import { describe, expect, it, vi } from "vitest";
import type { FileNode } from "@/lib/tauri";
import {
  legacyPdfDocKey,
  migrateLegacyAnnotations,
  type AnnotationMigrationIO,
} from "./annotationMigration";

const VAULT = "/vault";

function node(relPath: string, kind: "file" | "dir"): FileNode {
  return {
    name: relPath.slice(relPath.lastIndexOf("/") + 1),
    relPath,
    kind,
    children: null,
  };
}

/** An in-memory vault: `files` holds the content, `trashed` the paths the migration deleted. */
function memIO(
  initial: Record<string, string>,
  failWrite = false,
  overrides: Partial<AnnotationMigrationIO> = {},
) {
  const files = new Map(Object.entries(initial));
  const trashed: string[] = [];
  const io: AnnotationMigrationIO = {
    readDir: async (relDir) => {
      const prefix = relDir ? `${relDir}/` : "";
      const children = new Map<string, "file" | "dir">();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest || rest.startsWith(".")) continue;
        const slash = rest.indexOf("/");
        children.set(
          `${prefix}${slash === -1 ? rest : rest.slice(0, slash)}`,
          slash === -1 ? "file" : "dir",
        );
      }
      const nodes = [...children].map(([path, kind]) => node(path, kind));
      return nodes;
    },
    readFile: async (path) => {
      const rel = path.startsWith(`${VAULT}/`) ? path.slice(VAULT.length + 1) : path;
      const text = files.get(rel);
      if (text === undefined) throw new Error(`missing ${rel}`);
      return text;
    },
    writeFile: async (path, text) => {
      if (failWrite) throw new Error("disk full");
      files.set(path.startsWith(`${VAULT}/`) ? path.slice(VAULT.length + 1) : path, text);
    },
    trash: async (path) => {
      const rel = path.startsWith(`${VAULT}/`) ? path.slice(VAULT.length + 1) : path;
      trashed.push(rel);
      for (const key of [...files.keys()]) {
        if (key === rel || key.startsWith(`${rel}/`)) files.delete(key);
      }
    },
    materialEnsure: async (study) => ({
      kind: study.kind === "pdf" ? "pdfs" : "webpages",
      dir: "migrated",
      relDir: study.kind === "pdf" ? "materials/pdfs/migrated" : "materials/webpages/migrated",
      title: "",
    }),
    ...overrides,
  };
  return { io, files, trashed };
}

const ANN = (id: string) => ({
  id,
  page: 1,
  rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.01 }],
  kind: "highlight",
  text: "",
  createdAt: 1,
});

describe("legacy annotation migration", () => {
  it("the old pdf file name maps back to the pdf's vault relative path", () => {
    expect(legacyPdfDocKey(".bnote/pdf-annotations/pdfs/a.pdf.json")).toBe("pdfs/a.pdf");
    expect(legacyPdfDocKey(".bnote/pdf-annotations/papers/deep/a.pdf.json")).toBe(
      "papers/deep/a.pdf",
    );
  });

  it("merges a legacy pdf file into the material file by id and removes the old tree", async () => {
    const { io, files, trashed } = memIO({
      ".bnote/pdf-annotations/pdfs/a.pdf.json": JSON.stringify({
        version: 1,
        annotations: [ANN("keep"), ANN("dup")],
      }),
      ".bnote/materials/pdfs/migrated/annotations.json": JSON.stringify({
        version: 1,
        annotations: [ANN("dup"), ANN("new")],
      }),
    });

    await migrateLegacyAnnotations(VAULT, io);

    const merged = JSON.parse(
      files.get(".bnote/materials/pdfs/migrated/annotations.json") ?? "{}",
    ) as { annotations: { id: string }[] };
    expect(merged.annotations.map((a) => a.id)).toEqual(["dup", "new", "keep"]);
    expect(files.has(".bnote/pdf-annotations/pdfs/a.pdf.json")).toBe(false);
    expect(trashed).toContain(".bnote/pdf-annotations");
  });

  it("moves a legacy web file into the material directory of its URL", async () => {
    const { io, files, trashed } = memIO({
      ".bnote/web-annotations/x.com-abc.json": JSON.stringify({
        version: 1,
        url: "https://x.com/poteto/article/1",
        annotations: [{ id: "w1", quote: "q", prefix: "", suffix: "", offset: 0 }],
      }),
    });

    await migrateLegacyAnnotations(VAULT, io);

    const moved = JSON.parse(
      files.get(".bnote/materials/webpages/migrated/annotations.json") ?? "{}",
    ) as { url: string; annotations: { id: string }[] };
    expect(moved.url).toBe("https://x.com/poteto/article/1");
    expect(moved.annotations.map((a) => a.id)).toEqual(["w1"]);
    expect(trashed).toContain(".bnote/web-annotations");
  });

  it("keeps a web file that carries no url and leaves its directory alone", async () => {
    const { io, files, trashed } = memIO({
      ".bnote/web-annotations/broken.json": JSON.stringify({ version: 1, annotations: [] }),
    });

    await migrateLegacyAnnotations(VAULT, io);

    expect(files.has(".bnote/web-annotations/broken.json")).toBe(true);
    expect(trashed).not.toContain(".bnote/web-annotations");
  });

  it("a failed write leaves the old file and its tree in place", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { io, files, trashed } = memIO(
      {
        ".bnote/pdf-annotations/pdfs/a.pdf.json": JSON.stringify({
          version: 1,
          annotations: [ANN("keep")],
        }),
      },
      true,
    );

    await migrateLegacyAnnotations(VAULT, io);

    expect(files.has(".bnote/pdf-annotations/pdfs/a.pdf.json")).toBe(true);
    expect(trashed).not.toContain(".bnote/pdf-annotations");
    warn.mockRestore();
  });

  it("a vault with no legacy trees costs two directory reads and no writes", async () => {
    const { io, files } = memIO({ "notes/a.md": "# a" });
    const writeFile = vi.fn(io.writeFile);
    const trash = vi.fn(io.trash);

    await migrateLegacyAnnotations(VAULT, { ...io, writeFile, trash });

    expect(writeFile).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(files.has("notes/a.md")).toBe(true);
  });

  it("an unreadable legacy directory is treated as empty instead of failing the open", async () => {
    const io: AnnotationMigrationIO = {
      readDir: async () => {
        throw new Error("permission denied");
      },
      readFile: async () => {
        throw new Error("should not be read");
      },
      writeFile: async () => {},
      trash: async () => {},
      materialEnsure: async () => {
        throw new Error("should not be reached");
      },
    };

    await expect(migrateLegacyAnnotations(VAULT, io)).resolves.toBeUndefined();
  });

  it("one broken file does not stop the rest, and its tree stays because a file is still there", async () => {
    const { io, files, trashed } = memIO({
      ".bnote/pdf-annotations/pdfs/a.pdf.json": "{not json",
      ".bnote/pdf-annotations/pdfs/b.pdf.json": JSON.stringify({
        version: 1,
        annotations: [ANN("b")],
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await migrateLegacyAnnotations(VAULT, {
      ...io,
      // The broken file cannot be read: it stays behind, so the tree is kept.
      readFile: async (path) => {
        if (path.endsWith("a.pdf.json")) throw new Error("unreadable");
        return io.readFile(path);
      },
    });

    // The healthy file still migrated into its material.
    expect(files.has(".bnote/materials/pdfs/migrated/annotations.json")).toBe(true);
    expect(files.has(".bnote/pdf-annotations/pdfs/a.pdf.json")).toBe(true);
    expect(trashed).not.toContain(".bnote/pdf-annotations");
    warn.mockRestore();
  });

  it("a material directory that cannot be created leaves the legacy file alone", async () => {
    const { io, files } = memIO({
      ".bnote/pdf-annotations/pdfs/a.pdf.json": JSON.stringify({
        version: 1,
        annotations: [ANN("keep")],
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await migrateLegacyAnnotations(VAULT, {
      ...io,
      materialEnsure: async () => {
        throw new Error("no backend");
      },
    });

    expect(files.has(".bnote/pdf-annotations/pdfs/a.pdf.json")).toBe(true);
    warn.mockRestore();
  });

  it("a tree whose trash call fails is reported, and nothing throws", async () => {
    const { io, files } = memIO({
      ".bnote/pdf-annotations/pdfs/a.pdf.json": JSON.stringify({
        version: 1,
        annotations: [ANN("keep")],
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      migrateLegacyAnnotations(VAULT, {
        ...io,
        trash: async () => {
          throw new Error("trash unavailable");
        },
      }),
    ).resolves.toBeUndefined();

    // The migration itself succeeded; only the cleanup failed.
    expect(files.has(".bnote/materials/pdfs/migrated/annotations.json")).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a nested legacy directory is walked and every json file inside is migrated", async () => {
    const { io, files } = memIO({
      ".bnote/pdf-annotations/papers/deep/a.pdf.json": JSON.stringify({
        version: 1,
        annotations: [ANN("deep")],
      }),
    });

    await migrateLegacyAnnotations(VAULT, io);

    expect(files.has(".bnote/pdf-annotations/papers/deep/a.pdf.json")).toBe(false);
  });

  it("a non-json file in the legacy tree is not touched", async () => {
    const { io, files } = memIO({
      ".bnote/pdf-annotations/readme.txt": "hand-written notes",
    });

    await migrateLegacyAnnotations(VAULT, io);

    expect(files.get(".bnote/pdf-annotations/readme.txt")).toBe("hand-written notes");
  });
});

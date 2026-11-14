import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The migration's default IO is the real IPC boundary. Every call site is
 * asserted here, including the trash command: the one-time migration must not
 * speak a different command than the app does, or a rename would fail only on
 * a user's real vault.
 *
 * `annotationMigration.test.ts` injects an in-memory IO for the merge and
 * failure rules; this file leaves `io` out on purpose.
 */
const boundary = vi.hoisted(() => {
  const api = {
    readDir: vi.fn(async (_relPath: string) => [] as unknown[]),
    readFile: vi.fn(async (_path: string) => ""),
    writeFile: vi.fn(async (_path: string, _text: string) => {}),
    trashPath: vi.fn(async (_path: string) => {}),
  };
  const agentApi = {
    materialEnsure: vi.fn(async () => ({
      kind: "pdfs",
      dir: "a",
      relDir: "materials/pdfs/a",
      title: "",
    })),
  };
  return { api, agentApi };
});

vi.mock("@/lib/tauri", () => ({ api: boundary.api, agentApi: boundary.agentApi }));

import { migrateLegacyAnnotations } from "./annotationMigration";

const VAULT = "/vault";

beforeEach(() => {
  boundary.api.readDir.mockReset();
  boundary.api.readFile.mockReset();
  boundary.api.writeFile.mockReset();
  boundary.api.trashPath.mockReset();
  boundary.agentApi.materialEnsure.mockReset();
  boundary.agentApi.materialEnsure.mockResolvedValue({
    kind: "pdfs",
    dir: "a",
    relDir: "materials/pdfs/a",
    title: "",
  });
});

describe("the default migration IO", () => {
  it("walks the two legacy trees through api.readDir with vault-relative paths", async () => {
    boundary.api.readDir.mockResolvedValue([]);

    await migrateLegacyAnnotations(VAULT);

    expect(boundary.api.readDir.mock.calls.map(([rel]) => rel)).toEqual([
      ".bnote/pdf-annotations",
      ".bnote/web-annotations",
    ]);
    // Nothing to migrate: no write and no trash.
    expect(boundary.api.writeFile).not.toHaveBeenCalled();
    expect(boundary.api.trashPath).not.toHaveBeenCalled();
  });

  it("reads the legacy file, ensures the material and writes the merged file at the material path", async () => {
    const legacy = JSON.stringify({
      version: 1,
      annotations: [
        {
          id: "x",
          page: 1,
          rects: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.01 }],
          kind: "highlight",
          text: "",
          createdAt: 1,
        },
      ],
    });
    // First readDir: the pdf tree; second: its only file is returned by readDir at vault level.
    boundary.api.readDir.mockReset();
    boundary.api.readDir
      .mockResolvedValueOnce([
        { name: "pdfs", relPath: ".bnote/pdf-annotations/pdfs", kind: "dir", children: null },
      ])
      .mockResolvedValueOnce([
        {
          name: "a.pdf.json",
          relPath: ".bnote/pdf-annotations/pdfs/a.pdf.json",
          kind: "file",
          children: null,
        },
      ])
      .mockResolvedValueOnce([]);
    boundary.api.readFile.mockResolvedValue(legacy);

    await migrateLegacyAnnotations(VAULT);

    // The PDF's vault-relative path is recovered from the legacy file name.
    expect(boundary.agentApi.materialEnsure).toHaveBeenCalledWith({
      kind: "pdf",
      path: `${VAULT}/pdfs/a.pdf`,
      title: "",
    });
    expect(boundary.api.readFile).toHaveBeenCalledWith(
      `${VAULT}/.bnote/pdf-annotations/pdfs/a.pdf.json`,
    );
    expect(boundary.api.writeFile).toHaveBeenCalledWith(
      `${VAULT}/.bnote/materials/pdfs/a/annotations.json`,
      expect.any(String),
    );
    // The legacy file is trashed through the real command.
    expect(boundary.api.trashPath).toHaveBeenCalledWith(
      `${VAULT}/.bnote/pdf-annotations/pdfs/a.pdf.json`,
    );
  });

  it("trashes the emptied legacy tree through api.trashPath", async () => {
    boundary.api.readDir.mockReset();
    boundary.api.readDir
      .mockResolvedValueOnce([
        {
          name: "a.pdf.json",
          relPath: ".bnote/pdf-annotations/a.pdf.json",
          kind: "file",
          children: null,
        },
      ])
      // All files were trashed: the tree reads back empty, so the directory itself is trashed.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    boundary.api.readFile.mockResolvedValue(JSON.stringify({ version: 1, annotations: [] }));

    await migrateLegacyAnnotations(VAULT);

    expect(boundary.api.trashPath).toHaveBeenCalledWith(`${VAULT}/.bnote/pdf-annotations`);
  });
});

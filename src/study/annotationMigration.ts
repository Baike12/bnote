import { agentApi, api, type FileNode, type MaterialInfo, type StudyContent } from "@/lib/tauri";
import {
  mergePdfAnnotations,
  parsePdfAnnotations,
  type PdfAnnotation,
  type PdfAnnotationFile,
} from "./pdfAnnotations";
import {
  mergeUrlAnnotations,
  parseWebAnnotationFile,
  type WebAnnotation,
  type WebAnnotationFile,
} from "./webAnnotations";

/**
 * One-time move of the pre-material annotation files.
 *
 * Annotations used to live in their own `.bnote/pdf-annotations/` and
 * `.bnote/web-annotations/` trees, keyed by the PDF's vault path or the URL's
 * host-hash. They belong inside the material directory now
 * (`materials/<kind>/<dir>/annotations.json`), next to the sessions of the same
 * material. This runs once when the vault opens: every legacy file is merged
 * into its material (by annotation id, the material file wins) and trashed
 * afterwards, so `.bnote` keeps one tree per concept.
 *
 * A file whose material directory cannot be created (no backend, a failed
 * write) stays where it is; the old tree is only removed when every file in it
 * has been migrated, so nothing is lost silently.
 */
const PDF_LEGACY_DIR = ".bnote/pdf-annotations";
const WEB_LEGACY_DIR = ".bnote/web-annotations";

/** The filesystem surface the migration needs; injected in tests. */
export interface AnnotationMigrationIO {
  readDir(relDir: string): Promise<FileNode[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  trash(path: string): Promise<void>;
  materialEnsure(study: StudyContent): Promise<MaterialInfo>;
}

const defaultIO: AnnotationMigrationIO = {
  readDir: (relDir) => api.readDir(relDir),
  readFile: (path) => api.readFile(path),
  writeFile: (path, text) => api.writeFile(path, text),
  trash: (path) => api.trashPath(path),
  materialEnsure: (study) => agentApi.materialEnsure(study),
};

/** Every `.json` under one `.bnote` directory, recursively (`relPath` is vault relative). */
async function listJsonFiles(io: AnnotationMigrationIO, relDir: string): Promise<string[]> {
  let nodes: FileNode[];
  try {
    nodes = await io.readDir(relDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind === "dir") {
      out.push(...(await listJsonFiles(io, node.relPath)));
    } else if (/\.json$/i.test(node.name)) {
      out.push(node.relPath);
    }
  }
  return out;
}

/** `pdf-annotations/pdfs/a.pdf.json` -> `pdfs/a.pdf` (the PDF's vault relative path at the old location). */
export function legacyPdfDocKey(relPath: string): string {
  const prefix = `${PDF_LEGACY_DIR}/`;
  const rel = relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
  return rel.replace(/\.json$/i, "");
}

async function readOrNull(io: AnnotationMigrationIO, path: string): Promise<string | null> {
  try {
    return await io.readFile(path);
  } catch {
    return null;
  }
}

async function migratePdfFiles(io: AnnotationMigrationIO, vaultRoot: string): Promise<boolean> {
  const files = await listJsonFiles(io, PDF_LEGACY_DIR);
  let migrated = 0;
  for (const relPath of files) {
    try {
      const legacy = parsePdfAnnotations(await io.readFile(`${vaultRoot}/${relPath}`));
      const docKey = legacyPdfDocKey(relPath);
      const info = await io.materialEnsure({
        kind: "pdf",
        path: `${vaultRoot}/${docKey}`,
        title: "",
      });
      const target = `${vaultRoot}/.bnote/${info.relDir}/annotations.json`;
      const current = parsePdfAnnotations(await readOrNull(io, target));
      const merged: PdfAnnotation[] = mergePdfAnnotations(current, legacy);
      const file: PdfAnnotationFile = { version: 1, annotations: merged };
      await io.writeFile(target, JSON.stringify(file));
      await io.trash(`${vaultRoot}/${relPath}`);
      migrated += 1;
    } catch (e) {
      console.warn(`[annotations] migrate ${relPath} failed`, e);
    }
  }
  return files.length > 0 && migrated === files.length;
}

async function migrateWebFiles(io: AnnotationMigrationIO, vaultRoot: string): Promise<boolean> {
  const files = await listJsonFiles(io, WEB_LEGACY_DIR);
  let migrated = 0;
  for (const relPath of files) {
    try {
      const file = parseWebAnnotationFile(await io.readFile(`${vaultRoot}/${relPath}`));
      if (!file.url) {
        // Nothing identifies the page: keep the file (an empty URL cannot be
        // resolved to a material directory).
        continue;
      }
      const info = await io.materialEnsure({ kind: "url", url: file.url, title: "" });
      const target = `${vaultRoot}/.bnote/${info.relDir}/annotations.json`;
      const current = parseWebAnnotationFile(await readOrNull(io, target));
      const merged: WebAnnotation[] = mergeUrlAnnotations(current.annotations, file.annotations);
      const next: WebAnnotationFile = {
        version: 1,
        url: current.url || file.url,
        annotations: merged,
      };
      await io.writeFile(target, JSON.stringify(next));
      await io.trash(`${vaultRoot}/${relPath}`);
      migrated += 1;
    } catch (e) {
      console.warn(`[annotations] migrate ${relPath} failed`, e);
    }
  }
  return files.length > 0 && migrated === files.length;
}

/** Trash a legacy tree only when nothing is left to migrate in it. */
async function removeLegacyDir(
  io: AnnotationMigrationIO,
  vaultRoot: string,
  relDir: string,
): Promise<void> {
  if ((await listJsonFiles(io, relDir)).length > 0) return;
  try {
    await io.trash(`${vaultRoot}/${relDir}`);
  } catch (e) {
    console.warn(`[annotations] remove ${relDir} failed`, e);
  }
}

/**
 * Move every annotation file of the old `.bnote` trees into its material
 * directory. Idempotent: a vault without the old trees costs two directory
 * reads. Never throws — a failed migration leaves the old files in place.
 */
export async function migrateLegacyAnnotations(
  vaultRoot: string,
  io: AnnotationMigrationIO = defaultIO,
): Promise<void> {
  if (await migratePdfFiles(io, vaultRoot)) await removeLegacyDir(io, vaultRoot, PDF_LEGACY_DIR);
  if (await migrateWebFiles(io, vaultRoot)) await removeLegacyDir(io, vaultRoot, WEB_LEGACY_DIR);
}

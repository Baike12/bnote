import fs from "node:fs";
import path from "node:path";

/**
 * The app stylesheet as one string, in cascade order.
 *
 * The sheet is split into one file per domain (see index.css). Several gates
 * reason about the whole sheet at once — theme coverage, overlay anchoring,
 * settings rows — and they must keep working across a file move. Reading the
 * entry's `@import` list here keeps that knowledge in one place: a gate never
 * names a file, so adding or renaming a domain file cannot silently make a
 * gate scan nothing.
 *
 * Test-only: importing this module from app code would pull `node:fs` into
 * the bundle.
 */

const STYLES_DIR = path.resolve(__dirname);

const IMPORT = /@import\s+"\.\/([^"]+)";/g;

/** Files in the order `index.css` imports them. */
export function styleFiles(): string[] {
  const index = fs.readFileSync(path.join(STYLES_DIR, "index.css"), "utf8");
  return [...index.matchAll(IMPORT)].map((m) => m[1]);
}

/** Concatenated source of every imported file, in cascade order. */
export function readAllCss(): string {
  return styleFiles()
    .map((file) => fs.readFileSync(path.join(STYLES_DIR, file), "utf8"))
    .join("\n");
}

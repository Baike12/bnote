import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { styleFiles } from "./cssSource";

/**
 * Structure gate for the split stylesheet.
 *
 * The sheet used to be one 10,120-line global.css. The split into one file
 * per domain is only useful if it stays a split: nothing enforces "one domain
 * per file" by the type system, and the failure mode is silent — a rule lands
 * in whichever file is open, the file grows back into the undifferentiated
 * sheet, and the next reader again has 1,400 rules in one place.
 *
 * Four invariants, each a decision this gate turns into a reviewable failure:
 *
 * 1. index.css holds no rules — it is the import list and the cascade
 *    contract. A rule there would win or lose by an accident of placement.
 * 2. The import order is frozen. Order IS the cascade: the files are plain
 *    unlayered rules, so a later file wins a tie. Reordering is allowed, but
 *    only together with a fixed contract and a reviewed diff.
 * 3. Every file carries the generated header (purpose on line 1), and no
 *    .css file exists that index.css does not import.
 * 4. `!important` is a frozen inventory per file. There are 32 today (16 of
 *    them the editor's cursor/selection layers), all in
 *    leaves that fight a third party or an inline style (CodeMirror cursor
 *    layers, the editor host, xterm). A new one must be an explicit decision.
 *
 * The size ratchet keeps the split from decaying back into one file: the
 * ceiling is ~1.3x the largest file today.
 */

const STYLES_DIR = path.resolve(__dirname);
const MAX_LINES = 2400;

/** The cascade contract: import order, and the !important budget per file. */
const CONTRACT: ReadonlyArray<readonly [file: string, important: number]> = [
  ["tokens.css", 0],
  ["shell.css", 0],
  ["editor.css", 16],
  ["controls.css", 0],
  ["modals.css", 0],
  ["settings.css", 7],
  ["dialogs.css", 0],
  ["study.css", 0],
  ["agent-panel.css", 0],
  ["agent-messages.css", 4],
  ["agent-work.css", 4],
  ["study-content.css", 0],
  ["drawing.css", 0],
  ["python.css", 0],
  ["code-shell.css", 0],
  ["invest.css", 0],
  ["pdf.css", 0],
  ["creative.css", 0],
  ["projects.css", 0],
  ["code-panel.css", 1],
];

const read = (file: string): string => fs.readFileSync(path.join(STYLES_DIR, file), "utf8");
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("stylesheet structure", () => {
  it("index.css is an import list, not a stylesheet", () => {
    const body = stripComments(read("index.css"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const notImports = body.filter((line) => !/^@import\s+"\.\/[^"]+\.css";$/.test(line));
    expect(notImports, "a rule in index.css would sit outside every domain file").toEqual([]);
    expect(body.length).toBeGreaterThan(0);
  });

  it("the import order matches the cascade contract", () => {
    expect(styleFiles()).toEqual(CONTRACT.map(([file]) => file));
  });

  it("every imported file exists, is non-empty and states its purpose", () => {
    const broken: string[] = [];
    for (const [file] of CONTRACT) {
      const full = path.join(STYLES_DIR, file);
      if (!fs.existsSync(full)) {
        broken.push(`${file}: missing`);
        continue;
      }
      const text = read(file);
      if (text.trim().length === 0) broken.push(`${file}: empty`);
      if (!/^\/\* bnote stylesheet — .+\.\n/.test(text)) {
        broken.push(`${file}: no generated header on line 1`);
      }
    }
    expect(broken, "a domain file is missing, empty or unlabelled").toEqual([]);
  });

  it("no .css file is left out of the import list", () => {
    const present = fs
      .readdirSync(STYLES_DIR)
      .filter((name) => name.endsWith(".css"))
      .sort();
    const imported = [...styleFiles(), "index.css"].sort();
    expect(present, "an orphaned .css file is dead weight or an unimported move").toEqual(imported);
  });

  it("the !important inventory is unchanged", () => {
    const counts = CONTRACT.map(([file]) => {
      const matches = stripComments(read(file)).match(/!important/g);
      return `${file}: ${matches?.length ?? 0}`;
    });
    expect(counts).toEqual(CONTRACT.map(([file, n]) => `${file}: ${n}`));
  });

  it("the theme variables live in tokens.css only", () => {
    const owners = styleFiles().filter((file) => /--bg0\s*:/.test(read(file)));
    expect(owners).toEqual(["tokens.css"]);
  });

  it("no file grows back into a single-sheet file", () => {
    const tooBig = CONTRACT.map(([file]) => `${file}: ${read(file).split("\n").length}`).filter(
      (entry) => Number(entry.split(": ")[1]) > MAX_LINES,
    );
    expect(
      tooBig,
      `a file exceeded ${MAX_LINES} lines — split it by the next domain boundary`,
    ).toEqual([]);
  });
});

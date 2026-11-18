import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The defect-class registry in docs/TESTING.md is executable documentation:
 * every row claims a lock, and this gate holds the claim to the code.
 *
 * The gate's own oracle was once the weakest link ("assumed covered"
 * recurring inside the gate that guards against "assumed covered"): a plain
 * substring check passed on a describe() title while every assertion inside
 * was deleted, and on a selector name while no overlay was ever measured.
 * Two lock strengths now:
 *
 * - Test files (`.test.` / `.e2e.`): the needle must be part of a title of an
 *   it()/test() call that would actually execute (`.skip`/`.todo` excluded).
 *   Runtime-conditional skips (the perf gates' load-gated `describe`) cannot
 *   be seen by parsing — those rows keep implementation-substring locks and
 *   are closed by BNOTE_PERF_REQUIRE instead.
 * - Everything else: the needle must appear in the file (implementation
 *   evidence, e.g. a Rust test function or a seam function's signature).
 */

const root = path.resolve(__dirname, "..");
const doc = fs.readFileSync(path.join(root, "docs", "TESTING.md"), "utf8");

const TEST_FILE = /\.(?:test|e2e)\.(?:ts|tsx)$/;

/** Titles of it()/test() calls in a test file, minus `.skip`/`.todo` ones. */
function declaredTitles(relPath: string): string[] {
  const text = fs.readFileSync(path.join(root, relPath), "utf8");
  const titles: string[] = [];
  for (const m of text.matchAll(/\b(?:it|test)(\.(\w+))?\s*\(\s*(["'`])((?:\\.|(?!\3).)*)\3/gs)) {
    if (m[2] === "skip" || m[2] === "todo") continue;
    titles.push(m[4].replaceAll("\\`", "`").replaceAll('\\"', '"').replaceAll("\\'", "'"));
  }
  return titles;
}

interface RegistryEntry {
  /** A stable fragment of the registry row's first cell (the class name). */
  row: string;
  /** file → needle(s) the lock's code evidence. */
  locks: Record<string, string | string[]>;
}

const REGISTRY: RegistryEntry[] = [
  {
    row: "**Seam drift**",
    locks: {
      "src/study/layoutModel.ts": "export function leftDividerWidths(",
      "src/projects/layoutModel.ts": "export function sideDividerWidth(",
      "src/components/dividerSeam.gate.test.ts": "no component calls the drag model directly",
      "src/invest/layoutModel.test.ts":
        "the left divider moves the boundary and keeps the two columns' sum",
    },
  },
  {
    row: "**Contract rename drift**",
    locks: {
      "src/lib/tauri.contract.test.ts": "command names stay stable",
      "src-tauri/tests/command_surface.rs": "generate_handler",
      "src/lib/ipcContract.test.ts":
        "every invoked command is defined as a #[tauri::command] in Rust",
    },
  },
  {
    row: "**Cross-market data routing**",
    locks: {
      "src-tauri/src/invest/instruments.rs": [
        "fn markets_are_isolated_by_key",
        "fn market_for_follows_the_instrument_master",
      ],
      "src/invest/market.test.ts": "resolves the market from the instrument master",
    },
  },
  {
    row: "**Unit-contract violation**",
    locks: {
      "src/invest/format.ts": "export function yi(",
      "src/invest/format.test.ts": "sharesToLots converts shares to whole lots",
      "src-tauri/src/commands/invest.rs": "fn import_rejects_ohlc_inconsistent_bars",
    },
  },
  {
    row: "**Async state migration**",
    locks: {
      "src/invest/store.integration.test.ts": [
        "jumps to the imported scope",
        "bumps after a completed run so BacktestTab reloads in place",
      ],
      "src/invest/layoutModel.test.ts": "jumps to the imported stock",
    },
  },
  {
    row: "**CSS anchoring / geometry**",
    locks: {
      "src/components/overlayAnchoring.gate.test.ts":
        "every anchored overlay's container declares a position",
      "e2e/specs/investLayout.e2e.ts": "anchoring contract",
    },
  },
  {
    row: "**Ingested-data shape drift**",
    locks: {
      "src-tauri/src/invest/quotes.rs": [
        "const US_BODY",
        "fn cn_quote_uses_lot_and_wan_conversion",
      ],
    },
  },
  {
    row: "**Parser robustness**",
    locks: {
      "src-tauri/src/invest/quotes.rs": [
        "fn every_generated_valid_config_parses_and_routes",
        "fn corrupted_yaml_never_panics_and_reports_a_line",
      ],
    },
  },
  {
    row: "**Date boundary / timezone**",
    locks: {
      "src-tauri/src/invest/ingest.rs": [
        "fn feed_day_for",
        "fn a_day_boundary_rolls_over_exactly_once",
      ],
    },
  },
  {
    row: "**Performance regression**",
    locks: {
      // `impl:` locks stay substring-level on purpose: the perf suites skip
      // at runtime through the load-gated `perfDescribe`, which a title
      // parser cannot see. The runtime skip itself is closed by
      // BNOTE_PERF_REQUIRE=1 (below).
      "src/editor/perf.gate.test.ts": "impl:perfDescribe",
      "src/code/perf.gate.test.ts": "impl:perfDescribe",
      "src/perf/loadGate.ts": "perfRequired",
      ".github/workflows/ci.yml": "BNOTE_PERF_REQUIRE=1",
    },
  },
];

describe("defect-class registry gate", () => {
  it("every registered class is still described in docs/TESTING.md", () => {
    for (const entry of REGISTRY) {
      expect(doc, `registry row missing from docs/TESTING.md: ${entry.row}`).toContain(entry.row);
    }
  });

  it("every claimed lock exists and would execute (no 'assumed covered')", () => {
    const missing: string[] = [];
    for (const entry of REGISTRY) {
      for (const [file, needle] of Object.entries(entry.locks)) {
        if (!mustExist(file, needle)) {
          missing.push(`${file} must contain ${JSON.stringify(needle)} (class ${entry.row})`);
        }
      }
    }
    expect(missing, "the registry claims locks the tree lacks").toEqual([]);
  });

  it("e2e specs contain no sleeps — the flake policy's alarm", () => {
    // The Flake row's alarm: a `browser.pause(` in a spec is a timer-based
    // wait, the exact flake source the policy forbids.
    const e2eDir = path.join(root, "e2e", "specs");
    const offenders = fs
      .readdirSync(e2eDir)
      .filter((f) => f.endsWith(".e2e.ts"))
      .flatMap((f) =>
        fs.readFileSync(path.join(e2eDir, f), "utf8").includes("browser.pause(") ? [f] : [],
      );
    expect(offenders, "e2e specs must wait on DOM state, never on timers").toEqual([]);
  });

  it("the three fix-protocol answers are named in the doc", () => {
    for (const answer of [
      "the layer was missing",
      "the layer existed but was mute",
      "no automated layer can reach it",
    ]) {
      expect(doc).toContain(answer);
    }
  });
});

function mustExist(relPath: string, needle: string | string[]): boolean {
  const file = path.join(root, relPath);
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const needles = Array.isArray(needle) ? needle : [needle];
  if (TEST_FILE.test(relPath)) {
    const titles = declaredTitles(relPath);
    return needles.every((n) =>
      n.startsWith("impl:") ? text.includes(n.slice(5)) : titles.some((t) => t.includes(n)),
    );
  }
  return needles.every((n) => text.includes(n));
}

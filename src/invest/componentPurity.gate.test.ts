import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Purity gate for the invest components. The staleness defect shipped twice
 * in .tsx glue: the detail bar aged every market at the CN close (a fresh US
 * bar read one day old), and the chart mapping hardcoded the same zone
 * literal — both invisible to unit tests because the logic sat inside a
 * component no test can render. The rule: market session semantics and unit
 * conversion live in pure modules (staleness.ts, klineData.ts, format.ts),
 * and the components never spell a zone or close time again.
 */

const componentsDir = path.resolve(__dirname, "../components/invest");

function componentSources(): { file: string; text: string }[] {
  return fs
    .readdirSync(componentsDir)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(componentsDir, f), "utf8") }));
}

describe("invest component purity gate", () => {
  const sources = componentSources();

  it("no component spells a session time or a zone literal", () => {
    // `T15:00:00`/`+08:00`/`-05:00` are market-session semantics — they
    // belong to staleness.ts (per-market close) and klineData.ts (display
    // axis), which carry the tests and the DST reasoning.
    const offenders = sources.flatMap(({ file, text }) =>
      /T1[56]:00:00|\+08:00|-05:00|\+00:00/.test(text) ? [file] : [],
    );
    expect(offenders, "session-time semantics leaked into a component").toEqual([]);
  });

  it("the pure modules exist and own the call shapes", () => {
    expect(fs.readFileSync(path.resolve(__dirname, "staleness.ts"), "utf8")).toContain(
      "export function stalenessLabel(",
    );
    expect(fs.readFileSync(path.resolve(__dirname, "klineData.ts"), "utf8")).toContain(
      "export function toKlineData(",
    );
  });
});

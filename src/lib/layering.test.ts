import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Gate for the dependency direction of the front end.
 *
 * Two rules keep the module graph acyclic and the layers pointing one way:
 *
 *   1. A feature domain never imports `@/app/actions` (the app layer, which owns
 *      navigation and saving) nor `@/editor/setup` (which imports the feature
 *      extensions). Both made a cycle: footprint → app → editor/setup →
 *      footprint. The two remaining `import("@/app/actions")` inside
 *      `daily/open.ts` and `daily/capture.ts` are lazy, run inside a function,
 *      and stay allowed.
 *   2. The command layer never imports a component. Commands are the controller
 *      surface (menu, palette, keybindings); a component is a view. The switcher
 *      cycle goes through `lib/switcherSignal` instead.
 *
 * The compiler cannot see either rule — an import of the wrong direction still
 * typechecks — so it is checked here.
 */

const SRC = "src";

/** Feature domains: they own behaviour, never the app shell. */
const DOMAINS = ["daily", "footprint", "study", "code", "projects", "focus", "python", "state", "lib"];
/** The composition layer and the views: both may reach everything below them. */
const SHELL = ["app", "components", "dev", "editor", "commands"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Zone of a path: the domain/shell directory directly under src. */
function zoneOf(path: string): string {
  const [zone] = path.slice(SRC.length + 1).split("/");
  return zone;
}

/** Static `from "…"` specifiers only: a dynamic `import()` is a lazy edge by design. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g;
  for (const m of source.matchAll(re)) out.push(m[1]);
  return out;
}

const files = sourceFiles(SRC);

describe("a feature domain does not reach up into the app shell", () => {
  it("no domain imports the app actions or the editor assembly", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const zone = zoneOf(file);
      if (!DOMAINS.includes(zone)) continue;
      for (const spec of staticImports(readFileSync(file, "utf8"))) {
        if (spec === "@/app/actions" || spec === "@/editor/setup") {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the command layer does not import a component", () => {
  it("commands talk to views through signals, not imports", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.startsWith(`${SRC}/commands/`)) continue;
      for (const spec of staticImports(readFileSync(file, "utf8"))) {
        if (spec.startsWith("@/components/")) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the matcher sees what it must", () => {
  it("a static import is caught and a lazy one is not", () => {
    const sample = [
      'import { openNote } from "@/app/actions";',
      "const lazy = await import(\"@/app/actions\");",
    ].join("\n");
    expect(staticImports(sample)).toEqual(["@/app/actions"]);
  });
});

describe("the scan itself is not empty", () => {
  it("found the zones it is supposed to police", () => {
    const zones = new Set(files.map(zoneOf));
    for (const zone of [...DOMAINS, ...SHELL]) expect(zones).toContain(zone);
  });
});

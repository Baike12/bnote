import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The IPC contract has three handwritten copies: the Rust commands, the typed
 * boundary in `lib/tauri.ts` (and its callers) and the browser-mode bridge
 * (`devbridge.rs` + `browserMode.ts`). Nothing in the compiler sees a
 * mismatch, and every mismatch found so far was a real bug:
 *
 *  - `agent_start_session` sent a field the type did not declare (silently
 *    dropped by the boundary);
 *  - the `code-lsp-*` handlers ignored `root`, so the previous project's late
 *    events landed in the current one;
 *  - `creative-preview-updated` was never relayed in browser mode.
 *
 * These checks are structure only (names, not payload shapes): they catch a
 * command or event that exists on one side and not the other. The invocation
 * scan is compared against both the bridge arms and the `#[tauri::command]`
 * definitions, so a typo'd or orphaned command name fails `pnpm gate`
 * without needing a cargo run.
 */

const RUST = "src-tauri/src";
const SRC = "src";

/** Native menu/IME lifecycle events do not exist in browser mode: nothing to relay. */
const NATIVE_ONLY_EVENTS = new Set(["bnote:menu-quit", "bnote:ime-context-ready"]);
/**
 * Commands that drive a native child webview. In browser mode the placeholder
 * DOM element stands in for the webview and these calls are simply not made.
 */
const NATIVE_ONLY_COMMANDS = new Set([
  "show_study_preview",
  "set_study_preview_bounds",
  "set_study_preview_visible",
  "set_study_preview_annotation_mode",
  "set_study_preview_translate",
  "set_study_preview_read_step",
  "set_study_preview_read_keys",
  "set_study_preview_shortcuts",
  "set_study_preview_zoom",
  "focus_study_preview",
  "scroll_study_preview",
  "merge_study_preview_annotations",
  "close_study_preview",
  "open_study_url",
  "show_creative_preview",
  "set_creative_preview_bounds",
  "set_creative_preview_visible",
  "close_creative_preview",
]);

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, ext, out);
    else if (ext.test(entry.name)) out.push(path);
  }
  return out;
}

const rustSources = files(RUST, /\.rs$/).map((f) => readFileSync(f, "utf8"));
const tsSources = files(SRC, /\.tsx?$/).filter((f) => !/\.test\.tsx?$/.test(f));
const devbridge = readFileSync(join(RUST, "devbridge.rs"), "utf8");
const browserMode = readFileSync(join(SRC, "dev/browserMode.ts"), "utf8");

function emittedEvents(): string[] {
  const out = new Set<string>();
  for (const src of rustSources) {
    for (const m of src.matchAll(/\.emit\(\s*"([^"]+)"/g)) out.add(m[1]);
  }
  return [...out].sort();
}

/** The relay lists of both bridges: one block in each file, event names only. */
function relayed(name: "devbridge" | "browserMode"): string[] {
  const src = name === "devbridge" ? devbridge : browserMode;
  const start =
    name === "devbridge" ? src.indexOf("fn subscribe_events") : src.indexOf("const EVENTS = [");
  const block = src.slice(start, src.indexOf("]", start) + 1);
  return [...new Set([...block.matchAll(/"([a-z0-9:-]+)"/g)].map((m) => m[1]))].sort();
}

/**
 * Commands provided by a Tauri plugin binary (`plugin:clipboard-manager|…`),
 * not by our command surface. The old regex excluded these only by accident
 * (its `[a-z0-9_]+` could not span the `:`); the scanner below parses them,
 * so the exclusion is now explicit.
 */
function isPluginCommand(name: string): boolean {
  return name.includes(":");
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

/**
 * Every command name passed as a literal first argument to `invoke` across
 * the TS sources — `invoke("x")` and `invoke<T>("x")`, generics spanning
 * lines and nesting. A balanced mini-scanner instead of a single regex
 * because a regex like `invoke<[^>]*>\(` silently matches nothing on a
 * nested generic (`invoke<Record<string, number>>`), and a scanner that
 * quietly sees nothing is exactly the failure mode this file guards against.
 */
function invokedCommands(): string[] {
  const out = new Set<string>();
  const word = /[A-Za-z0-9_$]/;
  for (const f of tsSources) {
    const text = readFileSync(f, "utf8");
    let at = text.indexOf("invoke");
    while (at !== -1) {
      // Word boundaries on both sides: skip identifiers like `invokeOverHttp`
      // and prose that merely says "invoke".
      if (!word.test(text[at - 1] ?? "") && !word.test(text[at + 6] ?? "")) {
        let cursor = skipSpace(text, at + 6);
        // Optional generic argument list, balanced over <>, ignoring `=>`.
        if (text[cursor] === "<") {
          let depth = 0;
          while (cursor < text.length) {
            const ch = text[cursor];
            if (ch === "<") depth += 1;
            else if (ch === ">" && text[cursor - 1] !== "=") {
              depth -= 1;
              if (depth === 0) {
                cursor += 1;
                break;
              }
            }
            cursor += 1;
          }
          cursor = skipSpace(text, cursor);
        }
        if (text[cursor] === "(") {
          const m = /^"([a-z0-9_:-]+)"/.exec(text.slice(skipSpace(text, cursor + 1)));
          if (m) out.add(m[1]);
        }
      }
      at = text.indexOf("invoke", at + 6);
    }
  }
  return [...out].sort();
}

/**
 * Every `#[tauri::command]` function name under `src-tauri/src/commands`,
 * parsed the same way `src-tauri/tests/command_surface.rs` parses it
 * (attribute line, then the first `fn name` within a few lines, skipping cfg
 * attributes and doc comments). The Rust-side gate stays the authority on
 * definitions == registration == bridge arms; this copy only closes the
 * TS→Rust direction so `pnpm gate` sees a cross-language typo without cargo.
 */
function definedCommands(): string[] {
  const out = new Set<string>();
  for (const f of files(join(RUST, "commands"), /\.rs$/)) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() !== "#[tauri::command]") continue;
      for (let j = i + 1; j < Math.min(i + 9, lines.length); j += 1) {
        const m = /\bfn\s+([a-z0-9_]+)/.exec(lines[j]);
        if (m) {
          out.add(m[1]);
          break;
        }
      }
    }
  }
  return [...out].sort();
}

function dispatchedCommands(): string[] {
  return [...devbridge.matchAll(/^\s{8}"([a-z0-9_]+)" =>/gm)].map((m) => m[1]);
}

describe("events reach the browser-mode bridge", () => {
  it("every emitted event is relayed by devbridge and by browserMode", () => {
    const missing: string[] = [];
    const relayedDev = new Set(relayed("devbridge"));
    const relayedBrowser = new Set(relayed("browserMode"));
    for (const name of emittedEvents()) {
      if (NATIVE_ONLY_EVENTS.has(name)) continue;
      if (!relayedDev.has(name)) missing.push(`${name} (devbridge)`);
      if (!relayedBrowser.has(name)) missing.push(`${name} (browserMode)`);
    }
    expect(missing).toEqual([]);
  });

  it("the two relay lists hold the same names", () => {
    expect(relayed("browserMode")).toEqual(relayed("devbridge"));
  });

  it("no relay entry is dead: everything listed is emitted somewhere", () => {
    const emitted = new Set(emittedEvents());
    expect(relayed("devbridge").filter((n) => !emitted.has(n))).toEqual([]);
  });
});

describe("commands reach the browser-mode bridge", () => {
  it("every invoked command has a devbridge dispatch arm", () => {
    const arms = new Set(dispatchedCommands());
    const missing = invokedCommands().filter(
      (cmd) => !NATIVE_ONLY_COMMANDS.has(cmd) && !isPluginCommand(cmd) && !arms.has(cmd),
    );
    expect(missing).toEqual([]);
  });

  it("every invoked command is defined as a #[tauri::command] in Rust", () => {
    const defined = new Set(definedCommands());
    const missing = invokedCommands().filter((cmd) => !isPluginCommand(cmd) && !defined.has(cmd));
    expect(missing).toEqual([]);
  });

  it("the scan sees the three sides it is comparing", () => {
    expect(emittedEvents().length).toBeGreaterThan(5);
    expect(relayed("devbridge").length).toBeGreaterThan(5);
    expect(invokedCommands().length).toBeGreaterThan(50);
    expect(dispatchedCommands().length).toBeGreaterThan(50);
    expect(definedCommands().length).toBeGreaterThan(100);
  });
});

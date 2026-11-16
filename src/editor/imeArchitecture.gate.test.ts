import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * IME switching architecture gate (front-end half + the IPC boundary + the
 * backend half it depends on).
 *
 * A mode switch works only as one composed chain:
 *
 *   vim mode change -> imeSwitchExtension -> imeApply -> set_input_source
 *     -> TIS select in the helper process (out of the app's main thread)
 *     -> switched=true -> re-create the editor's web input context
 *
 * Every leg has a silent failure mode, and two of them have already been
 * removed by well-intentioned "simplifications" that compiled cleanly, passed
 * every functional test, and shipped a build where the menu bar switched while
 * the editor kept typing latin:
 *
 * - dropping the context re-mount leaves WebKit typing with the source it
 *   captured when the editor gained focus;
 * - moving the select back in-process freezes the UI thread for the whole TIS
 *   call (25-104 ms real-trace range) and, on macOS 26, does not reliably
 *   update the web view's context either.
 *
 * The compiler cannot see either contract, so this gate reads the sources. It
 * checks the Rust half too on purpose: the chain spans two languages, and the
 * everyday `pnpm gate` must fail when either half is broken, not only when the
 * other toolchain's suite runs.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, "utf8");

describe("the typing context follows a real switch", () => {
  const source = read("src/editor/imeSwitch.ts");

  it("only a confirmed switch (switched=true) touches the input context", () => {
    expect(source).toContain("if (!outcome.switched) return;");
    expect(source).toContain("applyInputContextSource(target)");
  });

  it("the source goes to the app's own context, not through a focus re-mount", () => {
    // The blur + focus re-mount was the earlier mechanism. It is indirect
    // (it re-captures whatever the context restores) and must not come back:
    // the context's source is set directly through AppKit.
    expect(source).not.toContain("refreshWebInputContext");
    expect(source).not.toContain("dom.blur()");
    expect(source).not.toContain("dom.focus(");
  });
});

describe("the switch is composed into the editor and the app shell", () => {
  it("the editor extension tree contains imeSwitchExtension()", () => {
    expect(read("src/editor/setup.ts")).toContain("imeSwitchExtension()");
  });

  it("the app shell warms the pipeline up and re-syncs on window blur/focus", () => {
    const app = read("src/App.tsx");
    expect(app).toContain("imeWarmUp()");
    expect(app).toContain("imeOnWindowBlur()");
    expect(app).toContain("imeOnWindowFocus()");
  });

  it("the IPC wrapper invokes the set_input_source command", () => {
    expect(read("src/lib/tauri.ts")).toContain('invoke<SetImeOutcome>("set_input_source"');
  });

  it("the IPC wrapper invokes the input-context hand-off command", () => {
    expect(read("src/lib/tauri.ts")).toContain('invoke<boolean>("apply_input_context_source"');
  });
});

describe("the backend half: the select runs in the helper process", () => {
  it("main detects the helper flag before any app initialization", () => {
    const main = read("src-tauri/src/main.rs");
    const helper = main.indexOf("maybe_run_helper");
    const run = main.indexOf("bnote_lib::run()");
    expect(helper).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(run);
  });

  it("the helper and the TIS layer stay declared", () => {
    const lib = read("src-tauri/src/lib.rs");
    expect(lib).toContain("pub mod ime_daemon;");
    expect(lib).toContain("pub mod ime_tis;");
  });

  it("the command layer only speaks the protocol — no TIS, no main-thread select", () => {
    const commands = read("src-tauri/src/commands/ime.rs");
    expect(commands).toContain("ime_daemon::with_client");
    for (const forbidden of ["TISSelectInputSource", "select_local"]) {
      expect(commands).not.toContain(forbidden);
    }
  });

  it("the app-side half hands the source to the input context", () => {
    const commands = read("src-tauri/src/commands/ime.rs");
    expect(commands).toContain("apply_input_context_source");
    expect(commands).toContain("ime_tis::apply_context_source");
    // NSTextInputContext.selectedKeyboardInputSource is the AppKit-level setter
    // that makes the web view type with the new source.
    expect(read("src-tauri/src/ime_tis.rs")).toContain("setSelectedKeyboardInputSource");
  });

  it("the helper drains its run loop so it sees source changes made by other processes", () => {
    const tis = read("src-tauri/src/ime_tis.rs");
    // The helper blocks on stdin and never runs a run loop; without the drain
    // HIToolbox keeps its per-process copy stale and `select` answers
    // "already active" in microseconds, never switching.
    expect(tis).toContain("run_in_mode");
    expect(tis).not.toContain("pub fn select_local");
  });

  it("the helper is long-lived and invisible (no second Dock icon)", () => {
    const daemon = read("src-tauri/src/ime_daemon.rs");
    expect(daemon).toContain("setActivationPolicy");
    expect(daemon).toContain("Accessory");
    expect(daemon).toContain("READ_TIMEOUT");
    expect(daemon).toContain("stdin.lock().lines()");
  });
});

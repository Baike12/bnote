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
 *     -> context hand-off first (app main thread, property transition)
 *     -> TIS select in the helper process (off the app's main thread)
 *
 * Both halves live in the one command on purpose: each can only run in its own
 * place (TIS in the helper, the process-local context in the app), and two
 * commands left a window where the menu bar had switched while the hand-off
 * was still an IPC hop away.
 *
 * Every leg has a silent failure mode, and two of them have already been
 * removed by well-intentioned "simplifications" that compiled cleanly, passed
 * every functional test, and shipped a build where the menu bar switched while
 * the editor kept typing latin:
 *
 * - dropping the context hand-off leaves WebKit typing with the source it
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

  it("one call per switch carries both halves; a miss is reported, not swallowed", () => {
    // The command name is the only IPC for a switch: a second call on top of it
    // re-opens the half-switched window.
    expect(source).toContain(".setInputSource(target)");
    expect(source).not.toContain("applyInputContextSource");
    // contextApplied=false is the old symptom (menu bar switched, typing did
    // not) and must reach the perf log and the console.
    expect(source).toContain("outcome.contextApplied === false");
    // `switched` reports whether the system source moved; with `ctx = -1` it
    // also tells that the select was deferred (menu bar unchanged, pending
    // for the next context-ready window update).
    expect(source).toContain('perfFields("tisMs", "ctxMs", "ctx", "switched")');
  });

  it("the system select waits for a confirmed context", () => {
    // Producing the half-switched state is not allowed: when the context
    // misses (`ctx = -1`/`0`), the helper must not move the system source.
    // The menu bar stays on the previous source and a one-shot AppKit update
    // watcher retries when a context exists.
    const commands = read("src-tauri/src/commands/ime.rs");
    const body = commands.slice(
      commands.indexOf("pub async fn set_input_source"),
      commands.indexOf("async fn hand_off_context"),
    );
    const guard = body.indexOf("system_select_allowed(handoff.applied)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("ime_daemon::with_client"));
    expect(body).toContain("switched: false");
  });

  it("a missed hand-off is a generation-stamped backend intent, not a timer", () => {
    // A timer that starts deactivating the context after 50ms can land on the
    // first typed character. The pending intent is settled by a native
    // context-ready event, and an older completion cannot erase a newer one.
    expect(source).not.toContain("scheduleContextVerify");
    const commands = read("src-tauri/src/commands/ime.rs");
    const tis = read("src-tauri/src/ime_tis.rs");
    expect(tis).toContain("IME_COORDINATOR");
    expect(tis).toContain("PendingContext");
    expect(commands).not.toContain("schedule_context_repair");
    expect(commands).not.toContain("std::thread::spawn");
    expect(commands).toContain("arm_context_ready_retry");
    expect(tis).toContain("watch_for_context_ready");
    expect(tis).toContain("NSWindowDidUpdateNotification");
    expect(tis).toContain("deferred_target");
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
    expect(app).toContain('listen("bnote:ime-context-ready"');
    expect(app).toContain("imeOnContextReady()");
    expect(read("src/editor/setup.ts")).toContain("imeOnEditorFocus()");
  });

  it("the IPC wrapper invokes the set_input_source command", () => {
    expect(read("src/lib/tauri.ts")).toContain('invoke<SetImeOutcome>("set_input_source"');
  });

  it("the IPC wrapper exposes no second hand-off command", () => {
    expect(read("src/lib/tauri.ts")).not.toContain("apply_input_context_source");
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

  it("the app-side context is handed the source before the menu-bar system select", () => {
    const commands = read("src-tauri/src/commands/ime.rs");
    expect(commands).toContain("ime_tis::apply_context_source");
    expect(commands).not.toContain("pub async fn apply_input_context_source");
    expect(read("src-tauri/src/ime_tis.rs")).toContain("setSelectedKeyboardInputSource");
    const body = commands.slice(
      commands.indexOf("pub async fn set_input_source"),
      commands.indexOf("async fn hand_off_context"),
    );
    const context = body.indexOf("hand_off_context");
    const helper = body.indexOf("ime_daemon::with_client");
    expect(context).toBeGreaterThan(-1);
    expect(helper).toBeGreaterThan(context);
  });

  it("the destructive session rebuild is recovery-only, not every switch", () => {
    const tis = read("src-tauri/src/ime_tis.rs");
    const recovery = tis.indexOf("if rebuild && already_selected");
    const deactivate = tis.indexOf("context.deactivate()");
    const pin = tis.indexOf("context.setSelectedKeyboardInputSource");
    const activate = tis.indexOf("context.activate()");
    expect(recovery).toBeGreaterThan(-1);
    expect(recovery).toBeLessThan(deactivate);
    expect(deactivate).toBeGreaterThan(-1);
    expect(deactivate).toBeLessThan(pin);
    expect(pin).toBeLessThan(activate);
    expect(tis).toContain("apply_context_source(id: &str, rebuild: bool)");
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

//! Architectural gate for IME switching (backend half).
//!
//! The switch works only because the TIS select runs in a **helper process**:
//! TIS asserts Apple's main queue, in the app that queue is the UI thread, and
//! real traces show 25-104 ms per select. The helper is also long-lived (its
//! TIS reference cache and initialization stay warm), drains its run loop (so
//! it sees source changes made by other processes), stays out of the Dock, and
//! self-heals by being discarded when a request fails.
//!
//! These halves have already been reverted once by an edit that compiled,
//! passed every functional test, and shipped a build where the menu bar
//! switched while the editor kept typing latin. The compiler cannot see the
//! contract, so this gate reads the sources. The front-end half of the same
//! contract is locked by `src/editor/imeArchitecture.gate.test.ts`.

use std::fs;
use std::path::Path;

fn read(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn index_of(source: &str, needle: &str) -> usize {
    source
        .find(needle)
        .unwrap_or_else(|| panic!("`{needle}` is missing from the source"))
}

#[test]
fn main_detects_the_helper_before_any_app_initialization() {
    let main = read("src/main.rs");
    assert!(
        index_of(&main, "maybe_run_helper") < index_of(&main, "bnote_lib::run()"),
        "the helper flag must be handled before ANY Tauri/app initialization"
    );
}

#[test]
fn the_module_surface_keeps_the_helper_and_the_tis_layer() {
    let lib = read("src/lib.rs");
    assert!(
        lib.contains("pub mod ime_daemon;"),
        "the helper module is gone"
    );
    assert!(lib.contains("pub mod ime_tis;"), "the TIS module is gone");
}

#[test]
fn the_command_layer_only_speaks_the_protocol() {
    let commands = read("src/commands/ime.rs");
    assert!(
        commands.contains("ime_daemon::with_client"),
        "set_input_source must delegate the select to the helper process"
    );
    for forbidden in ["TISSelectInputSource", "select_local"] {
        assert!(
            !commands.contains(forbidden),
            "`{forbidden}` in the command layer: an in-process select freezes the UI \
             thread for the whole TIS call (25-104 ms real-trace range)"
        );
    }
}

#[test]
fn one_command_carries_both_halves_of_the_switch() {
    let commands = read("src/commands/ime.rs");
    assert!(
        commands.contains("pub async fn set_input_source"),
        "set_input_source is the switch's only entry point"
    );
    assert!(
        commands.contains("ime_tis::apply_context_source"),
        "the same command must rebuild the app's input method session after the helper's select"
    );
    assert!(
        !commands.contains("pub async fn apply_input_context_source"),
        "a second hand-off command re-opens the window where the system source has \
         switched while the session rebuild is still an IPC hop away — that window \
         is what shipped builds where the menu bar changed and typing did not"
    );
    assert!(
        !commands.contains("TISSelectInputSource"),
        "the TIS select stays in the helper process"
    );
    assert!(
        read("src/ime_tis.rs").contains("setSelectedKeyboardInputSource"),
        "the hand-off pins the source on NSTextInputContext while the session is \
         detached; writing the property on an attached context is a no-op"
    );
}

#[test]
fn a_missed_hand_off_is_reconciled_even_without_a_system_switch() {
    let commands = read("src/commands/ime.rs");
    // The context and the system source are different authorities. Skipping
    // the hand-off whenever the system reports "already active" leaves WebKit
    // typing with the old IME after one miss — every normal-mode key then pays
    // that IME's round trip (felt as j/k lag, invisible to the JS key probe).
    assert!(
        commands.contains("CONTEXT_STALE"),
        "the command must remember a missed hand-off and reconcile the context \
         on the next command even when the system source did not change"
    );
    assert!(
        commands.contains("schedule_context_repair"),
        "when no input context exists yet (window activating), the hand-off must \
         be retried; the front end cannot observe that state"
    );
    assert!(
        read("src/ime_tis.rs").contains("pub fn apply_context_source(id: &str) -> Option<bool>"),
        "apply_context_source must distinguish 'no context' (None) from 'the \
         rebuild missed' (Some(false)): the two have different owners"
    );
}

#[test]
fn the_hand_off_rebuilds_the_input_method_session() {
    let tis = read("src/ime_tis.rs");
    let deactivate = index_of(&tis, "context.deactivate()");
    let pin = index_of(&tis, "context.setSelectedKeyboardInputSource");
    let activate = index_of(&tis, "context.activate()");
    assert!(
        deactivate < pin && pin < activate,
        "the hand-off must deactivate, pin the source, then activate: \
         setSelectedKeyboardInputSource alone is a no-op once AppKit has \
         mirrored the system-wide change (the property already equals the \
         target), so the input method session is never rebuilt and typing \
         follows only by timing luck — measured at about half the switches"
    );
}

#[test]
fn the_helper_sees_source_changes_made_by_other_processes() {
    let tis = read("src/ime_tis.rs");
    assert!(
        tis.contains("run_in_mode"),
        "current_source_id must drain the run loop: the helper blocks on stdin and \
         HIToolbox only refreshes its per-process copy from run-loop notifications, \
         so without the drain `select` answers \"already active\" and never switches"
    );
    assert!(
        !tis.contains("pub fn select_local"),
        "an in-process select variant must not come back"
    );
}

#[test]
fn the_helper_is_long_lived_self_healing_and_invisible() {
    let daemon = read("src/ime_daemon.rs");
    assert!(
        daemon.contains("setActivationPolicy") && daemon.contains("Accessory"),
        "the helper re-executes this binary and must withdraw from the Dock \
         (accessory policy); otherwise it checks in as a second foreground app"
    );
    assert!(
        daemon.contains("READ_TIMEOUT"),
        "a wedged helper must be discarded on timeout"
    );
    assert!(
        daemon.contains("stdin.lock().lines()"),
        "the helper is long-lived: it serves the line protocol until stdin EOF"
    );
}

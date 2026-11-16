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
fn context_is_prepared_before_the_system_source_changes() {
    let commands = read("src/commands/ime.rs");
    assert!(
        commands.contains("pub async fn set_input_source"),
        "set_input_source is the switch's only entry point"
    );
    assert!(
        commands.contains("ime_tis::apply_context_source"),
        "the same command must hand the source to the app's input context"
    );
    assert!(
        !commands.contains("pub async fn apply_input_context_source"),
        "a second hand-off command re-opens the window where the context and the \
         menu bar are updated by different asynchronous request chains"
    );
    assert!(
        !commands.contains("TISSelectInputSource"),
        "the TIS select stays in the helper process"
    );
    assert!(
        read("src/ime_tis.rs").contains("setSelectedKeyboardInputSource"),
        "the app must update its own NSTextInputContext before the helper changes \
         the system source"
    );
    let start = index_of(&commands, "pub async fn set_input_source");
    let end = index_of(&commands, "async fn hand_off_context");
    let body = &commands[start..end];
    assert!(
        index_of(body, "hand_off_context") < index_of(body, "ime_daemon::with_client"),
        "the app context must be ready before the menu bar can advertise the switch"
    );
}

#[test]
fn the_system_select_waits_for_a_confirmed_context() {
    let commands = read("src/commands/ime.rs");
    let start = index_of(&commands, "pub async fn set_input_source");
    let end = index_of(&commands, "async fn hand_off_context");
    let body = &commands[start..end];
    let guard = index_of(body, "system_select_allowed(handoff.applied)");
    assert!(
        guard < index_of(body, "ime_daemon::with_client"),
        "the helper select must run only after the context accepted the target; \
         a miss leaves the system source and the menu bar on the previous source"
    );
    assert!(
        body.contains("switched: false"),
        "the deferred path must report that the system source did not move"
    );
}

#[test]
fn a_missed_hand_off_is_a_generation_stamped_pending_intent() {
    let commands = read("src/commands/ime.rs");
    let tis = read("src/ime_tis.rs");
    assert!(
        tis.contains("IME_COORDINATOR") && tis.contains("PendingContext"),
        "the native IME layer must remember a missed context with its generation and target"
    );
    assert!(
        !commands.contains("schedule_context_repair") && !commands.contains("std::thread::spawn"),
        "a delayed repair can tear down the context on the first typed character; \
         pending intent must be retried by the next context-ready window update"
    );
    assert!(
        commands.contains("arm_context_ready_retry")
            && tis.contains("watch_for_context_ready")
            && tis.contains("NSWindowDidUpdateNotification")
            && tis.contains("deferred_target"),
        "a deferred intent needs a one-shot AppKit window-update watcher; a focus \
         event can have already happened before the context exists"
    );
    assert!(
        read("src/ime_tis.rs")
            .contains("pub fn apply_context_source(id: &str, rebuild: bool) -> Option<bool>"),
        "apply_context_source must distinguish a missing context from a failed \
         property transition and keep rebuild as an explicit recovery mode"
    );
}

#[test]
fn the_hand_off_rebuilds_the_input_method_session_only_for_recovery() {
    let tis = read("src/ime_tis.rs");
    let recovery = index_of(&tis, "if rebuild && already_selected");
    let deactivate = index_of(&tis, "context.deactivate()");
    let pin = index_of(&tis, "context.setSelectedKeyboardInputSource");
    let activate = index_of(&tis, "context.activate()");
    assert!(
        recovery < deactivate && deactivate < pin && pin < activate,
        "the destructive deactivate/pin/activate sequence must stay behind the \
         recovery branch; running it on every mode switch blocks the next key"
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

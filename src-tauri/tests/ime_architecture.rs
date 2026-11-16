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
    for forbidden in ["TISSelectInputSource", "select_local", "run_on_main_thread"] {
        assert!(
            !commands.contains(forbidden),
            "`{forbidden}` in the command layer: an in-process select freezes the UI \
             thread for the whole TIS call (25-104 ms real-trace range)"
        );
    }
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

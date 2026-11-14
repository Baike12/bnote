// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The IME helper is this same binary re-executed with a flag; it must be
    // detected before ANY app initialization (no Tauri, no windows, no
    // single-instance hand-off) — see ime_daemon.
    #[cfg(target_os = "macos")]
    {
        let argv: Vec<String> = std::env::args().collect();
        if bnote_lib::ime_daemon::maybe_run_helper(&argv) {
            return;
        }
    }
    bnote_lib::run()
}

//! Guard rail: the app window is looked up by label only.
//!
//! `get_webview_window` answers only when every webview attached to the window
//! carries the window's own label (`tauri-2.11.5/src/window/mod.rs:1160`,
//! `is_webview_window`). bnote attaches child webviews ("study-preview",
//! "creative-preview") to the main window for study mode and the agent preview,
//! so the call returned `None` whenever a page was open. Focus mode used it and
//! both sides broke: locking failed with `NO_WINDOW`, and unlocking returned
//! "ok" without restoring, leaving the window above every other app.
//!
//! `crate::main_window` (and `get_webview` for the standalone preview window)
//! are plain label lookups on the window/webview tables, which no child webview
//! can affect.

use std::fs;
use std::path::{Path, PathBuf};

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn the_app_window_is_never_looked_up_as_a_webview_window() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rs_files(&src, &mut files);
    assert!(
        !files.is_empty(),
        "no sources found under {}",
        src.display()
    );

    let mut offenders = Vec::new();
    for file in files {
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            let trimmed = line.trim_start();
            // Documentation may mention the call; only real code is forbidden.
            if trimmed.starts_with("//") {
                continue;
            }
            if line.contains("get_webview_window(") {
                offenders.push(format!("{}:{}", file.display(), index + 1));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "use crate::main_window (or get_webview) instead of get_webview_window: \
         child webviews make it return None\n{}",
        offenders.join("\n"),
    );
}

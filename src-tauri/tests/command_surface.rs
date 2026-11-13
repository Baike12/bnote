//! Structural gates for the IPC command surface.
//!
//! The compiler cannot see a forgotten `generate_handler!` entry or a typo in
//! the browser-mode bridge: the command still compiles, and the failure only
//! surfaces when a user invokes it. These tests compare the three sources of
//! truth by parsing the source files:
//!
//!   #[tauri::command] definitions  ==  generate_handler![]  ==  devbridge arms
//!
//! `set_input_source` is defined twice under mutually exclusive `cfg` targets,
//! so definitions are compared as a set of names.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn function_name(line: &str) -> Option<String> {
    let index = line.find("fn ")?;
    let after = &line[index + 3..];
    let name: String = after
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// Every `#[tauri::command]` function under `src/commands`, mapped to the
/// files that define it (a cfg-alternative pair may define the same name).
fn defined_commands(src: &Path) -> BTreeMap<String, Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_rust_files(&src.join("commands"), &mut files);

    let mut defined: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for file in files {
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        let lines: Vec<&str> = text.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            // The signature may be preceded by `#[cfg(...)]` and doc comments.
            for candidate in lines.iter().skip(index + 1).take(8) {
                if let Some(name) = function_name(candidate) {
                    defined.entry(name).or_default().push(file.clone());
                    break;
                }
            }
        }
    }
    defined
}

fn registered_commands(src: &Path) -> Vec<String> {
    let text = fs::read_to_string(src.join("lib.rs")).expect("lib.rs is readable");
    let marker = "generate_handler![";
    let start = text
        .find(marker)
        .expect("lib.rs registers commands through generate_handler!");
    let rest = &text[start + marker.len()..];
    let end = rest
        .find("])")
        .expect("generate_handler![] has a closing bracket");
    rest[..end]
        .lines()
        .filter_map(|line| {
            let entry = line.trim().trim_end_matches(',');
            entry
                .strip_prefix("commands::")
                .map(|path| path.rsplit("::").next().unwrap_or(path).to_string())
        })
        .collect()
}

/// Command names the browser dev bridge dispatches (or explicitly rejects as
/// native-only). Arms sit at exactly one indentation level inside `dispatch`;
/// nested `match` arms are deeper and are not part of the command surface.
fn bridged_commands(src: &Path) -> BTreeSet<String> {
    let text = fs::read_to_string(src.join("devbridge.rs")).expect("devbridge.rs is readable");
    let start = text
        .find("async fn dispatch")
        .expect("devbridge.rs has a dispatch function");
    let end = text[start..]
        .find("\nfn arg_str(")
        .map(|offset| start + offset)
        .expect("dispatch is followed by arg_str");
    let region = &text[start..end];

    let mut names = BTreeSet::new();
    for line in region.lines() {
        if !line.starts_with("        \"") && !line.starts_with("        |") {
            continue;
        }
        let arm = line.split("=>").next().unwrap_or(line);
        for name in arm.split('"').skip(1).step_by(2) {
            names.insert(name.to_string());
        }
    }
    names
}

#[test]
fn every_defined_command_is_registered() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let defined = defined_commands(&src);
    let registered: BTreeSet<String> = registered_commands(&src).into_iter().collect();

    assert!(
        defined.len() >= 100,
        "the definition scan found only {} commands; the parser probably missed the attribute",
        defined.len()
    );

    let missing: Vec<&String> = defined
        .keys()
        .filter(|name| !registered.contains(*name))
        .collect();
    assert!(
        missing.is_empty(),
        "commands defined but missing from generate_handler![]: {missing:?}"
    );
}

#[test]
fn every_registered_command_is_defined() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let registered = registered_commands(&src);
    let defined = defined_commands(&src);

    let mut seen = BTreeSet::new();
    let duplicates: Vec<&String> = registered
        .iter()
        .filter(|name| !seen.insert((*name).clone()))
        .collect();
    assert!(
        duplicates.is_empty(),
        "commands registered more than once: {duplicates:?}"
    );

    let stale: Vec<&String> = registered
        .iter()
        .filter(|name| !defined.contains_key(*name))
        .collect();
    assert!(
        stale.is_empty(),
        "generate_handler![] entries with no #[tauri::command] definition: {stale:?}"
    );
}

#[test]
fn browser_bridge_matches_the_command_surface() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let registered: BTreeSet<String> = registered_commands(&src).into_iter().collect();
    let bridged = bridged_commands(&src);

    assert!(
        bridged.len() >= 100,
        "the bridge scan found only {} commands; the parser probably missed the arms",
        bridged.len()
    );

    let unknown: Vec<&String> = bridged.difference(&registered).collect();
    assert!(
        unknown.is_empty(),
        "devbridge dispatches command names that are not registered (typo or stale arm): {unknown:?}"
    );

    let unbridged: Vec<&String> = registered.difference(&bridged).collect();
    assert!(
        unbridged.is_empty(),
        "registered commands without a browser-mode arm (add the command to dispatch, \
         even if only to reject it as native-only): {unbridged:?}"
    );
}

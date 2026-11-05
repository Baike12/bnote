//! Guard rail: the asset protocol may read only directories the user opened.
//!
//! `app.security.assetProtocol.scope` is the only thing between the webview and
//! `asset://localhost/<any path>`: it used to be `**`, which made every path
//! check in `paths.rs` and `code::project::resolve_in` decorative. The static
//! scope is now just the app data directory, and the vault / code project are
//! granted at the moment they are opened.
//!
//! Neither half is enforced by the compiler, so this test pins both: widening
//! the static scope back to the whole filesystem, or dropping the runtime grant
//! from an open path, fails here instead of silently reopening the hole.

use std::path::Path;

fn manifest(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
        .unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

#[test]
fn the_static_scope_does_not_allow_the_whole_filesystem() {
    let raw = manifest("tauri.conf.json");
    let config: serde_json::Value =
        serde_json::from_str(&raw).expect("tauri.conf.json is valid JSON");
    let enabled = config["app"]["security"]["assetProtocol"]["enable"]
        .as_bool()
        .unwrap_or(false);
    assert!(enabled, "the asset protocol must stay enabled: images render through it");

    let scope = config["app"]["security"]["assetProtocol"]["scope"]
        .as_array()
        .expect("assetProtocol.scope is an array");
    let patterns: Vec<&str> = scope.iter().filter_map(|v| v.as_str()).collect();
    assert!(!patterns.is_empty(), "an empty scope would break every image");

    for pattern in patterns {
        let wide = pattern == "**" || pattern == "/**" || pattern == "$HOME/**" || pattern == "*";
        assert!(
            !wide,
            "asset scope {pattern:?} exposes the whole filesystem; grant the opened root at runtime instead"
        );
    }
}

#[test]
fn opening_a_root_grants_it_to_the_asset_protocol() {
    let vault = manifest("src/commands/vault.rs");
    assert!(
        vault.contains("allow_asset_dir(app, &root)"),
        "set_vault must grant the vault to the asset protocol, or images stop rendering"
    );
    let code = manifest("src/commands/code.rs");
    assert!(
        code.contains("allow_asset_dir(&app, &root)"),
        "code_open_project must grant the repository to the asset protocol"
    );
}

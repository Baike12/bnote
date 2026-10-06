//! `keybindings.json` — the Tauri shell's override file, read at startup and
//! rewritten by the settings modal's hotkeys tab (TS
//! `src/commands/keybindingOverrides.ts`).
//!
//! The file lives in the data dir and maps a command id to
//! `"cmd-k" | null | ["cmd-a", "cmd-b"]`, where `null` removes every default
//! binding of that command. Both shells' keystroke spellings are accepted on
//! read (`Mod-Shift-a` from the TS app, `cmd-shift-a` from here) and the
//! canonical gpui spelling is written back — CM6 reads `cmd-` too, so the file
//! stays portable in both directions.

use std::collections::BTreeMap;

use ::gpui::{App, KeyBinding, Keystroke};
use bnote_core::state::AppState;

use crate::commands::COMMANDS;

/// Set while the settings modal's hotkeys tab is capturing a keystroke.
///
/// The capture itself takes every key (`stop_propagation`), and this flag is
/// what keeps the *editor* out of it too: the vim and snippet bridges check it
/// and stand down, so a captured `x` rebinds instead of deleting a character.
#[derive(Default)]
pub struct HotkeyCaptureActive(pub bool);

impl gpui::Global for HotkeyCaptureActive {}

impl HotkeyCaptureActive {
    /// True while a capture is in flight (the global is unset before the
    /// first capture, which reads as "not capturing").
    pub fn active(cx: &App) -> bool {
        cx.try_global::<Self>().is_some_and(|state| state.0)
    }

    pub fn set(cx: &mut App, active: bool) {
        cx.set_global(Self(active));
    }
}

/// Command id → its bindings. An empty vec means "unbound" (the file's
/// `null`), which is distinct from "no override" (absent).
pub type Overrides = BTreeMap<String, Vec<String>>;

/// Read the file's JSON shape into overrides. Unknown ids are kept: the
/// registry may grow, and dropping a user's line silently would lose data.
pub fn parse_overrides(value: &serde_json::Value) -> Overrides {
    let mut out = Overrides::new();
    let Some(map) = value.as_object() else {
        return out;
    };
    for (id, entry) in map {
        let keys: Vec<String> = match entry {
            serde_json::Value::Null => Vec::new(),
            serde_json::Value::String(key) => normalize_key(key).into_iter().collect(),
            serde_json::Value::Array(items) => items
                .iter()
                .filter_map(|item| item.as_str())
                .filter_map(normalize_key)
                .collect(),
            _ => continue,
        };
        out.insert(id.clone(), keys);
    }
    out
}

/// The override file's JSON shape: `null` for unbound, one string for a single
/// binding, an array for several.
pub fn overrides_to_json(overrides: &Overrides) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (id, keys) in overrides {
        let value = match keys.as_slice() {
            [] => serde_json::Value::Null,
            [one] => serde_json::Value::String(one.clone()),
            many => serde_json::Value::Array(
                many.iter().map(|k| serde_json::Value::String(k.clone())).collect(),
            ),
        };
        map.insert(id.clone(), value);
    }
    serde_json::Value::Object(map)
}

/// One keystroke in gpui's canonical spelling, or `None` for something neither
/// shell can bind (the TS file's `"Mod-"` without a key, a stray name).
///
/// TS spellings map onto gpui's: `Mod`/`Meta`/`Cmd`/`Super` → `cmd`, `Ctrl` →
/// `ctrl`, `Alt`/`Option` → `alt`, `Space` → `space`; the modifier order is
/// normalized so two spellings of one chord compare equal.
pub fn normalize_key(raw: &str) -> Option<String> {
    let (mods, key) = split_chord(raw)?;
    // gpui's own `unparse` order (fn, ctrl, alt, cmd, shift): the canonical
    // form written to the file is the string the engine prints back.
    let mut parts: Vec<String> = Vec::new();
    if mods.ctrl {
        parts.push("ctrl".to_string());
    }
    if mods.alt {
        parts.push("alt".to_string());
    }
    if mods.platform {
        parts.push("cmd".to_string());
    }
    if mods.shift {
        parts.push("shift".to_string());
    }
    parts.push(key);
    let spelled = parts.join("-");
    // The parser is the arbiter of what is bindable at all.
    Keystroke::parse(&spelled).ok()?;
    Some(spelled)
}

/// The modifiers and the key of a chord, from either shell's spelling.
///
/// The key is normalized (lower-cased, `Space` → `space`), the modifiers are
/// flags — writing the parts back in one fixed order is what makes the two
/// spellings of a chord compare equal.
fn split_chord(raw: &str) -> Option<(Mods, String)> {
    let (head, key) = if let Some(head) = raw.strip_suffix("--") {
        // A trailing `-` is the literal minus key (`Mod--`, gpui's `cmd--`).
        (head, "-".to_string())
    } else if raw.ends_with('-') && raw.len() > 1 {
        // `Mod-` with nothing after it: not a binding.
        return None;
    } else {
        let (head, key) = raw.rsplit_once('-')?;
        (head, key.to_ascii_lowercase())
    };
    if key.is_empty() {
        return None;
    }
    let mut mods = Mods::default();
    for part in head.split('-').filter(|part| !part.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "cmd" | "meta" | "mod" | "super" => mods.platform = true,
            "ctrl" | "control" => mods.ctrl = true,
            "alt" | "option" => mods.alt = true,
            "shift" => mods.shift = true,
            _ => return None,
        }
    }
    Some((mods, key))
}

#[derive(Default, Clone, Copy)]
struct Mods {
    shift: bool,
    ctrl: bool,
    alt: bool,
    platform: bool,
}

/// A keystroke as the settings list shows it (TS `formatBinding`): `⌘⇧A` on
/// macOS, `Ctrl+Shift+A` elsewhere.
pub fn format_binding(key: &str) -> String {
    let Some((mods, key)) = split_chord(key) else {
        return key.to_string();
    };
    let single = |key: &str| {
        if key.chars().count() == 1 {
            key.to_ascii_uppercase()
        } else {
            key.to_string()
        }
    };
    if cfg!(target_os = "macos") {
        // The TS order (`Mod-Shift-Alt-Ctrl`), so the chips read exactly like
        // the Tauri shell's: ⌘⇧A.
        let mut out = String::new();
        if mods.platform {
            out.push('⌘');
        }
        if mods.shift {
            out.push('⇧');
        }
        if mods.alt {
            out.push('⌥');
        }
        if mods.ctrl {
            out.push('⌃');
        }
        out.push_str(&single(&key));
        out
    } else {
        let mut parts: Vec<String> = Vec::new();
        if mods.platform {
            parts.push("Ctrl".to_string());
        }
        if mods.ctrl {
            parts.push("Ctrl".to_string());
        }
        if mods.alt {
            parts.push("Alt".to_string());
        }
        if mods.shift {
            parts.push("Shift".to_string());
        }
        parts.push(single(&key));
        parts.join("+")
    }
}

/// Every command's effective bindings: the registry defaults, with an override
/// replacing (or removing) them. Pure — the registry, the settings list and
/// the conflict check all read this one table.
pub fn effective_bindings(overrides: &Overrides) -> BTreeMap<&'static str, Vec<String>> {
    let mut out = BTreeMap::new();
    for def in COMMANDS {
        let keys = match overrides.get(def.id) {
            Some(keys) => keys.clone(),
            None => def.key.map(|k| vec![k.to_string()]).unwrap_or_default(),
        };
        out.insert(def.id, keys);
    }
    out
}

/// The commands that would lose a binding if `key` were assigned to
/// `except_id` — the TS conflict rule (the swept command is set to `null`).
pub fn commands_holding_key(
    overrides: &Overrides,
    key: &str,
    except_id: &str,
) -> Vec<&'static str> {
    effective_bindings(overrides)
        .into_iter()
        .filter(|(id, keys)| *id != except_id && keys.iter().any(|k| k == key))
        .map(|(id, _)| id)
        .collect()
}

/// Load the overrides file; a missing or broken file means "all defaults".
pub fn load(state: &AppState) -> Overrides {
    bnote_core::commands::config::load_keybindings(state)
        .ok()
        .flatten()
        .map(|value| parse_overrides(&value))
        .unwrap_or_default()
}

/// Write the overrides file (pretty-printed, like the TS shell).
pub fn save(state: &AppState, overrides: &Overrides) -> Result<(), String> {
    bnote_core::commands::config::save_keybindings(state, overrides_to_json(overrides))
}

/// Rebuild this app's own slice of the keymap: the registry defaults with the
/// overrides applied on top.
///
/// gpui's only way to remove a binding is clearing the whole map, and the kit's
/// components (the palette's list, the menus) register their own keys, so the
/// rebuild keeps every binding that is not ours and re-adds ours from scratch.
/// That is what makes a reset or an unbind actually take effect — an add-only
/// scheme would leave the previous binding live.
pub fn apply(cx: &mut App, overrides: &Overrides) {
    let ours: Vec<String> = COMMANDS
        .iter()
        .filter_map(|def| crate::commands::action_for(def.id).map(|action| action.name().to_string()))
        .collect();
    let keymap = cx.key_bindings();
    let kept: Vec<KeyBinding> = keymap
        .borrow()
        .bindings()
        .filter(|binding| !ours.contains(&binding.action().name().to_string()))
        .cloned()
        .collect();
    let mut bindings = kept;
    bindings.extend(our_bindings(overrides));
    cx.clear_key_bindings();
    cx.bind_keys(bindings);
}

/// Every binding this app owns under `overrides`.
fn our_bindings(overrides: &Overrides) -> Vec<KeyBinding> {
    let mut bindings = Vec::new();
    for def in COMMANDS {
        let keys = match overrides.get(def.id) {
            Some(keys) => keys.clone(),
            None => def.key.map(|k| vec![k.to_string()]).unwrap_or_default(),
        };
        for key in keys {
            if let Some(binding) = crate::commands::keybinding_for(def.id, &key) {
                bindings.push(binding);
            }
        }
    }
    bindings
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both shells' spellings of the same chord normalize to one canonical
    /// form — that is what keeps `keybindings.json` portable.
    #[test]
    fn ts_and_gpui_spellings_converge() {
        assert_eq!(normalize_key("Mod-Shift-a").as_deref(), Some("cmd-shift-a"));
        assert_eq!(normalize_key("cmd-shift-a").as_deref(), Some("cmd-shift-a"));
        assert_eq!(normalize_key("Mod-k").as_deref(), Some("cmd-k"));
        assert_eq!(normalize_key("Ctrl-m").as_deref(), Some("ctrl-m"));
        assert_eq!(normalize_key("Mod-\\").as_deref(), Some("cmd-\\"));
        assert_eq!(normalize_key("Mod-`").as_deref(), Some("cmd-`"));
        assert_eq!(normalize_key("Mod-Enter").as_deref(), Some("cmd-enter"));
        // The literal minus: `Mod--` is cmd and the key `-`.
        assert_eq!(normalize_key("Mod--").as_deref(), Some("cmd--"));
        assert_eq!(normalize_key("cmd--").as_deref(), Some("cmd--"));
        // Anything unparsable is dropped rather than silently bound elsewhere.
        assert_eq!(normalize_key("Mod-"), None);
        assert_eq!(normalize_key("Hyper-x"), None);
        assert_eq!(normalize_key("mod-x-y"), None);
    }

    /// The file round-trips: null → unbound, a string → one binding, an array
    /// → several, and the values keep the canonical spelling.
    #[test]
    fn the_file_round_trips_through_json() {
        let value = serde_json::json!({
            "workspace.save-note": null,
            "edit.toggle-bold": "Mod-Shift-b",
            "nav.quick-switcher": ["Mod-o", "Mod-Shift-o"],
            "view.zoom-in": 3,
        });
        let overrides = parse_overrides(&value);
        assert_eq!(overrides["workspace.save-note"], Vec::<String>::new());
        assert_eq!(overrides["edit.toggle-bold"], ["cmd-shift-b"]);
        assert_eq!(overrides["nav.quick-switcher"], ["cmd-o", "cmd-shift-o"]);
        assert!(!overrides.contains_key("view.zoom-in"), "a number is not a binding");

        let json = overrides_to_json(&overrides);
        assert_eq!(json["workspace.save-note"], serde_json::Value::Null);
        assert_eq!(json["edit.toggle-bold"], "cmd-shift-b");
        assert_eq!(
            json["nav.quick-switcher"],
            serde_json::json!(["cmd-o", "cmd-shift-o"])
        );
    }

    /// Defaults, overrides and unbindings resolve into one effective table.
    #[test]
    fn the_effective_table_follows_the_registry_defaults() {
        let defaults = effective_bindings(&Overrides::new());
        assert_eq!(defaults["workspace.save-note"], ["cmd-s"]);
        assert_eq!(defaults["workspace.new-folder"], Vec::<String>::new());
        assert_eq!(defaults["edit.toggle-bold"], ["cmd-b"]);
        assert_eq!(defaults["view.zoom-in"], ["cmd-="]);

        let mut overrides = Overrides::new();
        overrides.insert("workspace.save-note".to_string(), Vec::new());
        overrides.insert("edit.toggle-bold".to_string(), vec!["ctrl-b".to_string()]);
        let effective = effective_bindings(&overrides);
        assert!(effective["workspace.save-note"].is_empty(), "null unbinds the default");
        assert_eq!(effective["edit.toggle-bold"], ["ctrl-b"], "the override replaces it");
        assert_eq!(effective["nav.quick-switcher"], ["cmd-o"], "its neighbours are untouched");

        assert_eq!(effective_bindings(&overrides)["edit.toggle-bold"], ["ctrl-b"]);
    }

    /// The conflict check reads the *effective* table, so a default that was
    /// unbound no longer counts as a conflict.
    #[test]
    fn conflicts_are_read_off_the_effective_table() {
        let mut overrides = Overrides::new();
        overrides.insert("edit.toggle-bold".to_string(), Vec::new());
        assert_eq!(
            commands_holding_key(&overrides, "cmd-b", "nav.quick-switcher"),
            Vec::<&str>::new(),
            "the only holder was unbound"
        );

        let overrides = Overrides::new();
        assert_eq!(commands_holding_key(&overrides, "cmd-t", "x"), ["nav.header-todos"]);
        assert_eq!(
            commands_holding_key(&overrides, "cmd-o", "nav.quick-switcher"),
            Vec::<&str>::new(),
            "the command asking for the key is not its own conflict"
        );
    }

    /// The display form is the TS one: symbols on macOS, `+`-joined elsewhere.
    #[test]
    fn the_display_form_is_the_ts_one() {
        if cfg!(target_os = "macos") {
            assert_eq!(format_binding("cmd-shift-a"), "⌘⇧A");
            assert_eq!(format_binding("cmd-\\"), "⌘\\");
            assert_eq!(format_binding("shift-cmd-;"), "⌘⇧;");
            assert_eq!(format_binding("cmd-enter"), "⌘enter");
            assert_eq!(format_binding("cmd--"), "⌘-");
        } else {
            assert_eq!(format_binding("cmd-shift-a"), "Ctrl+Shift+A");
        }
    }
}

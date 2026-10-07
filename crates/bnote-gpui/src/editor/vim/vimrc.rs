//! `vimrc`: the mapping subset the Tauri shell parses (`src/editor/vim/vimrc.ts`)
//! and the pure table the bridge resolves keystrokes through.
//!
//! Supported commands: `map`/`noremap` (normal + visual), `nmap`/`nnoremap`,
//! `imap`/`inoremap`, `vmap`/`vnoremap`, `xmap`/`xnoremap`, the matching
//! `unmap` forms, `set clipboard=unnamed`, and `"` comments. An `lhs`/`rhs` may
//! use vim notation (`<C-s>`, `<Esc>`, `<CR>`, `<Space>`, `<Tab>`, `<BS>`,
//! arrows); an `rhs` that starts with `:` is a bnote command (`:w`,
//! `:Bnote <command-id>`), resolved through the same aliases as the Tauri
//! shell. Anything else is reported as a line-numbered error instead of being
//! dropped silently.

use super::core::Key;

/// The modes a mapping applies to (vim's select/operator-pending have no
/// equivalent here).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MapMode {
    Normal,
    Insert,
    Visual,
}

/// One mapping, parsed.
#[derive(Clone, Debug, PartialEq)]
pub struct Mapping {
    pub lhs: Vec<Key>,
    /// Key sequence to replay, empty when [`Self::command`] is set.
    pub rhs: Vec<Key>,
    /// bnote command id for `:ex`-style right-hand sides.
    pub command: Option<String>,
    /// `noremap`: the right-hand side is fed straight to the engine instead of
    /// being expanded through the mapping table again.
    pub noremap: bool,
    pub mode: MapMode,
}

/// A parsed vimrc: mappings, the lines that did not parse, and the one `set`
/// flag the editor honors.
#[derive(Default, Debug)]
pub struct Vimrc {
    pub mappings: Vec<Mapping>,
    pub errors: Vec<String>,
    pub clipboard_unnamed: bool,
}

/// The `:ex` aliases the Tauri shell defines (`vimrc.ts`'s `EX_ALIASES`).
const EX_ALIASES: &[(&str, &str)] = &[
    ("w", "workspace.save-note"),
    ("write", "workspace.save-note"),
    ("wq", "workspace.save-note-and-close"),
    ("x", "workspace.save-note-and-close"),
    ("q", "workspace.close-window"),
    ("q!", "workspace.close-window"),
    ("quit", "workspace.close-window"),
    ("noh", "editor.clear-search-highlight"),
    ("nohlsearch", "editor.clear-search-highlight"),
];

fn ex_alias(name: &str) -> Option<&'static str> {
    EX_ALIASES.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

/// The modes a mapping command covers, vim-style — bare `map`/`noremap` apply
/// to normal *and* visual; the prefixed forms narrow it.
fn modes_of(command: &str) -> &'static [MapMode] {
    const BOTH: &[MapMode] = &[MapMode::Normal, MapMode::Visual];
    const NORMAL: &[MapMode] = &[MapMode::Normal];
    const INSERT: &[MapMode] = &[MapMode::Insert];
    const VISUAL: &[MapMode] = &[MapMode::Visual];
    match command {
        "map" | "noremap" => BOTH,
        "imap" | "inoremap" => INSERT,
        "vmap" | "vnoremap" | "xmap" | "xnoremap" => VISUAL,
        _ => NORMAL,
    }
}

const MAP_COMMANDS: &[&str] = &[
    "map", "noremap", "nmap", "nnoremap", "imap", "inoremap", "vmap", "vnoremap", "xmap",
    "xnoremap",
];

const UNMAP_COMMANDS: &[&str] = &["unmap", "nunmap", "iunmap", "vunmap", "xunmap"];

/// `"` starts a full-line comment; a trailing comment follows whitespace
/// (`line " note`).
fn strip_comment(line: &str) -> &str {
    if line.trim_start().starts_with('"') {
        return "";
    }
    match line.find(" \"") {
        Some(ix) => &line[..ix],
        None => line,
    }
}

/// Parse a vimrc into mappings plus the errors for the lines it could not take.
pub fn parse_vimrc(source: &str) -> Vimrc {
    let mut out = Vimrc::default();
    for (index, raw) in source.lines().enumerate() {
        let line_no = index + 1;
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let command = parts.next().unwrap_or_default();

        if command == "set" {
            // `set clipboard=unnamed` wires yank/put to the system clipboard;
            // other options are accepted silently (the Tauri shell does the
            // same).
            let option = parts.next().unwrap_or_default();
            if let Some(value) = option.strip_prefix("clipboard=") {
                if value.split(',').any(|v| v == "unnamed") {
                    out.clipboard_unnamed = true;
                }
            }
            continue;
        }

        if UNMAP_COMMANDS.contains(&command) {
            let lhs = parts.collect::<Vec<_>>().join(" ");
            let modes: &[MapMode] = match command {
                "iunmap" => &[MapMode::Insert],
                "vunmap" | "xunmap" => &[MapMode::Visual],
                "nunmap" => &[MapMode::Normal],
                _ => &[MapMode::Normal, MapMode::Visual],
            };
            let Ok(lhs) = notation_to_keys(&lhs) else {
                out.errors.push(format!("line {line_no}: unsupported keys: {lhs}"));
                continue;
            };
            let before = out.mappings.len();
            out.mappings
                .retain(|m| !(m.lhs == lhs && modes.contains(&m.mode)));
            if out.mappings.len() == before {
                out.errors.push(format!("line {line_no}: unmap: no mapping for {lhs:?}"));
            }
            continue;
        }

        if MAP_COMMANDS.contains(&command) {
            let rest = line[command.len()..].trim();
            let Some((lhs, rhs)) = rest.split_once(char::is_whitespace) else {
                out.errors.push(format!("line {line_no}: cannot parse: {line}"));
                continue;
            };
            let rhs = rhs.trim();
            let Ok(lhs_keys) = notation_to_keys(lhs) else {
                out.errors.push(format!("line {line_no}: unsupported keys: {lhs}"));
                continue;
            };
            if lhs.contains("<leader>") {
                out.errors.push(format!("line {line_no}: unsupported <leader> mapping: {lhs}"));
                continue;
            }
            let (rhs_keys, rhs_command) = if let Some(ex) = rhs.strip_prefix(':') {
                (Vec::new(), Some(ex_command(ex)))
            } else {
                match notation_to_keys(rhs) {
                    Ok(keys) => (keys, None),
                    Err(e) => {
                        out.errors.push(format!("line {line_no}: {e}"));
                        continue;
                    }
                }
            };
            let noremap = command.contains("nore");
            for mode in modes_of(command) {
                out.mappings.push(Mapping {
                    lhs: lhs_keys.clone(),
                    rhs: rhs_keys.clone(),
                    command: rhs_command.clone(),
                    noremap,
                    mode: *mode,
                });
            }
            continue;
        }

        out.errors.push(format!("line {line_no}: unsupported vimrc command: {command}"));
    }
    out
}

/// `:w<CR>` / `:Bnote nav.toggle-sidebar<CR>` → the command id to run.
pub(crate) fn ex_command(text: &str) -> String {
    let name = text
        .trim_end_matches(|c: char| c == '\r')
        .strip_suffix("<CR>")
        .or_else(|| text.strip_suffix("<Cr>"))
        .unwrap_or_else(|| text.trim_end_matches("<CR>"))
        .trim();
    let name = match name.strip_suffix('!') {
        Some(base) if ex_alias(base).is_none() => base,
        _ => name,
    };
    // `:Bnote <id>` is the documented form; a bare id is accepted directly.
    let name = match name.strip_prefix("Bnote") {
        Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim(),
        _ => name,
    };
    ex_alias(name).unwrap_or(name).to_string()
}

/// Vim key notation → the core's keys: printable chars pass through, `<...>`
/// names cover the specials and ctrl chords.
pub fn notation_to_keys(text: &str) -> Result<Vec<Key>, String> {
    let mut keys = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '<' {
            keys.push(Key::Char(c));
            continue;
        }
        let mut name = String::new();
        let mut closed = false;
        for c in chars.by_ref() {
            if c == '>' {
                closed = true;
                break;
            }
            name.push(c);
        }
        if !closed {
            return Err(format!("unterminated <...> in {text:?}"));
        }
        keys.push(notation_key(&name)?);
    }
    if keys.is_empty() {
        return Err(format!("empty mapping for {text:?}"));
    }
    Ok(keys)
}

/// One `<...>` name. Case-insensitive, like vim's own `<>` notation.
fn notation_key(name: &str) -> Result<Key, String> {
    let lower = name.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("c-") {
        let mut chars = rest.chars();
        return match (chars.next(), chars.next()) {
            (Some(c), None) => Ok(Key::Ctrl(c)),
            _ => Err(format!("unsupported ctrl key <{name}>")),
        };
    }
    Ok(match lower.as_str() {
        "esc" | "escape" => Key::Escape,
        "cr" | "enter" | "return" => Key::Enter,
        "bs" | "backspace" => Key::Backspace,
        "del" | "delete" => Key::Delete,
        "tab" => Key::Tab,
        "space" => Key::Char(' '),
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "leader" => return Err("<leader> is not supported".to_string()),
        _ => return Err(format!("unsupported key <{name}>")),
    })
}

/// The live mapping table: resolved in insertion order, later entries winning
/// for the same `mode` + `lhs` (so the vault vimrc overrides the global one).
#[derive(Default, Debug)]
pub struct Mappings {
    entries: Vec<Mapping>,
}

/// What one keystroke does to the mapping table.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Resolution {
    /// A mapping completed: run `entries[ix]`.
    Fire(usize),
    /// The key(s) so far are a prefix of at least one mapping: wait.
    Hold,
    /// Nothing can match: the caller feeds the buffered keys literally.
    Literal,
}

impl Mappings {
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Install mappings with vim's `:map` semantics: same mode + lhs replaces.
    pub fn install(&mut self, mappings: &[Mapping]) {
        for mapping in mappings {
            self.entries
                .retain(|m| !(m.mode == mapping.mode && m.lhs == mapping.lhs));
            self.entries.push(mapping.clone());
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entry(&self, ix: usize) -> Option<&Mapping> {
        self.entries.get(ix)
    }

    /// Resolve `pending ++ [key]` in `mode`. An exact match wins immediately
    /// (vim would wait out `timeoutlen` for a longer match; this port takes the
    /// shorter one at once), a proper prefix holds, anything else is literal.
    pub fn resolve(&self, mode: MapMode, pending: &[Key], key: Key) -> Resolution {
        let mut buffer: Vec<Key> = pending.to_vec();
        buffer.push(key);
        if let Some(ix) = self
            .entries
            .iter()
            .position(|m| m.mode == mode && m.lhs == buffer)
        {
            return Resolution::Fire(ix);
        }
        if self
            .entries
            .iter()
            .any(|m| m.mode == mode && m.lhs.len() > buffer.len() && m.lhs.starts_with(&buffer))
        {
            return Resolution::Hold;
        }
        Resolution::Literal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(s: &str) -> Vec<Key> {
        notation_to_keys(s).expect("notation")
    }

    /// The Tauri shell's own examples: key mappings, command mappings, the
    /// mode fan-out of bare `map`, and the `set clipboard=unnamed` flag.
    #[test]
    fn the_parser_takes_the_ts_subset() {
        let source = "\
\" a comment
imap jj <Esc>
nmap <C-s> :w<CR>
nmap <C-b> :Bnote nav.toggle-sidebar<CR>
noremap r $
noremap q 0
vnoremap r $
nnoremap J <C-d>
set clipboard=unnamed
set number
";
        let parsed = parse_vimrc(source);
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        assert!(parsed.clipboard_unnamed);

        let find = |mode: MapMode, lhs: &str| {
            parsed
                .mappings
                .iter()
                .find(|m| m.mode == mode && m.lhs == keys(lhs))
                .unwrap_or_else(|| panic!("no {mode:?} mapping for {lhs}"))
        };
        assert_eq!(find(MapMode::Insert, "jj").rhs, vec![Key::Escape]);
        assert!(!find(MapMode::Insert, "jj").noremap, "imap is remappable");

        let save = find(MapMode::Normal, "<C-s>");
        assert_eq!(save.lhs, vec![Key::Ctrl('s')]);
        assert_eq!(save.command.as_deref(), Some("workspace.save-note"));
        assert!(save.rhs.is_empty());

        let sidebar = find(MapMode::Normal, "<C-b>");
        assert_eq!(sidebar.command.as_deref(), Some("nav.toggle-sidebar"));

        assert_eq!(find(MapMode::Normal, "r").rhs, vec![Key::Char('$')]);
        assert!(find(MapMode::Normal, "r").noremap);
        assert_eq!(find(MapMode::Visual, "r").rhs, vec![Key::Char('$')]);
        assert_eq!(find(MapMode::Normal, "J").rhs, vec![Key::Ctrl('d')]);

        // Bare `map` covers normal and visual; the prefixed forms narrow it.
        let wide = parse_vimrc("map zz :w<CR>");
        assert_eq!(wide.mappings.len(), 2);
        assert!(wide.mappings.iter().all(|m| m.command.as_deref() == Some("workspace.save-note")));
        let narrow = parse_vimrc("nmap zz :w<CR>");
        assert_eq!(narrow.mappings.len(), 1);
        assert_eq!(narrow.mappings[0].mode, MapMode::Normal);
    }

    /// Errors are reported per line and never drop the rest of the file.
    #[test]
    fn unparsable_lines_are_reported_with_their_line() {
        let parsed = parse_vimrc("noremap jj\nbogus thing\nmap <leader>x :w<CR>\nnmap ok <Nope>\n");
        assert_eq!(parsed.errors.len(), 4, "{:?}", parsed.errors);
        assert!(parsed.errors[0].starts_with("line 1: cannot parse"));
        assert!(parsed.errors[1].contains("unsupported vimrc command: bogus"));
        assert!(parsed.errors[2].contains("<leader>"));
        assert!(parsed.errors[3].contains("<Nope>"));
        assert!(parsed.mappings.is_empty());
    }

    /// `unmap` removes the mapping the corresponding `map` installed — and
    /// reports an unknown mapping instead of failing silently.
    #[test]
    fn unmap_removes_what_map_installed() {
        let parsed = parse_vimrc("map zz <Esc>\nunmap zz\n");
        assert!(parsed.mappings.is_empty(), "{:?}", parsed.mappings);
        assert!(parsed.errors.is_empty());

        // Bare `unmap` covers normal + visual, so it removes a normal-only
        // mapping too — and reports an lhs nothing installed.
        let parsed = parse_vimrc("nnoremap zz <Esc>\nunmap zz\n");
        assert!(parsed.mappings.is_empty());
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        let parsed = parse_vimrc("unmap zz\n");
        assert!(parsed.errors[0].contains("no mapping"), "{:?}", parsed.errors);

        let parsed = parse_vimrc("inoremap jj <Esc>\niunmap jj\n");
        assert!(parsed.mappings.is_empty());
        assert!(parsed.errors.is_empty());
    }

    /// The command aliases and the `:Bnote <id>` / bare-id forms.
    #[test]
    fn ex_aliases_match_the_ts_table() {
        assert_eq!(ex_command("w<CR>"), "workspace.save-note");
        assert_eq!(ex_command("write"), "workspace.save-note");
        assert_eq!(ex_command("wq<CR>"), "workspace.save-note-and-close");
        assert_eq!(ex_command("q!<CR>"), "workspace.close-window");
        assert_eq!(ex_command("Bnote nav.toggle-sidebar<CR>"), "nav.toggle-sidebar");
        assert_eq!(ex_command("nav.toggle-sidebar"), "nav.toggle-sidebar");
        assert_eq!(ex_command("noh<CR>"), "editor.clear-search-highlight");
    }

    /// The table's resolution: exact match fires, a proper prefix holds, and
    /// anything else is literal. Later installs (the vault file) win.
    #[test]
    fn resolution_fires_holds_or_falls_through() {
        let parsed = parse_vimrc("imap jj <Esc>\nnoremap r $\nnoremap rr 0\n");
        let mut table = Mappings::default();
        table.install(&parsed.mappings);

        // `jj` in insert mode.
        assert_eq!(table.resolve(MapMode::Insert, &[], Key::Char('j')), Resolution::Hold);
        let fire = table.resolve(MapMode::Insert, &[Key::Char('j')], Key::Char('j'));
        assert!(matches!(fire, Resolution::Fire(_)));
        let ix = match fire {
            Resolution::Fire(ix) => ix,
            _ => unreachable!(),
        };
        assert_eq!(table.entry(ix).unwrap().rhs, vec![Key::Escape]);

        // `r` fires at once; `rr` is a different mapping and both live.
        assert!(matches!(
            table.resolve(MapMode::Normal, &[], Key::Char('r')),
            Resolution::Fire(_)
        ));

        // Nothing maps `Z`; `j` alone in normal mode is not a mapping.
        assert_eq!(table.resolve(MapMode::Normal, &[], Key::Char('Z')), Resolution::Literal);
        assert_eq!(table.resolve(MapMode::Normal, &[], Key::Char('j')), Resolution::Literal);
        // `x` after a held `j` breaks the prefix: literal.
        assert_eq!(
            table.resolve(MapMode::Insert, &[Key::Char('j')], Key::Char('x')),
            Resolution::Literal
        );

        // The vault file overrides the global one for the same mode + lhs.
        let vault = parse_vimrc("imap jj <C-[>\n");
        table.install(&vault.mappings);
        let ix = match table.resolve(MapMode::Insert, &[Key::Char('j')], Key::Char('j')) {
            Resolution::Fire(ix) => ix,
            other => panic!("expected a fire, got {other:?}"),
        };
        assert_eq!(table.entry(ix).unwrap().rhs, vec![Key::Ctrl('[')]);

        table.clear();
        assert!(table.is_empty());
    }
}

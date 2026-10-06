//! bnote's theme: the palette the Tauri shell defines in
//! `src/styles/global.css`, ported as data so the GPUI shell paints the same
//! colors.
//!
//! The CSS file is the **single source of truth** (bnote's `theme.test.ts`
//! enforces the same rule on the web side): `:root` is dark,
//! `[data-theme="light"]` overrides the whole set, and every rule body uses
//! variables only. Here the same variables are transcribed into [`DARK`] /
//! [`LIGHT`] and the parity test (`tests/data/bnote-theme.css`, a byte-for-byte
//! copy of that file) asserts every value — a change on either side that the
//! other does not follow fails the build.
//!
//! [`apply`] writes the palette into gpui-kit's [`Theme`] (so every kit
//! component — buttons, lists, scrollbars — matches bnote) and registers the
//! full set as a global for the shell's own views.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use gpui::{App, Global, Hsla, SharedString, rgba};
use gpui_kit::component::highlighter::{HighlightTheme, HighlightThemeStyle};
use gpui_kit::component::theme::{Theme, ThemeMode};

pub const DARK: &[(&str, &str)] = &[
    ("bg0", "#0b0b0d"),
    ("bg1", "#101013"),
    ("bg2", "#17171a"),
    ("bg3", "#212125"),
    ("border", "#27272c"),
    ("text", "#d8d8da"),
    ("text-dim", "#9a9aa0"),
    ("text-faint", "#67676d"),
    ("accent", "#f5a83c"),
    ("accent-dim", "#c07d24"),
    ("accent-soft", "#3a2c16"),
    ("danger", "#e06c75"),
    ("danger-soft", "#4a2a2e"),
    ("ok", "#7ec97e"),
    ("string", "#98c379"),
    ("keyword", "#c678dd"),
    (r#"font-ui"#, r#"-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif"#),
    ("font-text", "var(--font-ui)"),
    (r#"font-mono"#, r#""Iosevka", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace"#),
    ("link", "#79a9ec"),
    ("h1-color", "#e87d3e"),
    ("h2-color", "#3eb4bf"),
    ("h3-color", "#2e80f2"),
    ("h4-color", "#e5b567"),
    ("h5-color", "#e83e3e"),
    ("h6-color", "#98a2ad"),
    ("strong-color", "#ff82b2"),
    ("tok-comment", "#7f848e"),
    ("tok-number", "#d19a66"),
    ("tok-func", "#61afef"),
    ("tok-type", "#e5c07b"),
    ("tok-var", "#e06c75"),
    ("tok-operator", "#56b6c2"),
    ("tok-punct", "#abb2bf"),
    ("tok-invalid", "#f66"),
    ("sel", "rgba(255, 255, 255, 0.22)"),
    ("sel-hint", "rgba(255, 255, 255, 0.1)"),
    ("search-match", "#5a4a2f80"),
    ("search-match-active", "#8a6d3b90"),
    ("code-inline-bg", "#26262c"),
    ("code-block-bg", "#1a1a1f"),
    ("scrollbar-thumb", "#34343a"),
    ("hover-strong", "#444"),
    ("toggle-knob", "#eee"),
    ("on-accent", "#fff"),
    ("on-accent-muted", "#ffffffbb"),
    ("scrim", "#00000088"),
    ("shadow", "#000000aa"),
    ("image-bg", "#fff"),
    ("editor-font-size", "16px"),
    ("content-line-width", "700px"),
    ("content-pad-x", "48px"),
    ("latex-bracket-0", "#527aff"),
    ("latex-bracket-1", "#ff50b7"),
    ("latex-bracket-2", "#69ba00"),
];

pub const LIGHT: &[(&str, &str)] = &[
    ("bg0", "#ffffff"),
    ("bg1", "#f7f7f8"),
    ("bg2", "#ffffff"),
    ("bg3", "#ececee"),
    ("border", "#e3e3e7"),
    ("text", "#23262b"),
    ("text-dim", "#6c7078"),
    ("text-faint", "#9a9ea6"),
    ("accent", "#a3670d"),
    ("accent-dim", "#8a570b"),
    ("accent-soft", "#f3e7cd"),
    ("danger", "#c93636"),
    ("danger-soft", "#f6e2e3"),
    ("ok", "#3d8f43"),
    ("string", "#50a14f"),
    ("keyword", "#a626a4"),
    ("link", "#3d7fd9"),
    ("h1-color", "#c25a1e"),
    ("h2-color", "#1e8a94"),
    ("h3-color", "#1c62cc"),
    ("h4-color", "#9a6b12"),
    ("h5-color", "#cc2f2f"),
    ("h6-color", "#6b7683"),
    ("strong-color", "#c94f8c"),
    ("tok-comment", "#a0a1a7"),
    ("tok-number", "#b76b01"),
    ("tok-func", "#4078f2"),
    ("tok-type", "#c18401"),
    ("tok-var", "#e45649"),
    ("tok-operator", "#0184bc"),
    ("tok-punct", "#383a42"),
    ("tok-invalid", "#e45649"),
    ("sel", "rgba(0, 0, 0, 0.16)"),
    ("sel-hint", "rgba(0, 0, 0, 0.07)"),
    ("search-match", "#e8c66a80"),
    ("search-match-active", "#d9a83f90"),
    ("code-inline-bg", "#ececef"),
    ("code-block-bg", "#f6f6f8"),
    ("scrollbar-thumb", "#c9c9ce"),
    ("hover-strong", "#dcdcdf"),
    ("toggle-knob", "#ffffff"),
    ("on-accent", "#ffffff"),
    ("on-accent-muted", "#ffffffcc"),
    ("scrim", "#00000052"),
    ("shadow", "#00000038"),
    ("image-bg", "#ffffff"),
    ("latex-bracket-0", "#527aff"),
    ("latex-bracket-1", "#ff50b7"),
    ("latex-bracket-2", "#69ba00"),
];

/// The font stacks `--font-ui` / `--font-mono` name, in CSS order. GPUI needs
/// one installed family, so [`apply`] picks the first of these the machine
/// has (an uninstalled family panics GPUI's first text layout).
pub const FONT_MONO_CANDIDATES: &[&str] =
    &["Iosevka", "JetBrains Mono", "SF Mono", "Menlo", "Consolas"];

/// bnote's palette for one mode.
#[derive(Clone, Debug, PartialEq)]
pub struct Palette {
    colors: BTreeMap<&'static str, Hsla>,
    /// `--editor-font-size` in px.
    pub editor_font_size: f32,
    /// `--content-line-width` in px (the reading column).
    pub content_line_width: f32,
    /// `--content-pad-x` in px.
    pub content_pad_x: f32,
}

impl Palette {
    /// The numeric metrics (`--editor-font-size`, `--content-line-width`,
    /// `--content-pad-x`) are declared in `:root` only: the light block
    /// overrides colors and CSS inherits the rest, so both palettes take the
    /// numbers from [`DARK`].
    fn from_table(table: &'static [(&'static str, &'static str)]) -> Palette {
        let mut colors = BTreeMap::new();
        for (name, value) in table {
            if let Some(color) = parse_color(value) {
                colors.insert(*name, color);
            }
        }
        let px = |name: &str| -> f32 {
            [table, DARK]
                .iter()
                .find_map(|candidate| candidate.iter().find(|(key, _)| *key == name))
                .and_then(|(_, value)| value.strip_suffix("px"))
                .and_then(|value| value.trim().parse().ok())
                .unwrap_or(0.)
        };
        Palette {
            colors,
            editor_font_size: px("editor-font-size"),
            content_line_width: px("content-line-width"),
            content_pad_x: px("content-pad-x"),
        }
    }

    pub fn dark() -> &'static Palette {
        static DARK_PALETTE: OnceLock<Palette> = OnceLock::new();
        DARK_PALETTE.get_or_init(|| Palette::from_table(DARK))
    }

    pub fn light() -> &'static Palette {
        static LIGHT_PALETTE: OnceLock<Palette> = OnceLock::new();
        LIGHT_PALETTE.get_or_init(|| Palette::from_table(LIGHT))
    }

    pub fn for_mode(mode: ThemeMode) -> &'static Palette {
        match mode {
            ThemeMode::Light => Palette::light(),
            ThemeMode::Dark => Palette::dark(),
        }
    }

    /// A palette entry by its CSS variable name without the `--`
    /// (e.g. `"bg0"`, `"h2-color"`, `"tok-number"`). Panics on an unknown name:
    /// every name the shell uses appears in the parity test.
    pub fn color(&self, var: &str) -> Hsla {
        *self
            .colors
            .get(var)
            .unwrap_or_else(|| panic!("unknown palette variable: {var}"))
    }

    /// `--h1-color` … `--h6-color` (1-based like the CSS).
    pub fn heading(&self, level: usize) -> Hsla {
        self.color(&format!("h{}-color", level.clamp(1, 6)))
    }

    /// A syntax token color: `token("number")` → `--tok-number`.
    pub fn token(&self, name: &str) -> Hsla {
        self.color(&format!("tok-{name}"))
    }

    /// `--latex-bracket-{i}`, i in 0..3 (the latex-suite three-color cycle).
    pub fn bracket(&self, i: usize) -> Hsla {
        self.color(&format!("latex-bracket-{}", i % 3))
    }

    /// The raw color values, for the parity test.
    #[cfg(test)]
    fn raw_hex(&self, var: &str) -> Option<Hsla> {
        self.colors.get(var).copied()
    }
}

/// The active palette, for the shell's own views (`Palette::global(cx)`).
#[derive(Clone, Debug)]
pub struct ActivePalette(pub &'static Palette);

impl Global for ActivePalette {}

/// Writes bnote's palette into the global theme and registers it.
///
/// Call it **after** `Theme::change` (which loads a built-in theme and would
/// overwrite the colors) and again whenever the mode changes.
pub fn apply(mode: ThemeMode, cx: &mut App) {
    let palette = Palette::for_mode(mode);
    Theme::update(cx, |theme| {
        let bg0 = palette.color("bg0");
        let bg1 = palette.color("bg1");
        let bg2 = palette.color("bg2");
        let bg3 = palette.color("bg3");
        let border = palette.color("border");
        let text = palette.color("text");
        let text_dim = palette.color("text-dim");
        let accent = palette.color("accent");
        let accent_soft = palette.color("accent-soft");
        let danger = palette.color("danger");
        let ok = palette.color("ok");
        let link = palette.color("link");
        let on_accent = palette.color("on-accent");
        let hover_strong = palette.color("hover-strong");
        let scrollbar_thumb = palette.color("scrollbar-thumb");

        let c = &mut theme.colors;
        c.background = bg0;
        c.foreground = text;
        c.muted_foreground = text_dim;
        c.muted = palette.color("text-faint");
        c.border = border;
        c.window_border = border;
        c.accent = accent;
        c.accent_foreground = on_accent;
        c.primary = accent;
        c.primary_foreground = on_accent;
        c.primary_hover = palette.color("accent-dim");
        c.primary_active = palette.color("accent-dim");
        c.danger = danger;
        c.danger_foreground = on_accent;
        c.danger_hover = danger;
        c.danger_active = danger;
        c.success = ok;
        c.success_foreground = on_accent;
        c.warning = palette.color("h4-color");
        c.warning_foreground = on_accent;
        c.info = link;
        c.info_foreground = on_accent;
        c.link = link;
        c.link_hover = link;
        c.link_active = link;
        c.popover = bg2;
        c.popover_foreground = text;
        c.overlay = bg2;
        c.sidebar = bg1;
        c.sidebar_foreground = text;
        c.sidebar_border = border;
        c.sidebar_accent = accent;
        c.sidebar_accent_foreground = on_accent;
        c.sidebar_primary = accent;
        c.sidebar_primary_foreground = on_accent;
        c.input = bg0;
        c.caret = accent;
        c.selection = palette.color("sel");
        c.scrollbar = bg1;
        c.scrollbar_thumb = scrollbar_thumb;
        c.scrollbar_thumb_hover = hover_strong;
        c.list = bg1;
        c.list_hover = bg3;
        c.list_active = accent_soft;
        c.list_active_border = accent;
        c.list_even = bg1;
        c.list_head = bg1;
        c.tab = bg1;
        c.tab_active = bg0;
        c.tab_foreground = text_dim;
        c.tab_active_foreground = text;
        c.tab_bar = bg1;
        c.tab_bar_segmented = bg2;
        c.table = bg0;
        c.table_head = bg2;
        c.table_even = bg1;
        c.table_hover = bg3;
        c.table_active = accent_soft;
        c.table_active_border = accent;
        c.table_row_border = border;
        c.status_bar = bg1;
        c.status_bar_border = border;
        c.title_bar = bg1;
        c.title_bar_border = border;
        c.button = bg2;
        c.button_hover = bg3;
        c.button_active = hover_strong;
        c.button_foreground = text;
        c.button_primary = accent;
        c.button_primary_foreground = on_accent;
        c.button_primary_hover = palette.color("accent-dim");
        c.button_primary_active = palette.color("accent-dim");
        c.button_secondary = bg2;
        c.button_secondary_foreground = text;
        c.button_secondary_hover = bg3;
        c.button_secondary_active = hover_strong;
        c.button_danger = danger;
        c.button_danger_foreground = on_accent;
        c.button_danger_hover = danger;
        c.button_danger_active = danger;
        c.secondary = bg2;
        c.secondary_foreground = text;
        c.secondary_hover = bg3;
        c.secondary_active = hover_strong;
        c.switch = bg3;
        c.switch_thumb = palette.color("toggle-knob");
        c.slider_bar = bg3;
        c.slider_thumb = palette.color("toggle-knob");
        c.progress_bar = accent;
        c.ring = accent;
        c.skeleton = bg3;
        c.group_box = bg1;
        c.group_box_foreground = text;
        c.accordion = bg1;
        c.description_list_label = bg2;
        c.description_list_label_foreground = text_dim;
        c.drag_border = accent;
        c.drop_target = accent_soft;
        c.table_foot = bg2;
        c.table_foot_foreground = text_dim;
        c.table_head_foreground = text;
        c.button_info = link;
        c.button_info_foreground = on_accent;
        c.button_info_hover = link;
        c.button_info_active = link;
        c.button_success = ok;
        c.button_success_foreground = on_accent;
        c.button_success_hover = ok;
        c.button_success_active = ok;
        c.button_warning = palette.color("h4-color");
        c.button_warning_foreground = on_accent;
        c.button_warning_hover = palette.color("h4-color");
        c.button_warning_active = palette.color("h4-color");
        // The chart / named-hue slots stand in for bnote's syntax colors so
        // kit components that reach for them stay in the palette.
        c.red = palette.color("tok-var");
        c.red_light = palette.color("tok-var");
        c.green = palette.color("string");
        c.green_light = palette.color("string");
        c.blue = palette.color("tok-func");
        c.blue_light = palette.color("tok-func");
        c.yellow = palette.color("tok-type");
        c.yellow_light = palette.color("tok-type");
        c.magenta = palette.color("keyword");
        c.magenta_light = palette.color("keyword");
        c.cyan = palette.color("tok-operator");
        c.cyan_light = palette.color("tok-operator");
        c.chart_bullish = palette.color("string");
        c.chart_bearish = danger;
        c.chart_grid = border;
    });

    // Fonts: bnote's UI stack is the system UI font; the monospace stack needs
    // one installed family (see FONT_MONO_CANDIDATES).
    let mono = installed_mono_family(cx);
    let font_size = palette.editor_font_size;
    Theme::update(cx, |theme| {
        theme.font_family = ".SystemUIFont".into();
        theme.mono_font_family = mono;
        theme.font_size = gpui::px(font_size);
        theme.mono_font_size = gpui::px(font_size * 0.95);
        // Syntax highlighting: the editor resolves tree-sitter captures
        // through this theme, so each capture gets the colour its TS class
        // used.
        theme.highlight_theme = std::sync::Arc::new(highlight_theme(palette, mode));
    });

    cx.set_global(ActivePalette(palette));
}

/// bnote's syntax highlighting, built from the same palette.
///
/// The TS shell coloured markdown through its own classes (`md-hmark`,
/// `md-inline-code`, `md-link`, …); the GPUI editor highlights through
/// tree-sitter captures, so each capture the engine's queries use gets the
/// variable its TS class used. The captures are those of the engine's
/// `markdown` / `markdown_inline` queries
/// (`crates/component/src/highlighter/languages/…/highlights.scm`).
///
/// Names outside the engine's 41-slot table fall back to their `.` prefix
/// (`keyword.function` → `keyword`), so this only needs the top-level names.
pub fn highlight_theme(palette: &Palette, appearance: ThemeMode) -> HighlightTheme {
    use gpui_kit::component::highlighter::{SyntaxColors, ThemeStyle};

    let text = palette.color("text");
    let faint = palette.color("text-faint");
    let link = palette.color("link");
    let strong = palette.color("strong-color");
    let syntax = SyntaxColors {
        // `#` runs, quote markers and setext underlines (TS `md-hmark`'s dim).
        punctuation_special: Some(ThemeStyle::color(faint)),
        // ``` fences and the emphasis/code-span delimiters.
        punctuation_delimiter: Some(ThemeStyle::color(faint)),
        // List markers and `---` (TS `md-listmark`).
        punctuation_list_marker: Some(ThemeStyle::color(faint)),
        // Heading text. The capture carries no level, so this is the body
        // colour in bold; the live-preview heading marks paint the per-level
        // colour on top.
        title: Some(ThemeStyle::color(text).bold()),
        // Fenced-code bodies keep the body colour (their background is a line
        // style).
        text_literal: Some(ThemeStyle::color(text)),
        // `[label](url)` (TS `md-link` / `md-url`).
        link_text: Some(ThemeStyle::color(link)),
        link_uri: Some(ThemeStyle::color(link)),
        // Inline code spans (TS `md-inline-code`, `--tok-number`).
        text_code_span: Some(ThemeStyle::color(palette.token("number"))),
        // `\x` escapes render as plain text in the TS.
        string_escape: Some(ThemeStyle::color(text)),
        // `*x*` / `**x**` (TS `md-em` / `md-strong`).
        emphasis: Some(ThemeStyle::color(strong).italic()),
        emphasis_strong: Some(ThemeStyle::color(strong).bold()),
        ..Default::default()
    };
    HighlightTheme {
        name: "bnote".to_string(),
        appearance,
        style: HighlightThemeStyle {
            // The current-line shade (TS `.cm-activeLine { background: var(--sel) }`).
            editor_active_line: Some(palette.color("sel")),
            syntax,
            ..Default::default()
        },
    }
}

/// The first of [`FONT_MONO_CANDIDATES`] the machine has installed, resolved
/// once. GPUI panics laying out an uninstalled family, so this probe is not
/// optional; `.SystemUIFont` is the last resort (gpui-kit uses it the same
/// way for its own default).
fn installed_mono_family(cx: &App) -> SharedString {
    static RESOLVED: OnceLock<SharedString> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let names = cx.text_system().all_font_names();
            FONT_MONO_CANDIDATES
                .iter()
                .find(|candidate| names.iter().any(|name| name == *candidate))
                .map(|candidate| SharedString::from(*candidate))
                .unwrap_or_else(|| SharedString::from(".SystemUIFont"))
        })
        .clone()
}

/// `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgba(r, g, b, a)` — the three forms the
/// CSS file uses.
fn parse_color(value: &str) -> Option<Hsla> {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        let expand = |c: u8| -> u32 { ((c as u32) << 4) | c as u32 };
        let parse = |s: &str| u32::from_str_radix(s, 16).ok();
        let (r, g, b, a) = match hex.len() {
            3 => {
                let mut it = hex.bytes();
                (expand(it.next()?), expand(it.next()?), expand(it.next()?), 0xff)
            }
            6 => (parse(&hex[0..2])?, parse(&hex[2..4])?, parse(&hex[4..6])?, 0xff),
            8 => (
                parse(&hex[0..2])?,
                parse(&hex[2..4])?,
                parse(&hex[4..6])?,
                parse(&hex[6..8])?,
            ),
            _ => return None,
        };
        return Some(rgba((r << 24) | (g << 16) | (b << 8) | a).into());
    }
    let inner = value.strip_prefix("rgba(")?.strip_suffix(')')?;
    let mut parts = inner.split(',').map(str::trim);
    let r: u8 = parts.next()?.parse().ok()?;
    let g: u8 = parts.next()?.parse().ok()?;
    let b: u8 = parts.next()?.parse().ok()?;
    let a: f32 = parts.next()?.parse().ok()?;
    let alpha = (a.clamp(0., 1.) * 255.).round() as u32;
    Some(rgba(((r as u32) << 24) | ((g as u32) << 16) | ((b as u32) << 8) | alpha).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CSS file, byte-for-byte (`src/styles/global.css` of the Tauri
    /// shell, sha1 9a4d1182… at the time of the port).
    const CSS: &str = include_str!("../tests/data/bnote-theme.css");

    /// The `--name: value;` pairs of one selector block, comments stripped.
    fn css_block(selector: &str) -> Vec<(String, String)> {
        let stripped = strip_comments(CSS);
        let start = stripped
            .find(&format!("\n{selector} {{"))
            .unwrap_or_else(|| panic!("selector {selector} not found"));
        let open = stripped[start..].find('{').unwrap() + start;
        let mut depth = 0usize;
        let mut end = open;
        for (i, byte) in stripped[open..].bytes().enumerate() {
            match byte {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &stripped[open + 1..end];
        let mut out = Vec::new();
        for decl in body.split(';') {
            let Some((name, value)) = decl.split_once(':') else { continue };
            let name = name.trim();
            if let Some(name) = name.strip_prefix("--") {
                out.push((name.to_string(), value.split_whitespace().collect::<Vec<_>>().join(" ")));
            }
        }
        out
    }

    /// The first `--name: value;` declaration anywhere in the file (comments
    /// stripped), for variables declared outside the two mode blocks.
    fn css_variable(name: &str) -> Option<String> {
        let stripped = strip_comments(CSS);
        let needle = format!("--{name}:");
        let start = stripped.find(&needle)? + needle.len();
        let end = stripped[start..].find(';')? + start;
        Some(stripped[start..end].split_whitespace().collect::<Vec<_>>().join(" "))
    }

    fn strip_comments(css: &str) -> String {
        let mut out = css.to_string();
        while let Some(start) = out.find("/*") {
            let Some(rel_end) = out[start..].find("*/") else { break };
            out.replace_range(start..start + rel_end + 2, "");
        }
        out
    }

    /// Every variable of both CSS blocks is in the palette with the same value,
    /// and the two modes define the same key set (bnote's own `theme.test.ts`
    /// discipline: a color must exist for both modes).
    #[test]
    fn the_palette_matches_the_css() {
        for (selector, table) in [(":root", DARK), ("[data-theme=\"light\"]", LIGHT)] {
            let css = css_block(selector);
            assert!(!css.is_empty(), "{selector}");
            for (name, value) in &css {
                // Font stacks and metrics are CSS-only concerns handled below.
                if name.starts_with("font-") || name.ends_with("-px") || name.ends_with("width") {
                    continue;
                }
                let palette = Palette::from_table(table);
                let found = palette.raw_hex(name);
                let expected = parse_color(value);
                assert_eq!(
                    found, expected,
                    "{selector} --{name}: palette {:?} vs css {:?}",
                    found, expected
                );
            }
            // Nothing extra: every palette entry is a CSS variable. The three
            // bracket colors are declared in their own `:root` block (not in
            // this one) and are carried by both modes.
            for (name, _) in table.iter().filter(|(n, _)| {
                !n.starts_with("font-") && !n.starts_with("latex-bracket-")
            }) {
                assert!(
                    css.iter().any(|(key, _)| key == *name),
                    "{selector}: palette has {name} which the CSS does not define"
                );
            }
        }
    }

    /// The mode-independent pieces the CSS declares once.
    #[test]
    fn shared_values_match_the_css() {
        let dark = Palette::from_table(DARK);
        let light = Palette::from_table(LIGHT);
        // The three bracket colors live in a second `:root` block (declared
        // once, mode-independent); both palette modes carry them.
        for i in 0..3 {
            let name = format!("latex-bracket-{i}");
            let css_value = parse_color(&css_variable(&name).expect("bracket color in the CSS"));
            assert_eq!(dark.raw_hex(&name), css_value);
            assert_eq!(light.raw_hex(&name), css_value);
        }
        // Fonts and metrics live in the dark block only.
        assert!(DARK.iter().any(|(k, _)| *k == "font-mono"));
        assert!(DARK.iter().any(|(k, _)| *k == "editor-font-size"));
        assert_eq!(dark.editor_font_size, 16.);
        assert_eq!(dark.content_line_width, 700.);
        assert_eq!(dark.content_pad_x, 48.);
        assert_eq!(light.editor_font_size, dark.editor_font_size);
    }

    /// Both modes define every color the shell reads (a missing one panics at
    /// use); this pins the set so an addition to one mode must reach the other.
    #[test]
    fn both_modes_are_complete() {
        let dark = Palette::from_table(DARK);
        let light = Palette::from_table(LIGHT);
        let keys: Vec<&str> = dark.colors.keys().copied().collect();
        assert!(keys.len() > 40, "{keys:?}");
        for key in keys {
            assert!(light.colors.contains_key(key), "light is missing {key}");
            assert_eq!(
                dark.raw_hex(key).is_some(),
                light.raw_hex(key).is_some(),
                "{key}"
            );
        }
        // The three forms of the CSS parser.
        assert!(parse_color("#f66").is_some());
        assert!(parse_color("#ffffffbb").is_some());
        assert!(parse_color("rgba(255, 255, 255, 0.22)").is_some());
        assert!(parse_color("nope").is_none());
    }

    /// Every capture name the engine's markdown queries can produce resolves
    /// to a style. The names come from `crates/component/src/highlighter/
    /// languages/{markdown,markdown_inline}/highlights.scm`; a name left out
    /// renders as plain text with no visible error.
    #[test]
    fn every_markdown_capture_resolves() {
        let theme = highlight_theme(Palette::dark(), ThemeMode::Dark);
        for capture in [
            // markdown/highlights.scm
            "title",
            "punctuation.special",
            "text.literal",
            "punctuation.delimiter",
            "link_uri",
            "link_text",
            "punctuation.list_marker",
            "string.escape",
            // markdown_inline/highlights.scm
            "text.code.span",
            "emphasis",
            "emphasis.strong",
        ] {
            assert!(
                theme.style.syntax.style(capture).is_some(),
                "{capture} has no style"
            );
        }
    }

    /// The syntax colours are the same palette variables the TS classes used.
    #[test]
    fn the_highlight_theme_maps_the_markdown_captures() {
        let palette = Palette::dark();
        let theme = highlight_theme(palette, ThemeMode::Dark);
        let style = |name: &str| theme.style.syntax.style(name).expect(name);
        assert_eq!(style("title").color, Some(palette.color("text")));
        assert_eq!(style("title").font_weight, Some(gpui::FontWeight::BOLD));
        assert_eq!(
            style("punctuation.special").color,
            Some(palette.color("text-faint"))
        );
        assert_eq!(
            style("punctuation.list_marker").color,
            Some(palette.color("text-faint"))
        );
        assert_eq!(style("text.literal").color, Some(palette.color("text")));
        assert_eq!(style("link_text").color, Some(palette.color("link")));
        assert_eq!(style("link_uri").color, Some(palette.color("link")));
        assert_eq!(
            style("text.code.span").color,
            Some(palette.token("number"))
        );
        assert_eq!(style("string.escape").color, Some(palette.color("text")));
        assert_eq!(
            style("emphasis").color,
            Some(palette.color("strong-color"))
        );
        assert_eq!(style("emphasis").font_style, Some(gpui::FontStyle::Italic));
        assert_eq!(
            style("emphasis.strong").font_weight,
            Some(gpui::FontWeight::BOLD)
        );
        // The current-line shade rides the highlight theme, not the colours.
        assert_eq!(
            theme.style.editor_active_line,
            Some(palette.color("sel"))
        );
    }
}

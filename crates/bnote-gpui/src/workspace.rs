//! The bnote GPUI workspace: file tree + markdown editor + agent panel over
//! bnote-core, with the daily-sync and footprint hosts wired to autosave and
//! the vault watcher.
//!
//! Ownership rules honored here (see AGENTS.md 性能是生命线):
//! - All disk IO runs on the background executor, never on the UI thread.
//! - Every async callback re-validates against the *current* open path and
//!   save sequence before touching the editor or the disk; stale results are
//!   dropped, never written.
//! - Saves are serialized through a seq guard so a slow older snapshot can
//!   never overwrite a newer one (last-writer-wins by sequence, decided
//!   before the write, inside the same mutex).

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use bnote_core::commands::ime::{self as ime_cmd, ImeWhere};
use bnote_core::markdown::numbering;
use bnote_core::markdown::ops as ops;
use bnote_core::markdown::wikilink;
use bnote_core::state::AppState;
use ::gpui::{
    AppContext as _, Context, Entity, Focusable, HighlightStyle, ScrollHandle, SharedString,
    StyledText, Subscription, WeakEntity, Window, div, px, relative,
};
use gpui_kit::component::button::ButtonVariants as _;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{
    ActiveTheme, IconName,
    button::Button,
    command::{Command, CommandItem, CommandState},
    h_flex, v_flex,
    input::{Editor, EditorState, Input, InputEvent, InputState, PreviewDecorations, TextDecorationCollection},
    label::Label,
    list::ListItem,
    resizable::{h_resizable, resizable_panel},
    slider::{Slider, SliderEvent, SliderState},
    status_bar::StatusBar,
    switch::Switch,
    theme::{Theme, ThemeMode},
    tree::{TreeItem, TreeState, tree},
};
use gpui_kit::*;
use tokio::sync::broadcast;

use crate::agent_panel::AgentPanel;
use crate::editor::vim::integration::VimBridge;
use crate::apply_ops::apply_outcome;
use crate::commands::{COMMANDS, action_for, actions, def_of};
use crate::keybindings;
use crate::daily_host::{DailyHost, SyncWrite};
use crate::editor::images as editor_images;
use crate::editor::preview::{LineMark, PreviewFont, PreviewHost};
use crate::footprint_zone::{
    OpenFootprintSource, ToggleFootprintGroup, ToggleFootprintZone, ZoneInput,
};
use crate::editor::snippets_host::SnippetBridge;
use crate::editor::vim::core::Mode as VimMode;
use crate::footprint_host::FootprintHost;
use crate::ime_host::{ImeHost, ImeServices};
use crate::python_lsp::{
    PyCompletionProvider, PyHoverProvider, PyLspHost, PyLspServices, SYNC_DEBOUNCE,
};

/// How long typing pauses before the buffer flushes to disk (mirrors the
/// Tauri shell's stop-typing autosave).
const AUTOSAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(800);

/// How long the caret must rest before its position is persisted (the TS
/// `cursorMemory.ts` debounce).
const CURSOR_SAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(300);

/// How often the shell polls the backend event bus for vault/agent events.
const EVENT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(300);

/// A toast lives this long (TS `Toast`'s 2600 ms; a newer toast replaces it
/// and restarts the clock).
const TOAST_DURATION: std::time::Duration = std::time::Duration::from_millis(2600);

/// Every Nth event-loop iteration pumps the footprint core (~1.2s at 300ms).
const FOOTPRINT_TICK_EVERY: u32 = 4;

/// `settings.fontSize` default (TS `DEFAULT_SETTINGS.fontSize`) and the range
/// the slider and the zoom commands share (TS `view.zoom-in/out`'s clamp).
const FONT_SIZE_DEFAULT: f32 = 16.;
const FONT_SIZE_MIN: f32 = 12.;
const FONT_SIZE_MAX: f32 = 28.;

/// The link-suggest panel's fixed width (TS `.link-suggest`, 380px).
const LINK_PANEL_W: f32 = 380.;
/// The panel's worst-case height, the bound used when it has to flip above
/// the caret (TS measures the panel; 252px results cap plus the search field).
const LINK_PANEL_H: f32 = 300.;

#[derive(Clone, Copy, PartialEq)]
enum PaletteKind {
    Commands,
    Files,
}

/// The file tree's right-click menu, anchored where the click landed (TS
/// `TreeItem.openMenu` + `ContextMenu.tsx`).
struct TreeMenu {
    rel: String,
    is_folder: bool,
    x: f32,
    y: f32,
}

/// What the study pane shows (TS `StudyContent`).
#[derive(Clone, Debug, PartialEq)]
enum StudyContent {
    /// A note in the vault: the converted PDF's markdown, or a dropped `.md`.
    Markdown { path: String, title: String },
    /// A web page. The shell has no web view: the pane shows the address and
    /// hands the agent the URL (TS renders it in a native child webview).
    Url { url: String, title: String },
}

/// TS `StudyLayout.normalizeSplit` + `DEFAULT_SETTINGS.studySplit`: the two
/// stored fractions (agent, content), clamped so a hand-edited config cannot
/// squeeze a pane to nothing. The notes pane takes the remainder.
const STUDY_SPLIT_DEFAULT: [f32; 2] = [0.24, 0.44];

fn normalize_split(split: [f32; 2]) -> [f32; 2] {
    let agent = split[0].clamp(0.05, 0.90);
    let content = split[1].clamp(0.05, 0.95 - agent);
    [agent, content]
}

/// One output chunk of a python run (one backend flush, not one line).
#[derive(Clone, Copy, Debug, PartialEq)]
enum PyStream {
    Stdout,
    Stderr,
    /// Shell-side notes (`beginSystem`, TS's `"system"` stream).
    System,
}

struct PyRunLine {
    stream: PyStream,
    text: String,
}

/// The run panel's state (TS `src/python/run.ts`'s store).
#[derive(Default)]
struct PyRunState {
    open: bool,
    /// The current run's id; output/exit events must match it.
    run_id: Option<u64>,
    /// The note the run belongs to (TS `mdPath`; the cancel path's key).
    md_path: Option<String>,
    /// The resolved command line, shown in the header.
    command: String,
    lines: Vec<PyRunLine>,
    running: bool,
    exit_code: Option<i32>,
    cancelled: bool,
    timed_out: bool,
    duration_ms: Option<u64>,
}

/// TS `MAX_LINES`/`TRIM_TO`: over the cap the oldest chunks drop.
const PY_RUN_MAX_LINES: usize = 4000;
const PY_RUN_TRIM_TO: usize = 2000;

impl PyRunState {
    /// TS `beginRun` / `beginSystem`: the panel opens on a fresh run.
    fn begin(&mut self, run_id: Option<u64>, md_path: Option<String>, command: String) {
        self.open = true;
        self.run_id = run_id;
        self.md_path = md_path;
        self.command = command;
        self.lines.clear();
        self.running = true;
        self.exit_code = None;
        self.cancelled = false;
        self.timed_out = false;
        self.duration_ms = None;
    }

    /// TS `append` + the cap. Returns true when the cap dropped the head (the
    /// caller's cached body text must then be rebuilt).
    fn append(&mut self, stream: PyStream, text: String) -> bool {
        if text.is_empty() {
            return false;
        }
        self.lines.push(PyRunLine { stream, text });
        if self.lines.len() > PY_RUN_MAX_LINES {
            let drop = self.lines.len() - PY_RUN_TRIM_TO;
            self.lines.drain(..drop);
            return true;
        }
        false
    }

    /// TS `finish`: the exit event's payload, already id-checked.
    fn finish(&mut self, exit_code: Option<i32>, duration_ms: u64, cancelled: bool, timed_out: bool) {
        self.running = false;
        self.exit_code = exit_code;
        self.cancelled = cancelled;
        self.timed_out = timed_out;
        self.duration_ms = Some(duration_ms);
    }

    /// The header's status text (TS `PythonRunPanel`'s status span), with the
    /// colour class its CSS gave it.
    fn status(&self) -> (String, PyStatus) {
        if self.running {
            return ("运行中".to_string(), PyStatus::Running);
        }
        if self.timed_out {
            return ("超时已终止".to_string(), PyStatus::Bad);
        }
        if self.cancelled {
            return ("已取消".to_string(), PyStatus::Bad);
        }
        match self.exit_code {
            Some(0) => ("成功".to_string(), PyStatus::Ok),
            Some(code) => (format!("退出码 {code}"), PyStatus::Bad),
            None => ("退出码 ?".to_string(), PyStatus::Bad),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PyStatus {
    Running,
    Ok,
    Bad,
}

/// One entry of the tree menu. The set depends on the row kind: a folder gets
/// the two create actions, a file gets 「打开」; rename and delete are on both.
#[derive(Clone, Copy, Debug, PartialEq)]
enum TreeMenuItem {
    Open,
    NewNote,
    NewFolder,
    Rename,
    Delete,
}

impl TreeMenuItem {
    /// The entries of a row kind, in display order (TS `TreeItem.openMenu`).
    fn for_row(is_folder: bool) -> &'static [TreeMenuItem] {
        const DIR: &[TreeMenuItem] = &[
            TreeMenuItem::NewNote,
            TreeMenuItem::NewFolder,
            TreeMenuItem::Rename,
            TreeMenuItem::Delete,
        ];
        const FILE: &[TreeMenuItem] =
            &[TreeMenuItem::Open, TreeMenuItem::Rename, TreeMenuItem::Delete];
        if is_folder { DIR } else { FILE }
    }

    fn label(self) -> &'static str {
        match self {
            TreeMenuItem::Open => "打开",
            TreeMenuItem::NewNote => "新建笔记",
            TreeMenuItem::NewFolder => "新建文件夹",
            TreeMenuItem::Rename => "重命名",
            TreeMenuItem::Delete => "删除",
        }
    }

    /// Delete draws in the danger color (TS `danger: true`).
    fn is_danger(self) -> bool {
        self == TreeMenuItem::Delete
    }
}

/// The rename dialog a tree menu's 「重命名」 opens. The TS shell renames
/// inline in the row; the port edits through a small dialog — one writer
/// either way, the rename itself lands in `files::rename_path`.
struct RenamePrompt {
    rel: String,
    is_folder: bool,
}

/// One 「快速添加」 row of the settings modal: the command name field and the
/// target-folder field, each with the id its subscription looks the row up by
/// (indices shift when a row is removed; ids do not).
struct QaRow {
    id: u64,
    name: Entity<InputState>,
    folder: Entity<InputState>,
    /// The fields' change subscriptions. Dropping them would unsubscribe, so
    /// the row owns them for as long as it exists.
    _subs: Vec<Subscription>,
}

/// The settings modal's left nav (TS `SettingsModal.tsx`'s `Tab`).
#[derive(Clone, Copy, PartialEq)]
enum SettingsTab {
    General,
    Editor,
    Hotkeys,
    Vim,
    Snippets,
    QuickAdd,
    Ime,
}

/// The hotkeys tab's 「全部 / 已分配 / 未分配」 filter (TS `HotkeyFilter`).
#[derive(Clone, Copy, PartialEq)]
enum HotkeyFilter {
    All,
    Assigned,
    Unassigned,
}

/// Which of the two input-source fields the settings modal's picker fills.
#[derive(Clone, Copy, PartialEq)]
enum ImePickField {
    Insert,
    Normal,
}

pub struct Workspace {
    state: Arc<AppState>,
    vault_root: Option<PathBuf>,
    tree_state: Entity<TreeState>,
    editor: Entity<EditorState>,
    /// Vault-relative path of the open note; None = welcome screen.
    open_path: Option<String>,
    dirty: bool,
    /// Bumped on every edit; a save task carries its seq and only writes when
    /// it is still the newest.
    save_seq: u64,
    /// Bumped when the auto-save switch turns off: a debounced write that was
    /// already scheduled carries the old generation and drops itself (TS
    /// clears the pending timeout).
    autosave_gen: u64,
    /// Serializes disk writes and keeps the last written seq (see module docs).
    save_guard: Arc<Mutex<u64>>,
    status: String,
    cursor_label: String,

    // Feature hosts (present once a vault is open).
    daily: Option<Arc<DailyHost>>,
    footprint: Option<Arc<FootprintHost>>,
    /// The footprint revision the last frame scanned against; a bump means
    /// the source-side pips need rebuilding.
    footprint_revision: u64,
    /// The footprint zone's fold state: session-local UI state, never
    /// persisted (every open starts fully expanded — TS `defaultFold`).
    footprint_fold: bnote_core::footprint::view::FoldState,
    /// A 1-based line to land the caret on after the next install (the
    /// zone's "open the source at this block").
    pending_open_line: Option<usize>,

    // UI state.
    sidebar_open: bool,
    agent: Entity<AgentPanel>,
    agent_open: bool,
    palette: Option<PaletteKind>,
    cmd_state: Entity<CommandState>,
    files_state: Entity<CommandState>,
    files: Vec<String>,
    /// Most-recently-opened notes (session-only recency for the switcher).
    mru: Vec<String>,
    /// Expanded directories in the sidebar (vault-relative ids). The tree
    /// rebuilds its items on every vault change, so the expanded set lives
    /// here — the single writer — and is re-applied to the fresh items (TS
    /// `Sidebar`'s `expanded` state surviving `refreshTree`).
    expanded_dirs: std::collections::HashSet<String>,
    /// The vault's directory paths, for telling a folder row from a note row
    /// (a `TreeItem` with no children is not "a folder" to the kit, but an
    /// empty directory must still render as one and never open as a note).
    tree_dirs: std::collections::HashSet<String>,
    /// ⌘T round-trip memory (path → return position).
    header_returns: ops::HeaderTodoReturnMap,
    /// ⌘⇧O round-trip memory: the note the user jumped into today's daily
    /// from (TS `dailyBackFrom`; consumed by the next ⌘⇧O inside the daily).
    daily_back_from: Option<String>,
    /// One transient toast (TS `showToast`), cleared by a generation-guarded
    /// timer so an older timer cannot eat a newer message.
    toast: Option<String>,
    toast_gen: u64,
    /// App-wide vim bridge (created in main; shared with the interceptor).
    vim_bridge: VimBridge,
    vim_enabled: bool,
    /// The diagnostic probe's keystroke counter (`debug_schedule_diag`; the
    /// `harness-shot` build only, and it is only ever read from there).
    #[cfg(feature = "harness-shot")]
    diag_hits: std::rc::Rc<std::cell::Cell<usize>>,
    /// App-wide LaTeX-suite snippet bridge (created in main before the vim
    /// bridge; owns one `SnippetHost` per attached editor).
    snippets: SnippetBridge,
    /// The visible row range the bracket marks were last computed for, so the
    /// render path only recomputes them when the document, the caret or the
    /// viewport moved.
    snippet_marks_rows: Option<std::ops::Range<usize>>,
    /// Today as YYYY-MM-DD (local), fixed at window creation.
    today: String,
    /// Live-preview host: scans on every text/selection change (see
    /// `editor::preview`) and renders the widgets the snapshot asks for.
    preview: Rc<PreviewHost>,
    /// Set by the editor's subscriptions; the push itself happens in
    /// `render`, the only place with a window to measure fonts in.
    preview_dirty: bool,
    /// The selection the last scan saw, to tell a caret move from a repaint.
    preview_selection: Option<std::ops::Range<usize>>,
    /// The live preview's text styles (the TS mark classes), installed as a
    /// text-decoration collection alongside the geometry snapshot.
    preview_styles: TextDecorationCollection,
    /// `settings.autoNumberHeadings` (`config.json`, the Tauri shell's key):
    /// renumber headings after every document change. Off by default, like TS.
    auto_number: bool,
    /// A document change asked for a heading renumbering pass. The pass needs
    /// a window (it refreshes the highlighter), so it runs from `render`.
    renumber_pending: bool,
    /// The document revision the last renumbering pass left behind: a `Change`
    /// carrying this revision is the pass's own edit and must not re-trigger
    /// it (the subscriber runs after the pass, so the flag cannot).
    renumber_done_rev: Option<u64>,
    /// Link suggest (TS `LinkSuggest.tsx`): the completion panel
    /// `edit.insert-wikilink` opens when the caret line has no link, plus its
    /// live query.
    link_suggest: bool,
    link_query: String,
    /// The document revision the panel opened over — the insert is abandoned
    /// when it no longer matches (TS `linkPickState`).
    link_pick_rev: Option<u64>,
    link_state: Entity<CommandState>,
    /// The IME follow (⌘… TS `imeSwitch.ts`): the input source tracks the vim
    /// mode and the caret's region.
    ime: Entity<ImeHost>,
    /// The host's platform seams, kept here too: the pickers list sources
    /// through the same injection (and a test's inert `list` stays inert).
    ime_services: ImeServices,
    /// The selectable input sources for the settings modal's pickers, fetched
    /// off the UI thread the first time the IME tab (or a picker) opens.
    ime_sources: Vec<ime_cmd::InputSourceInfo>,
    /// A fetch is in flight (`ime_sources` fills when it lands).
    ime_loading: bool,
    /// Which source field the inline source picker is filling.
    ime_pick: Option<ImePickField>,
    /// The python run panel's state (TS `usePythonRun`).
    python_run: PyRunState,
    /// The panel body's assembled text and its per-chunk colours: appended to
    /// as output lands, rebuilt only when the chunk cap drops the head (the
    /// TS rebuilds the whole `<pre>` every render; a cached body keeps a big
    /// run's re-render O(1) per frame instead of O(output)).
    py_body: String,
    py_body_highlights: Vec<(std::ops::Range<usize>, HighlightStyle)>,
    /// The body's scroll position (the autoscroll rule reads it).
    py_scroll: ScrollHandle,
    /// The ty type-check follow (TS `src/python/lsp.ts`).
    py_lsp: Entity<PyLspHost>,
    /// The sync debounce generation (only the newest quiet period syncs).
    py_lsp_seq: u64,
    /// Study mode (⌘⇧S; TS `StudyLayout.tsx`): agent | content | notes.
    /// Session-only, like the TS store flag.
    study_mode: bool,
    /// `settings.studySplit`: the agent and content panes' fractions of the
    /// study layout's width; the notes pane takes the remainder.
    study_split: [f32; 2],
    /// What the middle pane shows; survives leaving and re-entering study mode
    /// (the TS keeps it in the store too).
    study_content: Option<StudyContent>,
    /// The middle pane's read-only editor and its own live preview (the TS
    /// mounts a second CM6 view with the same extensions).
    study_editor: Entity<EditorState>,
    study_preview: Rc<PreviewHost>,
    study_styles: TextDecorationCollection,
    study_dirty: bool,
    study_rows: Option<std::ops::Range<usize>>,
    /// The study panes' resize state (fractions are recomputed from its sizes
    /// on every change and persisted).
    study_resize: Entity<gpui_kit::component::resizable::ResizableState>,
    /// Which content the agent session was opened with (`None` = no study
    /// content when the session started).
    study_session_for: Option<String>,
    /// The toolbar's URL box (TS `input.content-url`).
    study_url_state: Entity<InputState>,
    /// The settings modal (⌘,): TS `SettingsModal.tsx`'s tabs this shell
    /// consumes — general / editor / vim / snippets. Hotkeys, IME, quick-add
    /// and the agent tab arrive with their own ports.
    settings_open: bool,
    settings_tab: SettingsTab,
    /// `settings.*` of `config.json` as the modal's working state; every
    /// change is applied live and written back under the same keys the Tauri
    /// shell uses.
    live_preview: bool,
    auto_save: bool,
    math_preview: bool,
    typewriter: bool,
    code_block_lang: String,
    theme_mode: ThemeMode,
    font_size: f32,
    snippets_enabled: bool,
    /// The file tree's right-click menu, `None` when no menu is up.
    tree_menu: Option<TreeMenu>,
    /// The rename dialog the tree menu opens, with its single field.
    rename_prompt: Option<RenamePrompt>,
    rename_state: Entity<InputState>,
    /// The ex command line (`:` in a modal vim mode; TS `vim.ts`). One input,
    /// shown bottom-center; Enter runs the command, Esc closes.
    ex_open: bool,
    ex_state: Entity<InputState>,
    /// This window's own handle, for app-level callbacks (the vim bridge's
    /// `:` observer) that must reach the view from a bare `&mut App`.
    window_handle: gpui::AnyWindowHandle,
    /// Quick add (⌘⇧A; TS `QuickAddModal.tsx`): pick one of
    /// `settings.quickAdd`'s commands, then name the note. The name lands in
    /// the command's folder, created at the vault root when missing.
    qa_open: bool,
    /// Which stage of the two-stage flow is showing.
    qa_naming: bool,
    /// The command the pick stage confirmed (the naming stage's folder).
    qa_picked: Option<bnote_core::commands::config::QuickAddCommand>,
    /// The commands to offer, re-read from `config.json` on every open (the
    /// settings tab is the writer).
    qa_commands: Vec<bnote_core::commands::config::QuickAddCommand>,
    qa_state: Entity<CommandState>,
    /// The name field of the second stage.
    qa_name_state: Entity<InputState>,
    /// The settings modal's 「快速添加」 rows: the two text fields per
    /// command. The inputs own the values; `settings.quickAdd` is rebuilt from
    /// them on every change.
    qa_rows: Vec<QaRow>,
    qa_next_row_id: u64,
    /// The code-block-language field of the settings modal.
    lang_state: Entity<InputState>,
    /// `keybindings.json` (TS `keybindingOverrides.ts`): the hotkeys tab edits
    /// it, the keymap is rebuilt from it, and it is the only copy — the file is
    /// the persistence, `apply` pushes it into gpui.
    key_overrides: keybindings::Overrides,
    /// The hotkeys tab's search field and filter chips.
    hotkey_query: Entity<InputState>,
    hotkey_filter: HotkeyFilter,
    /// The command whose row is capturing a keystroke, while one is (TS
    /// `capturing`), and the interceptor that grabs the keys. Dropping the
    /// subscription is what stops the capture.
    hotkey_capturing: Option<String>,
    hotkey_capture_sub: Option<Subscription>,
    /// The font-size slider's state (`settings.fontSize`, 12–28px).
    font_slider: Entity<SliderState>,
    /// Cursor memory (TS `cursorMemory.ts`): the position to persist, bumped
    /// with every save request.
    cursor_pending: Option<(String, usize, f32)>,
    /// Debounce generation; a stale timer must not write at all.
    cursor_save_seq: u64,
    /// Serializes config writes and holds the last seq written, so a slow
    /// older position is dropped instead of landing after a newer one (the
    /// same rule `save_guard` enforces for note saves).
    cursor_guard: Arc<Mutex<u64>>,
    _subscriptions: Vec<Subscription>,
}

/// config.json as an object (missing file → empty object).
fn load_config_value(state: &AppState) -> serde_json::Value {
    bnote_core::commands::config::load_app_config(state)
        .ok()
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// [`Workspace::schedule_renumber`]'s decision, a free function so a unit
/// test can pin the gates without opening a window: the change must be the
/// user's (`history: false` — a replay must not re-apply what it removed)
/// and must not be the pass's own edit (revision mismatch).
fn should_schedule_renumber(
    event: &InputEvent,
    current_rev: u64,
    done_rev: Option<u64>,
) -> bool {
    matches!(event, InputEvent::Change { history: false }) && done_rev != Some(current_rev)
}

/// Apply a batch of replacements through the engine's cursor-preserving
/// batch API and report the document revision they left behind (`None` when
/// nothing was applied). [`Workspace::schedule_renumber`] compares that
/// revision against the next `Change` to recognise the edit it just made.
fn apply_edits_keeping_cursor(
    editor: &Entity<EditorState>,
    edits: &[(std::ops::Range<usize>, String)],
    window: &mut Window,
    cx: &mut gpui::App,
) -> Option<u64> {
    let mut done = None;
    editor.update(cx, |state, cx| {
        if state.apply_edits(edits, window, cx) {
            done = Some(state.document_revision());
        }
    });
    done
}

/// The line containing `head`, starting at its first byte (`head` clamps into
/// `text`).
fn cursor_line_start(text: &str, head: usize) -> usize {
    let head = head.min(text.len());
    text[..head].rfind('\n').map(|i| i + 1).unwrap_or(0)
}

/// The line starting at `line_start`, without its trailing newline.
fn line_at_start(text: &str, line_start: usize) -> &str {
    let line_start = line_start.min(text.len());
    let line_end = text[line_start..]
        .find('\n')
        .map(|i| line_start + i)
        .unwrap_or(text.len());
    &text[line_start..line_end]
}

/// Whether `cycle_heading` demotes the cursor line out of headingness (H4 and
/// deeper cycle into a paragraph — the TS `headingRemoved` test), with the
/// line's start offset for locating it afterwards.
fn cycle_demotes_cursor_line(text: &str, head: usize) -> (usize, bool) {
    let start = cursor_line_start(text, head);
    let demoted = numbering::heading_level_of_line(line_at_start(text, start))
        .is_some_and(|level| level >= 4);
    (start, demoted)
}

/// Whether `set_heading(level)` demotes the cursor line (the line already
/// carries exactly that level, so this toggle removes it — the TS
/// `headingRemoved` test of the `edit.heading-*` commands).
fn level_toggle_demotes_cursor_line(text: &str, head: usize, level: usize) -> (usize, bool) {
    let start = cursor_line_start(text, head);
    let demoted = numbering::heading_level_of_line(line_at_start(text, start)) == Some(level);
    (start, demoted)
}

/// Local date string (YYYY-MM-DD) via the `time` crate.
fn today_string() -> String {
    time::OffsetDateTime::now_local()
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc())
        .date()
        .to_string()
}

impl Workspace {
    /// Headless-harness seams (cfg(test)): the private views the debug
    /// harness reads through (`src/harness.rs`). No production path uses
    /// these, and they compile out of release builds.
    #[cfg(test)]
    pub(crate) fn harness_editor(&self) -> &Entity<EditorState> {
        &self.editor
    }
    #[cfg(test)]
    pub(crate) fn harness_vim(&self) -> &VimBridge {
        &self.vim_bridge
    }
    #[cfg(test)]
    pub(crate) fn harness_open_path(&self) -> Option<&str> {
        self.open_path.as_deref()
    }
    /// Load a vault-relative path into the editor the way the construction
    /// fixture wants it (no install/preview dance, cursor at 0).
    #[cfg(test)]
    pub(crate) fn harness_load(&mut self, rel: &str, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_path = Some(rel.to_string());
        self.replace_buffer(text, window, cx);
    }
    /// Flip the vim setting without the settings UI (the fixture path).
    #[cfg(test)]
    pub(crate) fn harness_set_vim(&mut self, on: bool, cx: &mut Context<Self>) {
        self.set_vim_setting(on, cx);
    }
    #[cfg(test)]
    pub(crate) fn harness_palette_open(&self) -> bool {
        self.palette.is_some()
    }
    #[cfg(test)]
    pub(crate) fn harness_palette_query(&self, cx: &gpui::App) -> String {
        self.files_state.read(cx).query(cx).to_string()
    }

    // ---- debug channels (the headless harness, DEBUGGING.md) ------------
    // Non-test: `--harness-shot` (a release binary) drives the same seams
    // the test fixture does. They only read/write the open note's text and
    // the vim flag — no production path calls them.

    // The load seams below are driven by the `harness-shot` binary (a
    // feature, not the default test build), so without that feature the
    // default target sees them as unused.
    #[cfg_attr(not(feature = "harness-shot"), allow(dead_code))]
    /// Put `text` into the editor as the note's content (cursor at 0).
    pub(crate) fn debug_set_doc(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_buffer(text, window, cx);
        self.editor.update(cx, |st, cx| st.set_selected_range(0..0, cx));
    }

    #[cfg_attr(not(feature = "harness-shot"), allow(dead_code))]
    /// The caret as a byte offset (scripted shots position for vim tests).
    pub(crate) fn debug_set_cursor(&mut self, byte: usize, cx: &mut Context<Self>) {
        self.editor.update(cx, |st, cx| st.set_selected_range(byte..byte, cx));
    }

    #[cfg_attr(not(feature = "harness-shot"), allow(dead_code))]
    /// Open a vault-relative path the mechanical way (read from disk, set as
    /// the note) — the scripted shots start from a known document.
    pub(crate) fn debug_load_note(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.vault_root.clone() else { return };
        let text = std::fs::read_to_string(root.join(rel)).unwrap_or_default();
        self.load_note_text(rel, &text, window, cx);
    }

    #[cfg_attr(not(feature = "harness-shot"), allow(dead_code))]
    /// The mechanical load shared by the fixtures: path + text, cursor at 0.
    pub(crate) fn load_note_text(&mut self, rel: &str, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_path = Some(rel.to_string());
        self.replace_buffer(text, window, cx);
        self.editor.update(cx, |st, cx| st.set_selected_range(0..0, cx));
        self.sync_tree_selection(cx);
    }

    #[cfg(any(test, feature = "harness-shot"))]
    #[cfg_attr(not(feature = "harness-shot"), allow(dead_code))]
    /// Expand (or collapse) a directory by id — the scripted shots' way to
    /// put an open folder on screen (the click path is the tests').
    pub(crate) fn debug_toggle_dir(&mut self, dir: &str, cx: &mut Context<Self>) {
        if !self.expanded_dirs.remove(dir) {
            self.expanded_dirs.insert(dir.to_string());
        }
        self.refresh_tree(cx);
    }

    #[cfg_attr(not(feature = "harness-shot"), allow(dead_code))]
    pub(crate) fn debug_set_vim(&mut self, on: bool, cx: &mut Context<Self>) {
        self.set_vim_setting(on, cx);
    }

    /// The real-platform probe (`BNOTE_DIAG_VAULT`, see `main.rs`): records the
    /// focus/dispatch facts a `TestWindow` cannot show, then injects a few
    /// keystrokes through `Window::dispatch_keystroke` — the same entry real
    /// keys take *after* the macOS platform layer — and logs what each one did.
    ///
    /// The script lives in an async task: every dispatch happens through the
    /// plain window context (never inside a `Workspace` borrow, which would
    /// re-enter the entity through its own listeners), and the palette phase
    /// runs a frame later so the palette's input is rendered and reachable.
    #[cfg(feature = "harness-shot")]
    pub(crate) fn debug_schedule_diag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if std::env::var("BNOTE_DIAG_VAULT").is_err() {
            return;
        }
        let path = std::env::var("BNOTE_DIAG_LOG")
            .unwrap_or_else(|_| "/tmp/bnote-gpui-diag.log".to_string());
        // A probe interceptor registered after the vim/snippet ones: it counts
        // every keystroke that reaches the interceptor chain (registration
        // order = call order, and the chain runs all of them). Global, so the
        // count survives the dispatches below.
        let hits = self.diag_hits.clone();
        cx.intercept_keystrokes(move |_event, _window, _cx| {
            hits.set(hits.get() + 1);
        })
        .detach();

        cx.spawn_in(window, async move |this, window| {
            use std::fmt::Write as _;
            let mut out = String::new();
            let _ = writeln!(out, "=== bnote-gpui diag ===");
            window
                .background_executor()
                .timer(std::time::Duration::from_millis(2500))
                .await;
            let facts = this.update_in(window, |ws, window, cx| ws.diag_facts(window, cx));
            if let Ok(facts) = facts {
                out.push_str(&facts);
            }
            // Load the fixture note the way the tree click does, let a frame
            // render (that is what pushes the preview snapshot), then re-read.
            let _ = this.update_in(window, |ws, window, cx| {
                ws.debug_load_note("Note.md", window, cx)
            });
            window
                .background_executor()
                .timer(std::time::Duration::from_millis(600))
                .await;
            if let Ok(facts) = this.update_in(window, |ws, window, cx| ws.diag_facts(window, cx)) {
                out.push_str("--- after load ---\n");
                out.push_str(&facts);
            }
            for keys in ["j", "j", "x", "i", "H", "i", "escape", "u"] {
                let ks = gpui::Keystroke::parse(keys).expect("a keystroke");
                let _ = window.update(|window, cx| window.dispatch_keystroke(ks, cx));
                let line = this.update_in(window, |ws, _window, cx| {
                    let mode = ws.vim_bridge.mode_of(&ws.editor);
                    let cursor = ws.editor.read(cx).cursor();
                    let text = ws.editor.read(cx).value().to_string();
                    let _ = writeln!(
                        out,
                        "key {keys:>7}: mode={mode:?} cursor={cursor} hits={} text={:?}",
                        ws.diag_hits.get(),
                        text.chars().take(40).collect::<String>(),
                    );
                });
                let _ = line;
            }
            out.push_str("--- quick switcher ---\n");
            let settle = std::time::Duration::from_millis(300);
            let read_palette = |ws: &Workspace, cx: &gpui::App| {
                format!(
                    "  palette={} query={:?} open={:?}\n",
                    ws.palette.is_some(),
                    ws.files_state.read(cx).query(cx),
                    ws.open_path,
                )
            };
            let _ = window.update(|window, cx| {
                window.dispatch_action(Box::new(actions::QuickSwitcher), cx)
            });
            window.background_executor().timer(settle).await;
            if let Ok(text) = this.update_in(window, |ws, window, cx| {
                format!(
                    "after open:{}  files_input_focused={} editor_focused={}\n",
                    read_palette(ws, cx),
                    ws.files_state.read(cx).focus_handle(cx).is_focused(window),
                    ws.editor.focus_handle(cx).is_focused(window),
                )
            }) {
                out.push_str(&text);
            }
            for keys in ["N", "o", "t", "e"] {
                let ks = gpui::Keystroke::parse(keys).expect("a keystroke");
                let _ = window.update(|window, cx| window.dispatch_keystroke(ks, cx));
                if let Ok(text) = this.update_in(window, |ws, _, cx| read_palette(ws, cx)) {
                    out.push_str(&format!("key {keys}: {text}"));
                }
            }
            window.background_executor().timer(settle).await;
            if let Ok(text) = this.update_in(window, |ws, _, cx| read_palette(ws, cx)) {
                out.push_str(&format!("settled before enter: {text}"));
            }
            let _ = window.update(|window, cx| {
                window.dispatch_keystroke(gpui::Keystroke::parse("enter").expect("k"), cx)
            });
            window.background_executor().timer(settle).await;
            if let Ok(text) = this.update_in(window, |ws, _, cx| read_palette(ws, cx)) {
                out.push_str(&format!("after enter: {text}"));
            }
            // Escape: the first press clears a non-empty query.
            for round in 1..=3 {
                let _ = window.update(|window, cx| {
                    window.dispatch_keystroke(gpui::Keystroke::parse("escape").expect("k"), cx)
                });
                window.background_executor().timer(settle).await;
                if let Ok(text) = this.update_in(window, |ws, _, cx| read_palette(ws, cx)) {
                    out.push_str(&format!("after escape #{round}: {text}"));
                }
                let open = this
                    .update_in(window, |ws, _, _| ws.palette.is_some())
                    .unwrap_or(false);
                if !open {
                    break;
                }
            }
            // And the direct action dispatch, with a frame in between.
            let _ = window.update(|window, cx| {
                window.dispatch_action(
                    Box::new(gpui_kit::base::actions::Confirm { secondary: false }),
                    cx,
                )
            });
            window.background_executor().timer(settle).await;
            if let Ok(text) = this.update_in(window, |ws, _, cx| read_palette(ws, cx)) {
                out.push_str(&format!("direct Confirm (settled): {text}"));
            }
            let _ = std::fs::write(&path, out);
        })
        .detach();
    }

    /// The read-only half of the probe: focus, the vim attachment, and what the
    /// preview pipeline actually installed on the editor.
    #[cfg(feature = "harness-shot")]
    fn diag_facts(&self, window: &mut Window, cx: &mut Context<Self>) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        let focused = window.focused(cx);
        let editor_handle = self.editor.focus_handle(cx);
        let _ = writeln!(
            out,
            "focus: any_focused={:?} editor_focused={} focused_is_editor={:?}",
            focused.is_some(),
            editor_handle.is_focused(window),
            focused.as_ref().map(|f| f == &editor_handle),
        );
        let _ = writeln!(
            out,
            "vim_enabled={} mode={:?} ime_gate={} open={:?} live_preview={}",
            self.vim_enabled,
            self.vim_bridge.mode_of(&self.editor),
            self.editor.read(cx).accepts_text_input(),
            self.open_path,
            self.live_preview,
        );
        {
            let ed = self.editor.read(cx);
            let deco = ed.preview_decorations();
            let text = ed.text().to_string();
            let _ = writeln!(
                out,
                "preview: text={:?} spans={} blocks={} lines={} revision={} visible_rows={:?}",
                text.chars().take(60).collect::<String>(),
                deco.spans.len(),
                deco.blocks.len(),
                deco.lines.len(),
                deco.revision,
                ed.visible_row_range(),
            );
            let _ = writeln!(
                out,
                "rescan: width={} needs_rescan={} needs_rescan_for_visible={}",
                f32::from(self.editor_width(cx)),
                self.preview.needs_rescan(self.editor_width(cx)),
                self.preview.needs_rescan_for(ed.visible_byte_range().as_ref()),
            );
            for block in deco.blocks.iter().take(12) {
                let _ = writeln!(out, "  block lines={:?} text={:?}", block.lines, block.text);
            }
            for span in deco.spans.iter().take(12) {
                let _ = writeln!(out, "  span {:?}", span);
            }
        }
        let _ = writeln!(out, "ime_desired={:?}", {
            let ime = self.ime.read(cx);
            ime.settings().enabled
        });
        out
    }

    /// Install a footprint index (keys = **vault-relative** paths) and rescan:
    /// the scripted shots' way to put a zone on screen without waiting for a
    /// real edit cycle.
    #[cfg(any(test, feature = "harness-shot"))]
    pub(crate) fn debug_install_footprints(
        &mut self,
        index: std::collections::BTreeMap<String, Vec<bnote_core::footprint::model::FootprintBlock>>,
        cx: &mut Context<Self>,
    ) {
        let Some(fp) = self.footprint.clone() else { return };
        let Some(root) = self.vault_root.as_ref() else { return };
        let root = root.to_string_lossy().to_string();
        let absolute = index
            .into_iter()
            .map(|(rel, blocks)| {
                (format!("{}/{}", root.trim_end_matches('/'), rel.trim_start_matches('/')), blocks)
            })
            .collect();
        fp.install_index_for_test(absolute);
        self.footprint_revision = fp.revision();
        self.preview_dirty = true;
        cx.notify();
    }

    pub fn new(
        state: Arc<AppState>,
        mut event_rx: broadcast::Receiver<bnote_core::AppEvent>,
        last_vault: Option<PathBuf>,
        vim_bridge: VimBridge,
        snippets: SnippetBridge,
        ime: ImeServices,
        py_lsp: PyLspServices,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        // No placeholder: an empty editor shows the `.editor-empty` overlay
        // (TS has no CodeMirror placeholder either). No line numbers and no
        // fold gutter either — the TS editor is plain prose (`.cm-content`).
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language("markdown")
                .line_number(false)
                .folding(false)
                .soft_wrap(true)
        });
        // Snippets run with vim on or off; the bridge reads the mode from the
        // vim bridge, which stays the single mode authority.
        snippets.attach(editor.clone(), vim_bridge.clone(), cx);
        // The markdown Enter rule rides the editor's own Enter (TS installs
        // the same rule as a `Prec.highest` keymap entry on Enter), so a
        // keystroke the snippet bridge already consumed never reaches it.
        editor.update(cx, |state, cx| {
            state.set_enter_override(Some(std::rc::Rc::new(crate::editor::markdown_keys::enter_continue)), cx)
        });

        let tree_state = cx.new(|cx| TreeState::new(cx));
        let agent = cx.new(|cx| AgentPanel::new(state.clone(), window, cx));
        let cmd_state = cx.new(|cx| CommandState::new(window, cx));
        let files_state = cx.new(|cx| CommandState::new(window, cx));
        let link_state = cx.new(|cx| CommandState::new(window, cx));

        // The `settings` block (`config.json`, the Tauri shell's keys), read
        // once at startup — the settings modal keeps its own copy and writes
        // each change back under the same key.
        let startup = bnote_core::commands::config::load_app_config(state.as_ref())
            .ok()
            .unwrap_or(serde_json::Value::Null);
        let setting = |key: &str| {
            startup
                .get("settings")
                .and_then(|s| s.get(key))
                .and_then(|v| v.as_bool())
        };
        // `settings.latex` (the LaTeX-suite behavior block) is one file shared
        // with the Tauri shell: read it so the toggles the user set there apply
        // here too.
        snippets.set_latex_config(
            &editor,
            bnote_core::snippets::config::latex_config(&startup),
        );
        let code_block_lang = startup
            .get("settings")
            .and_then(|s| s.get("codeBlockLang"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| "ts".to_string());
        let font_size = startup
            .get("settings")
            .and_then(|s| s.get("fontSize"))
            .and_then(|v| v.as_f64())
            .map(|v| v as f32)
            .filter(|v| (12. ..=28.).contains(v))
            .unwrap_or(FONT_SIZE_DEFAULT);
        let theme_mode = match startup
            .get("settings")
            .and_then(|s| s.get("theme"))
            .and_then(|v| v.as_str())
        {
            Some("light") => ThemeMode::Light,
            _ => ThemeMode::Dark,
        };
        // The two stateful controls of the settings modal, created with the
        // loaded values so a first render already shows them.
        let lang_state = cx.new(|cx| InputState::new(window, cx));
        lang_state.update(cx, |st, cx| st.set_value(code_block_lang.clone(), window, cx));
        let hotkey_query = cx.new(|cx| InputState::new(window, cx).placeholder("搜索命令…"));
        let font_slider = cx.new(|_| {
            SliderState::new()
                .min(FONT_SIZE_MIN)
                .max(FONT_SIZE_MAX)
                .step(1.)
                .default_value(font_size)
        });
        font_slider.update(cx, |st, cx| st.set_value(font_size, window, cx));

        let qa_state = cx.new(|cx| CommandState::new(window, cx));
        let qa_name_state = cx.new(|cx| InputState::new(window, cx));
        let rename_state = cx.new(|cx| InputState::new(window, cx));
        // The ex command line's single field (`:` in a modal vim mode).
        let ex_state = cx.new(|cx| InputState::new(window, cx));
        // The IME follow reads its own settings copy out of the same config
        // block the modal writes. Its platform seams come in from `main`; the
        // tests wire inert ones (see `ImeServices`).
        let ime_settings = ime_cmd::ime_settings(&startup);
        let ime_services = ime;
        let ime = cx.new(|cx| {
            let host = ImeHost::new(state.clone(), ime_settings, ime_services.clone());
            host.warm_up(cx);
            host
        });
        // The ty follow: the editor's completion / hover hooks (TS
        // `pythonLspExtension`) plus the diagnostics the sync publishes.
        let py_lsp = cx.new(|_| PyLspHost::new(state.clone(), py_lsp));
        {
            let weak = py_lsp.downgrade();
            editor.update(cx, |state, _| {
                let lsp = state.lsp_mut();
                lsp.completion_provider = Some(Rc::new(PyCompletionProvider { host: weak.clone() }));
                lsp.hover_provider = Some(Rc::new(PyHoverProvider { host: weak }));
            });
        }

        // The study pane's read-only view: the same preview machinery, a
        // second instance (TS mounts a second CM6 view with the same
        // extensions). Read-only: nothing typed there can be saved, matching
        // the TS (its change/cursor callbacks are no-ops). Built before the
        // `cx.theme()` binding below, which keeps `cx` borrowed for the rest
        // of the constructor.
        let study_font = {
            let theme = cx.theme();
            PreviewFont {
                family: theme.font_family.clone(),
                size: theme.font_size,
            }
        };
        let study_preview = Rc::new(PreviewHost::new(study_font));
        let study_editor = cx.new(|cx| {
            let mut state = EditorState::new(window, cx).language("markdown").soft_wrap(true);
            state.set_readonly(true, cx);
            state
        });
        let study_styles = study_editor.update(cx, |state, cx| {
            state.create_decorations_collection(Vec::new(), cx)
        });
        study_editor.update(cx, |state, cx| {
            state.set_preview_renderer(Some(study_preview.clone()), cx)
        });
        let study_resize = cx.new(|_| gpui_kit::component::resizable::ResizableState::default());
        let study_url_state = cx.new(|cx| InputState::new(window, cx).placeholder("输入网址打开…"));

        let theme = cx.theme();
        // The preview measures widget widths in the editor's own font, so it
        // carries the same face the editor is styled with (UI font, editor
        // size — see `render_editor_column`).
        let preview = Rc::new(PreviewHost::new(PreviewFont {
            family: theme.font_family.clone(),
            size: theme.font_size,
        }));
        // The live-rendered copy of a display formula while editing it.
        // `keybindings.json` (the TS shell's override file). `main` applies it
        // to the keymap before the window opens; the modal edits the same map.
        let key_overrides = keybindings::load(&state);
        let live_preview = setting("livePreview").unwrap_or(true);
        let auto_save = setting("autoSave").unwrap_or(true);
        let math_preview = setting("mathPreview").unwrap_or(true);
        preview.set_math_preview(math_preview);
        editor.update(cx, |state, cx| {
            state.set_preview_renderer(Some(preview.clone()), cx);
        });
        // The live preview's text styles (the TS mark classes) ride their own
        // decoration collection; the editor tracks the ranges through edits.
        let preview_styles = editor.update(cx, |state, cx| {
            state.create_decorations_collection(Vec::new(), cx)
        });
        let study_split = normalize_split(
            startup
                .get("settings")
                .and_then(|s| s.get("studySplit"))
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    let agent = arr.first()?.as_f64()? as f32;
                    let content = arr.get(1)?.as_f64()? as f32;
                    Some([agent, content])
                })
                .unwrap_or(STUDY_SPLIT_DEFAULT),
        );

        let auto_number = setting("autoNumberHeadings").unwrap_or(false);
        let typewriter = setting("typewriter").unwrap_or(false);
        if typewriter {
            editor.update(cx, |state, cx| state.set_center_cursor(true, cx));
        }
        // `settings.snippets` (TS default on): the source is whatever the
        // loader installs, the flag only gates the engine.
        let snippets_enabled = setting("snippets").unwrap_or(true);
        snippets.set_enabled(&editor, snippets_enabled);

        // Drive autosave + dirty flag off editor changes, and refresh the
        // live preview when either the text or the caret moved.
        let subscriptions = vec![
            // The sidebar's expand/collapse is the user's state, so it is
            // recorded here (the only writer) and re-applied whenever the
            // vault index rebuilds the items (TS `Sidebar`'s `expanded`).
            cx.subscribe(&tree_state, |this, _, event: &gpui_kit::base::TreeEvent, cx| {
                match event {
                    gpui_kit::base::TreeEvent::Expanded(id) => {
                        this.expanded_dirs.insert(id.to_string());
                    }
                    gpui_kit::base::TreeEvent::Collapsed(id) => {
                        this.expanded_dirs.remove(id.as_ref());
                    }
                }
                cx.notify();
            }),
            cx.subscribe(&editor, |this, _editor, event: &InputEvent, cx| {
                this.preview_dirty = true;
                this.on_edited(cx);
                this.schedule_renumber(event, cx);
                // TS's `pythonLspExtension` updateListener: every document
                // change restarts the 500 ms sync timer.
                if matches!(event, InputEvent::Change { .. }) {
                    this.schedule_py_lsp_sync(cx);
                }
            }),
            cx.observe(&editor, |this, editor, cx| {
                let selection = editor.read(cx).selected_range();
                if this.preview_selection.as_ref() != Some(&selection) {
                    this.preview_selection = Some(selection);
                    this.preview_dirty = true;
                    // The status bar's 行/列 readout follows the caret (TS
                    // `updateStatus` rides `selectionSet`).
                    this.update_cursor_label(cx);
                    // Cursor memory rides the same signal: the caret moved.
                    this.schedule_cursor_save(cx);
                    // So does the IME follow: entering insert inside a formula
                    // must keep English (the caret moved into the region).
                    this.ime_sync(cx);
                    cx.notify();
                }
            }),
            // Losing the window persists the caret before the user walks away
            // with the app in the background (TS flushes on window blur too).
            cx.observe_window_activation(window, |this, window, cx| {
                if !window.is_window_active() {
                    this.flush_cursor_save_now(cx);
                    // Hand the user's own input source back (TS
                    // `imeOnWindowBlur`).
                    let ime = this.ime.clone();
                    ime.update(cx, |host, cx| host.on_window_blur(cx));
                } else {
                    // Back in front: a fresh baseline, then whatever the
                    // current context wants (TS `imeOnWindowFocus`).
                    let ime = this.ime.clone();
                    ime.update(cx, |host, _cx| host.on_window_focus());
                    this.ime_sync(cx);
                }
            }),
            // The study panes' drag release: persist the fractions (TS's
            // pointer-up `patchSettings({ studySplit })`).
            cx.subscribe_in(
                &study_resize,
                window,
                |this, _state, _event: &gpui_kit::component::resizable::ResizablePanelEvent, _window, cx| {
                    this.persist_study_split(cx);
                },
            ),
            // The modal's code-block-language field: `set_value` is silent, so
            // every Change here is the user's typing.
            cx.subscribe(&lang_state, |this, input, event: &InputEvent, cx| {
                if !matches!(event, InputEvent::Change { .. }) {
                    return;
                }
                let lang = input.read(cx).value().to_string();
                if this.code_block_lang == lang {
                    return;
                }
                this.code_block_lang = lang.clone();
                this.persist_setting("codeBlockLang", serde_json::json!(lang), cx);
            }),
            // The study toolbar's URL box: Enter opens the address (TS
            // `openUrl`).
            cx.subscribe_in(&study_url_state, window, |this, input, event: &InputEvent, _window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    let url = input.read(cx).value().trim().to_string();
                    if !url.is_empty() {
                        this.open_study_url(url, cx);
                    }
                }
            }),
            // The rename dialog's field: Enter commits.
            cx.subscribe(&rename_state, |this, _input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.commit_rename(cx);
                }
            }),
            // The ex command line: Enter runs what was typed.
            cx.subscribe_in(&ex_state, window, |this, _input, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.commit_ex(window, cx);
                }
            }),
            // The quick-add name field: its Enter creates, its Tab returns to
            // the command pick (TS binds both on the input).
            cx.subscribe(&qa_name_state, |this, _input, event: &InputEvent, cx| {
                match event {
                    InputEvent::PressEnter { .. } => this.qa_create(cx),
                    InputEvent::Change { .. } => cx.notify(),
                    _ => {}
                }
            }),
            // The font-size slider: applies while dragging (TS's range input
            // fires per move) and writes back on release.
            cx.subscribe(&font_slider, |this, slider, event: &SliderEvent, cx| {
                let size = slider.read(cx).value().start();
                if this.font_size == size {
                    return;
                }
                this.font_size = size;
                crate::theme::apply_font_size(size, cx);
                if matches!(event, SliderEvent::Release(_)) {
                    this.persist_setting("fontSize", serde_json::json!(size), cx);
                }
            }),
        ];

        let mut workspace = Self {
            state,
            vault_root: None,
            tree_state,
            editor,
            open_path: None,
            dirty: false,
            save_seq: 0,
            autosave_gen: 0,
            save_guard: Arc::new(Mutex::new(0)),
            status: "未打开仓库".to_string(),
            cursor_label: String::new(),
            daily: None,
            footprint: None,
            footprint_revision: 0,
            footprint_fold: bnote_core::footprint::view::default_fold(),
            pending_open_line: None,
            sidebar_open: true,
            agent,
            agent_open: false,
            palette: None,
            cmd_state,
            files_state,
            files: Vec::new(),
            mru: Vec::new(),
            expanded_dirs: std::collections::HashSet::new(),
            tree_dirs: std::collections::HashSet::new(),
            header_returns: ops::HeaderTodoReturnMap::new(),
            daily_back_from: None,
            toast: None,
            toast_gen: 0,
            vim_bridge,
            vim_enabled: false,
            #[cfg(feature = "harness-shot")]
            diag_hits: std::rc::Rc::new(std::cell::Cell::new(0)),
            snippets,
            snippet_marks_rows: None,
            today: today_string(),
            preview,
            preview_dirty: true,
            preview_selection: None,
            preview_styles,
            auto_number,
            renumber_pending: false,
            renumber_done_rev: None,
            link_suggest: false,
            link_query: String::new(),
            link_pick_rev: None,
            link_state,
            key_overrides: key_overrides.clone(),
            hotkey_query,
            hotkey_filter: HotkeyFilter::All,
            hotkey_capturing: None,
            hotkey_capture_sub: None,
            settings_open: false,
            settings_tab: SettingsTab::General,
            live_preview,
            auto_save,
            math_preview,
            typewriter,
            code_block_lang,
            theme_mode,
            font_size,
            snippets_enabled,
            tree_menu: None,
            rename_prompt: None,
            rename_state,
            ex_open: false,
            ex_state,
            window_handle: window.window_handle(),
            ime,
            ime_services,
            ime_sources: Vec::new(),
            ime_loading: false,
            ime_pick: None,
            python_run: PyRunState::default(),
            py_body: String::new(),
            py_body_highlights: Vec::new(),
            py_scroll: ScrollHandle::default(),
            py_lsp,
            py_lsp_seq: 0,
            study_mode: false,
            study_split,
            study_content: None,
            study_editor,
            study_preview,
            study_styles,
            study_dirty: false,
            study_rows: None,
            study_resize,
            study_session_for: None,
            study_url_state,
            qa_open: false,
            qa_naming: false,
            qa_picked: None,
            qa_commands: Vec::new(),
            qa_state,
            qa_name_state,
            qa_rows: Vec::new(),
            qa_next_row_id: 1,
            lang_state,
            font_slider,
            cursor_pending: None,
            cursor_save_seq: 0,
            cursor_guard: Arc::new(Mutex::new(0)),
            _subscriptions: subscriptions,
        };

        // The keymap: registry defaults plus `keybindings.json` (TS
        // `keybindingOverrides.ts`). The workspace owns `key_overrides`, so it
        // is also the one that pushes them into gpui — every edit re-applies.
        keybindings::apply(cx, &key_overrides);

        // A vimrc mapping that names a command the shell does not have says
        // so in the status line instead of failing silently.
        {
            let weak = cx.weak_entity();
            workspace.vim_bridge.clone().set_message_observer(move |message, cx| {
                weak.update(cx, |this, cx| {
                    this.status = message;
                    cx.notify();
                })
                .ok();
            });
        }
        // `:` in a modal vim mode opens the ex command line.
        {
            // The workspace holds its own window handle: the observer fires
            // from the app-level interceptor, where a synchronous window
            // update would re-enter the keystroke dispatch (gpui rejects
            // that), so the open hops to the executor first.
            let handle = workspace.window_handle;
            let weak = cx.weak_entity();
            workspace.vim_bridge.clone().set_ex_observer(move |cx| {
                let weak = weak.clone();
                cx.spawn(async move |cx| {
                    cx.update(|cx| {
                        let _ = handle.update(cx, |_view, window, cx| {
                            weak.update(cx, |this, cx| this.open_ex_line(window, cx))
                        });
                    });
                })
                .detach();
            });
        }
        // The global vimrc is per-app, not per-vault: load it even before a
        // vault is open (the vault one joins when the vault does).
        workspace.load_vimrc(cx);

        // Restore the vault off the main thread, then build the tree.
        if let Some(vault) = last_vault {
            workspace.restore_vault(vault, cx);
        }

        // Event loop: poll the backend bus (vault-changed → tree + footprint +
        // external reload; agent-event → panel) and pump the footprint core.
        cx.spawn(async move |this, cx| {
            let mut iter: u32 = 0;
            loop {
                cx.background_executor().timer(EVENT_POLL_INTERVAL).await;
                iter = iter.wrapping_add(1);
                let mut events = Vec::new();
                let mut closed = false;
                loop {
                    match event_rx.try_recv() {
                        Ok(ev) => events.push(ev),
                        Err(broadcast::error::TryRecvError::Lagged(_)) => events.clear(),
                        Err(broadcast::error::TryRecvError::Empty) => break,
                        Err(broadcast::error::TryRecvError::Closed) => {
                            closed = true;
                            break;
                        }
                    }
                }
                let tick = iter % FOOTPRINT_TICK_EVERY == 0;
                let cont = this.update(cx, |this, cx| {
                    for ev in events {
                        this.handle_event(ev, cx);
                    }
                    if tick {
                        if let Some(fp) = &this.footprint {
                            fp.tick(&this.today);
                            // A bumped revision means blocks appeared/moved:
                            // the source-side footprint pips are stale.
                            let revision = fp.revision();
                            if revision != this.footprint_revision {
                                this.footprint_revision = revision;
                                this.preview_dirty = true;
                                cx.notify();
                            }
                        }
                    }
                    true
                });
                if closed || !cont.unwrap_or(false) {
                    return;
                }
            }
        })
        .detach();


        // The IME follow's second editor trigger: the key that just changed
        // vim's mode. Esc out of insert moves neither text nor caret, so the
        // selection observer never sees it.
        {
            let weak = cx.weak_entity();
            workspace.vim_bridge.set_mode_observer(move |_mode, cx| {
                let _ = weak.update(cx, |this, cx| this.ime_sync(cx));
            });
        }

        // Restore the vim setting (same config.json key the Tauri shell uses).
        let vim_enabled = setting("vim").unwrap_or(false);
        if vim_enabled {
            workspace.vim_enabled = true;
            workspace.set_vim_enabled(true, cx);
            workspace.status = "vim 模式开启(普通模式)".to_string();
        }

        // The caret position of the closing window is written synchronously —
        // the debounced write would be racing the process teardown. A dirty
        // note buffer is flushed the same way (TS `EditorPane`'s unmount),
        // so quitting never costs the last edit, auto-save or not.
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_window, cx| {
            weak.update(cx, |workspace, cx| {
                workspace.flush_cursor_save_blocking();
                workspace.flush_note_save_blocking(cx);
            })
            .ok();
            true
        });

        // Focus the editor so global actions bubble through this view.
        let focus_handle = workspace.editor.focus_handle(cx);
        window.defer(cx, move |window, cx| {
            focus_handle.focus(window, cx);
        });

        #[cfg(feature = "harness-shot")]
        workspace.debug_schedule_diag(window, cx);

        workspace
    }

    fn handle_event(&mut self, ev: bnote_core::AppEvent, cx: &mut Context<Self>) {
        match ev.name.as_str() {
            "vault-changed" => {
                let paths: Vec<String> =
                    serde_json::from_value(ev.payload).unwrap_or_default();
                if paths
                    .iter()
                    .any(|p| p.ends_with(".bnote/snippets.js"))
                {
                    // The vault snippet source changed on disk: reload it (the
                    // Tauri shell hot-reloads the same file on save).
                    self.load_vault_snippets(cx);
                }
                if paths.iter().any(|p| p.ends_with(".bnote/vimrc")) {
                    self.load_vimrc(cx);
                }
                if let Some(fp) = &self.footprint {
                    fp.note_dirty(&paths);
                }
                self.invalidate_images(&paths, cx);
                self.reload_open_if_externally_changed(&paths, cx);
                self.refresh_tree(cx);
            }
            "python-run-output" => {
                // The run id is the self-check: a chunk from a previous run
                // (or another note's run) never lands in this panel.
                let run_id = ev.payload.get("runId").and_then(|v| v.as_u64());
                if !self.python_run.running || self.python_run.run_id != run_id {
                    return;
                }
                let stream = match ev.payload.get("stream").and_then(|v| v.as_str()) {
                    Some("stderr") => PyStream::Stderr,
                    Some("system") => PyStream::System,
                    _ => PyStream::Stdout,
                };
                let text = ev
                    .payload
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                self.py_push_output(stream, text, cx);
            }
            "python-lsp-diagnostics" => {
                let md_path = ev
                    .payload
                    .get("mdPath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let diagnostics = ev
                    .payload
                    .get("diagnostics")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let tracked = self.py_lsp.read(cx).path().map(str::to_string);
                if tracked.as_deref() == Some(md_path.as_str()) {
                    self.py_lsp.update(cx, |host, cx| host.set_raw(&md_path, diagnostics, cx));
                    self.apply_py_diagnostics(cx);
                }
            }
            "python-run-exit" => {
                let run_id = ev.payload.get("runId").and_then(|v| v.as_u64());
                if !self.python_run.running || self.python_run.run_id != run_id {
                    return;
                }
                let exit_code = ev
                    .payload
                    .get("exitCode")
                    .and_then(|v| v.as_i64())
                    .map(|code| code as i32);
                let duration_ms = ev
                    .payload
                    .get("durationMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cancelled = ev.payload.get("cancelled").and_then(|v| v.as_bool()).unwrap_or(false);
                let timed_out = ev.payload.get("timedOut").and_then(|v| v.as_bool()).unwrap_or(false);
                self.python_run.finish(exit_code, duration_ms, cancelled, timed_out);
                cx.notify();
            }
            "agent-event" => {
                let session = ev
                    .payload
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(event) = ev.payload.get("event") {
                    self.agent.update(cx, |panel, cx| {
                        panel.on_agent_event(&session, event, cx)
                    });
                }
            }
            _ => {}
        }
    }

    /// A file the editor has open changed on disk (watcher): reload it unless
    /// the local buffer is dirty (the Tauri shell's same rule). Self-writes
    /// from the daily sync land here too — reloading them is correct.
    fn reload_open_if_externally_changed(&mut self, paths: &[String], cx: &mut Context<Self>) {
        if self.dirty || self.open_path.is_none() || paths.is_empty() {
            return;
        }
        let Some(root) = self.vault_root.clone() else { return };
        let Some(rel) = self.open_path.clone() else { return };
        let open_abs = root.join(&rel).to_string_lossy().to_string();
        let hit = paths
            .iter()
            .any(|p| p == &rel || PathBuf::from(p).to_string_lossy() == open_abs);
        if !hit {
            return;
        }
        let state = self.state.clone();
        let full = root.join(&rel);
        cx.spawn(async move |this, cx| {
            let text = cx
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::files::read_file(
                        &state,
                        full.to_string_lossy().to_string(),
                    )
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                // Re-validate: the user may have started editing meanwhile.
                if this.dirty || this.open_path.as_deref() != Some(rel.as_str()) {
                    return;
                }
                if let Ok(text) = text {
                    // TS `App.tsx`'s self-write echo: autosave/manual save
                    // triggered the watcher, and disk already matches memory.
                    // Reloading would reset the caret and kill live vim and
                    // snippet sessions for zero change.
                    if text == this.editor.read(cx).text().to_string() {
                        return;
                    }
                    this.install_text(rel.clone(), text, window, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn restore_vault(&mut self, vault: PathBuf, cx: &mut Context<Self>) {
        let state = self.state.clone();
        cx.spawn(async move |this, cx| {
            let info = cx
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::vault::set_vault(
                        &state,
                        vault.to_string_lossy().to_string(),
                    )
                })
                .await;
            match info {
                Ok(info) => {
                    let ok = this.update(cx, |this, cx| {
                        this.on_vault_ready(PathBuf::from(&info.path), &info.name, cx)
                    });
                    if ok.is_ok() {
                        let tree = this.update(cx, |this, _cx| this.tree_state.clone());
                        if let Ok(tree) = tree {
                            reload_tree(this.clone(), tree, cx).await;
                        }
                    }
                }
                Err(e) => {
                    this.update(cx, |this, cx| {
                        this.report_failure(format!("打开仓库失败:{e}"), cx);
                        cx.notify();
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// Runs on the UI thread once the backend accepted the vault.
    fn on_vault_ready(&mut self, root: PathBuf, name: &str, cx: &mut Context<Self>) {
        self.vault_root = Some(root.clone());
        self.status = format!("仓库:{}", name);
        // Cached images belong to the vault that is gone; references resolve
        // against the new root from here on.
        self.preview.images().clear();
        self.preview.images().set_vault_root(root.clone());
        self.preview.images().set_doc_dir(None);
        self.load_vault_snippets(cx);
        self.load_vimrc(cx);
        self.daily = Some(Arc::new(DailyHost::new(self.state.clone(), &root)));
        let fp = Arc::new(FootprintHost::new(&root));
        self.footprint = Some(fp.clone());
        // The hosts land *after* any scan that ran while the vault was
        // opening, and their state (synced links, footprint blocks) is what
        // the line marks are built from: the snapshot those scans installed
        // is stale by construction, so the next one must be rebuilt even
        // when nothing else changed.
        self.preview_dirty = true;
        let today = self.today.clone();
        cx.spawn(async move |_this, cx| {
            cx.background_executor().spawn(async move { fp.init(&today) }).await;
        })
        .detach();
        cx.notify();
    }

    /// Load `vimrc` mappings: the global file in the app-data dir first, then
    /// the vault's `.bnote/vimrc` (which wins for the same mode + lhs) — the
    /// Tauri shell's `loadVimrc` order. Unparsable lines are reported in the
    /// status line rather than dropped silently.
    fn load_vimrc(&mut self, cx: &mut Context<Self>) {
        let state = self.state.clone();
        let root = self.vault_root.clone();
        let bridge = self.vim_bridge.clone();
        cx.spawn(async move |this, cx| {
            let read = cx
                .background_executor()
                .spawn(async move {
                    let global = bnote_core::commands::config::read_vimrc(&state)
                        .ok()
                        .flatten();
                    let vault = root
                        .map(|root| root.join(".bnote").join("vimrc"))
                        .and_then(|path| std::fs::read_to_string(path).ok());
                    (global, vault)
                })
                .await;
            let report = bridge.set_vimrc(read.0.as_deref(), read.1.as_deref());
            this.update(cx, |this, cx| {
                for error in &report.errors {
                    eprintln!("[vimrc] {error}");
                }
                this.status = if report.mappings == 0 && report.errors.is_empty() {
                    this.status.clone()
                } else if report.errors.is_empty() {
                    format!("vimrc:{} 条映射", report.mappings)
                } else {
                    format!(
                        "vimrc:{} 条映射,{} 行未识别(见控制台)",
                        report.mappings,
                        report.errors.len()
                    )
                };
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Read `<vault>/.bnote/snippets.js` and, when it yields snippet
    /// definitions, replace the built-in set with it (the TS source-ownership
    /// rule: the file replaces, never stacks).
    ///
    /// The file is a JS module; `bnote_core::snippets::js_module` reads it
    /// statically (regex literals, comments, the one function replacement —
    /// see `load.rs`). A file that parses but carries an entry the engine
    /// cannot bind reports it in the status line and on stderr; a file that
    /// does not parse keeps the built-ins with the error in the status line,
    /// the TS error path.
    fn load_vault_snippets(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.vault_root.clone() else { return };
        let path = root.join(".bnote").join("snippets.js");
        if !path.is_file() {
            self.snippets.use_builtins(&self.editor);
            self.status = format!("仓库:{}", self.vault_name());
            return;
        }
        let editor = self.editor.clone();
        let snippets = self.snippets.clone();
        cx.spawn(async move |this, cx| {
            let read = cx
                .background_executor()
                .spawn(async move { std::fs::read_to_string(&path) })
                .await;
            this.update(cx, |this, cx| {
                match read {
                    Ok(source) => match snippets.load_source(&editor, &source) {
                        Ok(skipped) => {
                            let count = snippets.snippet_count(&editor);
                            this.status = if skipped.is_empty() {
                                format!("公式片段 {count} 条(仓库)")
                            } else {
                                for reason in &skipped {
                                    eprintln!("[snippets] {reason}");
                                }
                                format!(
                                    "公式片段 {count} 条(仓库),跳过 {} 条(见控制台)",
                                    skipped.len()
                                )
                            };
                        }
                        Err(e) => {
                            snippets.use_builtins(&editor);
                            this.status = format!("仓库片段未生效,已回到内置集:{e}");
                        }
                    },
                    Err(e) => {
                        snippets.use_builtins(&editor);
                        this.report_failure(format!("读取仓库片段失败:{e}"), cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn vault_name(&self) -> String {
        self.vault_root
            .as_ref()
            .and_then(|r| r.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    /// The open note's absolute path — the status bar's right end shows this
    /// (TS `.file-hint` prints `currentFile`, which is absolute).
    fn open_note_abs_path(&self) -> String {
        match (&self.vault_root, &self.open_path) {
            (Some(root), Some(rel)) => root.join(rel).to_string_lossy().to_string(),
            _ => String::new(),
        }
    }

    fn on_edited(&mut self, cx: &mut Context<Self>) {
        self.dirty = true;
        self.save_seq += 1;
        self.update_cursor_label(cx);
        if self.auto_save {
            // The pending timer carries the generation it was scheduled under;
            // turning the switch off invalidates it (TS clears the timeout).
            let seq = self.save_seq;
            let gen = self.autosave_gen;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(AUTOSAVE_DEBOUNCE).await;
                save_snapshot(this, seq, Some(gen), cx).await;
            })
            .detach();
        }
        cx.notify();
    }

    /// Heading auto-numbering (the TS `setup.ts` updateListener plus
    /// `numbering.ts`): after a document change, run one renumbering pass.
    /// Three gates, each mirroring a TS condition — the setting is on, the
    /// change is the user's (an undo/redo replay must not re-apply the
    /// numbers it just removed, or undo never takes), and it is not the
    /// pass's own edit (the revision check; the pass runs in `render`, so
    /// its `Change` arrives only afterwards).
    fn schedule_renumber(&mut self, event: &InputEvent, cx: &mut Context<Self>) {
        if !self.auto_number {
            return;
        }
        let rev = self.editor.read(cx).document_revision();
        if !should_schedule_renumber(event, rev, self.renumber_done_rev) {
            return;
        }
        self.renumber_pending = true;
        cx.notify();
    }

    /// TS `cursorMemory.ts::scheduleCursorSave` — remember where the user is
    /// in the open note, 300 ms after they stop moving. A newer request
    /// invalidates the older timer (seq comparison in `flush_cursor_save`).
    fn schedule_cursor_save(&mut self, cx: &mut Context<Self>) {
        // Absolute, like the restore side and the Tauri shell (see
        // [`Self::restore_cursor_memory`]).
        let Some(path) = self.open_note_abs() else {
            return;
        };
        let (pos, scroll) = {
            let editor = self.editor.read(cx);
            (editor.cursor(), editor.scroll_offset().y / px(1.))
        };
        self.cursor_pending = Some((path, pos, scroll));
        self.cursor_save_seq += 1;
        let seq = self.cursor_save_seq;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CURSOR_SAVE_DEBOUNCE).await;
            this.update(cx, |this, cx| this.flush_cursor_save(seq, cx))
                .ok();
        })
        .detach();
    }

    /// The debounced writer: only the newest request writes (a stale timer
    /// whose seq was superseded must not even touch the disk).
    fn flush_cursor_save(&mut self, seq: u64, cx: &mut Context<Self>) {
        if seq != self.cursor_save_seq {
            return;
        }
        self.write_cursor_pending(seq, cx);
    }

    /// Unconditional flush — file switch, window close. `seq` is the newest,
    /// so the write always goes through.
    fn flush_cursor_save_now(&mut self, cx: &mut Context<Self>) {
        let seq = self.cursor_save_seq;
        self.write_cursor_pending(seq, cx);
    }

    /// Hand the pending position to the background executor. The guard holds
    /// the last seq written, so a slow older write is dropped instead of
    /// landing after a newer one (the `save_guard` rule, same shape).
    fn write_cursor_pending(&mut self, seq: u64, cx: &mut Context<Self>) {
        let Some((path, pos, scroll)) = self.cursor_pending.take() else {
            return;
        };
        let state = self.state.clone();
        let guard = self.cursor_guard.clone();
        cx.background_executor()
            .spawn(async move {
                let mut last = guard.lock().unwrap();
                if seq <= *last {
                    return;
                }
                let mut config = bnote_core::commands::config::load_app_config(&state)
                    .unwrap_or(serde_json::Value::Null);
                bnote_core::commands::config::set_cursor_position(&mut config, &path, pos, scroll);
                match bnote_core::commands::config::save_app_config(&state, config) {
                    Ok(()) => *last = seq,
                    Err(e) => eprintln!("cursor memory: 写入失败 {e}"),
                }
            })
            .detach();
    }

    /// The quit path: one synchronous config write, because the async flush
    /// may not get a turn before the process exits. Small and rare — the same
    /// trade-off the Tauri shell makes in its `beforeunload` handler.
    fn flush_cursor_save_blocking(&mut self) {
        let Some((path, pos, scroll)) = self.cursor_pending.take() else {
            return;
        };
        let mut config = bnote_core::commands::config::load_app_config(&self.state)
            .unwrap_or(serde_json::Value::Null);
        bnote_core::commands::config::set_cursor_position(&mut config, &path, pos, scroll);
        if let Err(e) = bnote_core::commands::config::save_app_config(&self.state, config) {
            eprintln!("cursor memory: 写入失败 {e}");
        }
    }

    /// The quit path's note flush: a dirty buffer is written before the window
    /// goes away, whatever the auto-save switch says. The UI bookkeeping of
    /// the async path (status, editor reload) is skipped — there is no next
    /// frame — but the daily-sync follow-ups are not: they are part of the
    /// save, and dropping them would leave the daily file stale.
    /// TS `showToast`: one transient message at the bottom, 2.6 s. A newer
    /// toast replaces it and restarts the clock — the generation makes the
    /// older timer a no-op (the `save_guard` rule: one writer, stale drops).
    pub(crate) fn show_toast(&mut self, message: impl Into<String>, cx: &mut Context<Self>) {
        self.toast = Some(message.into());
        self.toast_gen += 1;
        let gen = self.toast_gen;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TOAST_DURATION).await;
            this.update(cx, |this, cx| {
                if this.toast_gen == gen {
                    this.toast = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// A failure the user must see: the status bar carries no message text
    /// in the TS shell, so failures go to the toast (TS `showToast`) — the
    /// status string is kept for tests and diagnostics.
    fn report_failure(&mut self, message: String, cx: &mut Context<Self>) {
        self.status = message.clone();
        self.show_toast(message, cx);
    }

    /// The toast overlay: fixed above the status bar, centered (the TS
    /// `.toast` styles — popover background, border, 8px radius).
    fn render_toast(&self, cx: &Context<Self>) -> Option<impl IntoElement> {
        let message = self.toast.as_ref()?;
        let theme = cx.theme().clone();
        Some(
            div()
                .id("toast")
                .absolute()
                .bottom(px(44.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .rounded_lg()
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .text_color(theme.popover_foreground)
                        .px(px(18.))
                        .py(px(9.))
                        .text_size(px(13.))
                        .child(Label::new(message.clone())),
                ),
        )
    }

    fn flush_note_save_blocking(&mut self, cx: &mut gpui::App) {
        if !self.dirty {
            return;
        }
        let (Some(root), Some(rel)) = (self.vault_root.clone(), self.open_path.clone()) else {
            return;
        };
        let text = self.editor.read(cx).value().to_string();
        self.save_seq += 1;
        let seq = self.save_seq;
        let abs = root.join(&rel).to_string_lossy().to_string();
        write_note_and_followups(
            &self.state,
            &self.save_guard,
            self.daily.as_deref(),
            &self.today,
            abs,
            text,
            seq,
        );
    }

    /// TS `restoreSavedCursor` — put the caret back where the user left this
    /// note, scroll included. No-op for a note never visited. The scroll
    /// offset is deferred by the engine to the next layout, which is exactly
    /// when the freshly installed text has a scroll range.
    fn restore_cursor_memory(&mut self, rel_path: &str, cx: &mut Context<Self>) {
        let Ok(config) = bnote_core::commands::config::load_app_config(&self.state) else {
            return;
        };
        // The key is the **absolute** path: the Tauri shell writes
        // `cursorPositions` under the path it opened the note with, and both
        // shells share one `config.json` — a relative key here would give each
        // shell its own cursor memory and neither would see the other's.
        let Some(abs) = self
            .vault_root
            .as_ref()
            .map(|root| root.join(rel_path).to_string_lossy().to_string())
        else {
            return;
        };
        let Some((pos, scroll)) = bnote_core::commands::config::cursor_position(&config, &abs)
        else {
            return;
        };
        self.editor.update(cx, |editor, cx| {
            let pos = pos.min(editor.text().len());
            editor.set_selected_range(pos..pos, cx);
            editor.set_scroll_offset(point(px(0.), px(scroll)), cx);
        });
    }

    /// Runs the pending renumbering pass. It re-derives the edits from the
    /// *current* text, so any number of changes between the schedule and the
    /// frame cost one pass and nothing goes stale.
    fn apply_pending_renumber(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.auto_number {
            return;
        }
        let text = self.editor.read(cx).value().to_string();
        let edits = bnote_core::markdown::numbering::renumber_changes(&text);
        if edits.is_empty() {
            return;
        }
        let ranges: Vec<(std::ops::Range<usize>, String)> =
            edits.into_iter().map(|e| (e.from..e.to, e.insert)).collect();
        self.renumber_done_rev = apply_edits_keeping_cursor(&self.editor, &ranges, window, cx);
    }

    fn update_cursor_label(&mut self, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        let byte = self.editor.read(cx).cursor();
        let (line, col) = crate::apply_ops::byte_to_line_col(&text, byte);
        // TS `updateStatus`: `行 ${line.number}，列 ${pos - line.from + 1}`.
        self.cursor_label = format!("行 {line}，列 {}", col + 1);
    }

    // ---- command handlers -------------------------------------------------

    fn save_now(&mut self, _: &actions::Save, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.dirty {
            self.status = "没有未保存的改动".to_string();
            cx.notify();
            return;
        }
        self.save_seq += 1;
        let seq = self.save_seq;
        cx.spawn(async move |this, cx| save_snapshot(this, seq, None, cx).await).detach();
    }

    fn run_edit(
        &mut self,
        out: Option<ops::OpsOutcome>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(out) = out {
            apply_outcome(&self.editor, &out, window, cx);
        }
    }

    fn sel(&self, cx: &Context<Self>) -> ops::Sel {
        let byte = self.editor.read(cx).cursor();
        ops::Sel::cursor(byte)
    }

    fn toggle_todo(&mut self, _: &actions::ToggleTodo, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        let sel = self.sel(cx);
        let out = ops::toggle_todo(&text, &[sel], &self.today);
        self.run_edit(out, window, cx);
    }

    fn cycle_heading(
        &mut self,
        _: &actions::CycleHeading,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.editor.read(cx).value().to_string();
        let sel = self.sel(cx);
        // H4 and deeper cycle into a paragraph, leaving the old number behind
        // in body text; the renumbering pass only rewrites heading prefixes.
        let (line_start, demoted) = cycle_demotes_cursor_line(&text, sel.head);
        let out = ops::cycle_heading(&text, &[sel]);
        self.run_edit(out, window, cx);
        if demoted {
            self.clear_leftover_number(line_start, window, cx);
        }
    }

    fn set_heading(&mut self, level: usize, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        let sel = self.sel(cx);
        // Toggling the level off (`## x` with level 2) demotes to a paragraph.
        let (line_start, demoted) = level_toggle_demotes_cursor_line(&text, sel.head, level);
        let out = ops::toggle_heading(&text, &[sel], level);
        self.run_edit(out, window, cx);
        if demoted {
            self.clear_leftover_number(line_start, window, cx);
        }
    }

    /// Delete the old-number prefix a demoted heading leaves in body text
    /// (the TS `builtin.ts::settleHeadingNumbering` `headingRemoved` branch).
    /// The full renumbering pass is not run here — the edit below trips the
    /// editor subscription, so the pass lands in the same frame anyway.
    fn clear_leftover_number(
        &mut self,
        line_start: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.auto_number {
            return;
        }
        let text = self.editor.read(cx).value().to_string();
        // The edit only rewrote this line's prefix, so the line still starts
        // where it did; clamping covers an edit that shortened the document.
        let line_start = line_start.min(text.len());
        let line_end = text[line_start..]
            .find('\n')
            .map(|i| line_start + i)
            .unwrap_or(text.len());
        let len = numbering::leading_number_len(&text[line_start..line_end]);
        if len == 0 {
            return;
        }
        // Deliberately not recorded as a renumbering revision: the pass that
        // follows this edit must still run.
        let _ = apply_edits_keeping_cursor(
            &self.editor,
            &[(line_start..line_start + len, String::new())],
            window,
            cx,
        );
    }

    fn heading1(&mut self, _: &actions::Heading1, w: &mut Window, cx: &mut Context<Self>) {
        self.set_heading(1, w, cx)
    }
    fn heading2(&mut self, _: &actions::Heading2, w: &mut Window, cx: &mut Context<Self>) {
        self.set_heading(2, w, cx)
    }
    fn heading3(&mut self, _: &actions::Heading3, w: &mut Window, cx: &mut Context<Self>) {
        self.set_heading(3, w, cx)
    }
    fn heading4(&mut self, _: &actions::Heading4, w: &mut Window, cx: &mut Context<Self>) {
        self.set_heading(4, w, cx)
    }
    fn heading5(&mut self, _: &actions::Heading5, w: &mut Window, cx: &mut Context<Self>) {
        self.set_heading(5, w, cx)
    }
    fn heading6(&mut self, _: &actions::Heading6, w: &mut Window, cx: &mut Context<Self>) {
        self.set_heading(6, w, cx)
    }

    fn toggle_bullet(
        &mut self,
        _: &actions::ToggleBulletList,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.editor.read(cx).value().to_string();
        let sel = self.sel(cx);
        let out = ops::toggle_list(&text, &[sel], ops::ListKind::Bullet);
        self.run_edit(out, window, cx);
    }

    fn toggle_numbered(
        &mut self,
        _: &actions::ToggleNumberedList,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.editor.read(cx).value().to_string();
        let sel = self.sel(cx);
        let out = ops::toggle_list(&text, &[sel], ops::ListKind::Numbered);
        self.run_edit(out, window, cx);
    }

    fn toggle_wrap(&mut self, marker: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        let (anchor, head) = {
            let ed = self.editor.read(cx);
            let r = ed.selected_range();
            (r.start, r.end)
        };
        let sel = ops::Sel::range(anchor, head);
        let out = ops::toggle_wrap(&text, &[sel], marker);
        self.run_edit(out, window, cx);
    }

    fn toggle_bold(&mut self, _: &actions::ToggleBold, w: &mut Window, cx: &mut Context<Self>) {
        self.toggle_wrap("**", w, cx)
    }
    fn toggle_italic(&mut self, _: &actions::ToggleItalic, w: &mut Window, cx: &mut Context<Self>) {
        self.toggle_wrap("*", w, cx)
    }
    fn toggle_strikethrough(
        &mut self,
        _: &actions::ToggleStrikethrough,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_wrap("~~", w, cx)
    }
    fn insert_inline_code(
        &mut self,
        _: &actions::InsertInlineCode,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_wrap("`", w, cx)
    }

    /// `edit.insert-wikilink` (⌘K) — TS `linkShortcut`: the caret line already
    /// holds a link → jump to that note (one link per line, so inserting
    /// again would only duplicate it); otherwise open the completion panel at
    /// the caret.
    fn insert_wikilink(
        &mut self,
        _: &actions::InsertWikilink,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A palette or the settings modal owns the foreground: nothing to do
        // (TS `if (modal) return`).
        if self.palette.is_some() || self.settings_open {
            return;
        }
        // Pressed again while open: put it away (TS `if (linkSuggest) close()`).
        if self.link_suggest {
            self.close_link_suggest(window, cx);
            return;
        }
        let Some(open) = self.open_path.clone() else {
            self.status = "先打开一篇笔记，再插入链接".to_string();
            cx.notify();
            return;
        };
        let (text, cursor) = {
            let ed = self.editor.read(cx);
            (ed.value().to_string(), ed.cursor())
        };
        if let Some(target) = wikilink::target_on_line(&text, cursor) {
            self.open_wikilink_target(&target, &open, window, cx);
            return;
        }
        // The panel pins the document it opened over (TS `linkPickState`):
        // the revision is the self-check the insert runs before writing.
        self.link_pick_rev = Some(self.editor.read(cx).document_revision());
        self.link_query.clear();
        self.link_suggest = true;
        self.ime_sync(cx);
        let state = self.link_state.clone();
        state.update(cx, |s, cx| {
            s.set_query("", window, cx);
            s.focus(window, cx);
        });
        cx.notify();
    }

    /// TS `openWikiLink`: resolve the target against the flat note list and
    /// open it. A missing note reports and stays put; a self-link is a no-op
    /// (reopening would reload the document and drop unsaved edits).
    fn open_wikilink_target(
        &mut self,
        target: &str,
        from: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match wikilink::target_rel(target, &self.files) {
            None => {
                self.status = format!("未找到笔记: {target}");
                cx.notify();
            }
            Some(rel) if rel == from => {}
            Some(rel) => self.open_note(rel, window, cx),
        }
    }

    /// TS `insertPickedLink`: write the picked note into the document at the
    /// caret (a selection becomes the alias), then hand focus back. The
    /// revision captured at open is the self-check — a reload since then
    /// means the caret offsets refer to text the user never saw.
    fn insert_wikilink_pick(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.link_suggest = false;
        if self.link_pick_rev != Some(self.editor.read(cx).document_revision()) {
            self.focus_editor(window, cx);
            return;
        }
        let Some(text) = wikilink::link_text(rel, &self.files) else {
            self.status = "这个文件名带链接语法字符，没法写成 [[链接]]".to_string();
            self.focus_editor(window, cx);
            return;
        };
        let (doc, selection) = {
            let ed = self.editor.read(cx);
            (ed.value().to_string(), ed.selected_range())
        };
        let out = wikilink::link_insert(&doc, selection, &text);
        self.run_edit(Some(out), window, cx);
        self.focus_editor(window, cx);
    }

    fn focus_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let focus = self.editor.focus_handle(cx);
        focus.focus(window, cx);
    }

    /// Close the panel and give the keyboard back to the editor (TS
    /// `restoreEditorFocus` on unmount).
    fn close_link_suggest(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.link_suggest {
            return;
        }
        self.link_suggest = false;
        self.focus_editor(window, cx);
        self.ime_sync(cx);
        cx.notify();
    }

    /// The link completion panel (TS `LinkSuggest.tsx`): a search field over
    /// the quick switcher's own ranking, anchored under the caret. Enter
    /// writes the highlighted note as `[[链接]]`; Esc (captured before the
    /// field) or a click outside abandons the insert.
    fn render_link_suggest(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        if !self.link_suggest {
            return None;
        }
        let weak = cx.entity().downgrade();

        // The switcher's ranking (TS `buildSwitcherResults`): recency is keyed
        // by absolute paths, and the open note is the excluded one.
        let root = self.vault_root.clone();
        let vault = root.as_ref().map(|r| r.to_string_lossy().to_string());
        let recent: Vec<String> = self
            .mru
            .iter()
            .map(|rel| match &root {
                Some(root) => root.join(rel).to_string_lossy().to_string(),
                None => rel.clone(),
            })
            .collect();
        let exclude = match (&root, &self.open_path) {
            (Some(root), Some(open)) => Some(root.join(open).to_string_lossy().to_string()),
            _ => None,
        };
        let hits = bnote_core::markdown::switcher::build_switcher_results(
            &self.files,
            &recent,
            vault.as_deref(),
            &self.link_query,
            exclude.as_deref(),
            50,
        );
        let rels: Arc<Vec<String>> = Arc::new(hits.iter().map(|h| h.item.clone()).collect());
        let items: Vec<CommandItem> = hits
            .iter()
            .map(|hit| {
                let (name, dir) = link_row_parts(&hit.item);
                CommandItem::new()
                    .label(hit.item.clone())
                    .child(move |_window, cx| {
                        h_flex()
                            .flex_1()
                            .gap_2()
                            .items_baseline()
                            .child(Label::new(name.clone()).text_sm())
                            .child(
                                Label::new(dir.clone())
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .ml_auto(),
                            )
                            .into_any_element()
                    })
            })
            .collect();

        let command = Command::new(&self.link_state)
            .items(items)
            // The host ranks (the switcher's ordering); the field only reports.
            .filterable(false)
            .placeholder("搜索笔记…")
            .on_query({
                let weak = weak.clone();
                move |query, _window, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.link_query = query.to_string();
                        cx.notify();
                    });
                }
            })
            .on_confirm({
                let rels = rels.clone();
                let weak = weak.clone();
                move |ix, window, cx| {
                    let Some(rel) = rels.get(ix.row).cloned() else {
                        return;
                    };
                    defer_workspace(&weak, window, cx, move |this, window, cx| {
                        this.insert_wikilink_pick(&rel, window, cx);
                    });
                }
            })
            .on_cancel({
                let weak = weak.clone();
                move |window, cx| {
                    defer_workspace(&weak, window, cx, |this, window, cx| {
                        this.close_link_suggest(window, cx);
                    });
                }
            })
            .into_any_element();

        // Anchor under the caret, lifted when the panel would not fit below.
        let (left, top) = match self.editor.read(cx).cursor_layout() {
            Some((caret, _)) => {
                let viewport = window.viewport_size();
                let left = caret
                    .origin
                    .x
                    .min(viewport.width - px(LINK_PANEL_W + 16.))
                    .max(px(8.));
                let top = (caret.origin.y + caret.size.height + px(4.))
                    .min(viewport.height - px(LINK_PANEL_H + 8.))
                    .max(px(8.));
                (left, top)
            }
            // Before the first layout there is no caret rectangle to hang on.
            None => (px(80.), px(80.)),
        };

        Some(
            div()
                .absolute()
                .inset_0()
                .child(
                    // A click outside gives up the insert (TS mousedown-outside).
                    div()
                        .absolute()
                        .inset_0()
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, window, cx| {
                                this.close_link_suggest(window, cx);
                            }),
                        ),
                )
                .child(
                    div()
                        .id("link-suggest")
                        .absolute()
                        .left(left)
                        .top(top)
                        .w(px(LINK_PANEL_W))
                        // Esc closes in one press (TS); the field's own Cancel
                        // would clear a non-empty query first.
                        .capture_key_down(cx.listener(
                            |this, event: &KeyDownEvent, window, cx| {
                                if event.keystroke.key == "escape" {
                                    this.close_link_suggest(window, cx);
                                    cx.stop_propagation();
                                }
                            },
                        ))
                        .child(command),
                )
                .into_any_element(),
        )
    }

    fn insert_inline_math(
        &mut self,
        _: &actions::InsertInlineMath,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_wrap("$", w, cx)
    }

    fn insert_math_block(
        &mut self,
        _: &actions::InsertMathBlock,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.editor.read(cx).value().to_string();
        let out = ops::insert_math_block(&text, self.sel(cx));
        self.run_edit(Some(out), window, cx);
    }

    fn insert_code_block(
        &mut self,
        _: &actions::InsertCodeBlock,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.editor.read(cx).value().to_string();
        let out = ops::insert_code_block(&text, self.sel(cx), &self.code_block_lang);
        self.run_edit(Some(out), window, cx);
    }

    /// TS `edit.insert-python-block`: the same code block, language fixed.
    fn insert_python_block(
        &mut self,
        _: &actions::InsertPythonBlock,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.editor.read(cx).value().to_string();
        let out = ops::insert_code_block(&text, self.sel(cx), "python");
        self.run_edit(Some(out), window, cx);
    }

    fn insert_callout(
        &mut self,
        _: &actions::InsertCallout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.editor.read(cx).value().to_string();
        let out = ops::insert_callout(&text, self.sel(cx));
        self.run_edit(Some(out), window, cx);
    }

    fn insert_hr(
        &mut self,
        _: &actions::InsertHorizontalRule,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.editor.read(cx).value().to_string();
        let pos = self.sel(cx).head;
        let out = ops::insert_horizontal_rule(&text, pos);
        self.run_edit(Some(out), window, cx);
    }

    /// ⌘T: jump to the header todo block and back (per-path round-trip
    /// memory, like the Tauri shell).
    fn header_todos(&mut self, _: &actions::HeaderTodos, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rel) = self.open_path.clone() else { return };
        let text = self.editor.read(cx).value().to_string();
        let byte = self.editor.read(cx).cursor();
        let (line, col) = crate::apply_ops::byte_to_line_col(&text, byte);
        let has_return = self.header_returns.has(&rel);
        match ops::plan_header_todo_jump(&text, line, has_return) {
            ops::HeaderTodoPlan::Jump { anchor } => {
                self.header_returns.remember(&rel, line, col, 0);
                self.editor.update(cx, |ed, cx| ed.set_selected_range(anchor..anchor, cx));
            }
            ops::HeaderTodoPlan::Back => {
                if let Some((target_line, target_col, _scroll)) =
                    self.header_returns.take_refreshed(&rel)
                {
                    self.header_returns.remove(&rel);
                    let (target_line, target_col) = (target_line.max(1), target_col);
                    let byte = line_col_to_byte(&text, target_line, target_col);
                    self.editor.update(cx, |ed, cx| ed.set_selected_range(byte..byte, cx));
                }
            }
            ops::HeaderTodoPlan::Create { at, insert, cursor } => {
                let out = ops::OpsOutcome {
                    edits: vec![ops::Edit { start: at, end: at, text: insert }],
                    cursors: vec![(cursor, cursor)],
                };
                self.run_edit(Some(out), window, cx);
            }
            ops::HeaderTodoPlan::Stay => {
                self.status = "没有头部待办".to_string();
            }
        }
        cx.notify();
    }

    /// ⌘⇧O: open (or create with rollover) today's daily note. Inside the
    /// daily it consumes the back slot instead (TS `openDailyNote`'s toggle
    /// semantics): jump to the note the last ⌘⇧O came from, if it still
    /// exists on disk.
    fn open_daily(&mut self, _: &actions::OpenDaily, window: &mut Window, cx: &mut Context<Self>) {
        if !self.has_doc() {
            self.status = "先打开一个仓库".to_string();
            self.show_toast("没有打开仓库", cx);
            return;
        }
        // TS compares against today's path exactly: yesterday's daily is a
        // normal note for this purpose (jump, remembering the source).
        let in_today = self
            .open_path
            .as_deref()
            .is_some_and(|p| { bnote_core::daily::model::daily_day_of(&format!("/{p}")) == Some(self.today.as_str()) });
        if in_today {
            let Some(back) = self.daily_back_from.take() else {
                self.status = "没有可跳回的文件".to_string();
                self.show_toast("没有可跳回的文件", cx);
                return;
            };
            let Some(root) = self.vault_root.clone() else { return };
            let state = self.state.clone();
            let back_path = back.clone();
            cx.spawn_in(window, async move |this, window| {
                let text = window
                    .background_executor()
                    .spawn(async move {
                        bnote_core::commands::files::read_file(
                            &state,
                            root.join(back_path).to_string_lossy().to_string(),
                        )
                    })
                    .await;
                this.update_in(window, |this, window, cx| match text {
                    Ok(content) => {
                        // install_text restores the cursor memory itself.
                        this.status = format!("跳回 {}", back);
                        this.install_text(back, content, window, cx);
                        cx.notify();
                    }
                    Err(_) => {
                        this.status = "跳回的文件已不存在".to_string();
                        this.show_toast("跳回的文件已不存在", cx);
                    }
                })
                .ok();
            })
            .detach();
            return;
        }
        // A note (not today's daily): remember it as the jump-back target.
        if self.open_path.is_some() {
            self.daily_back_from = self.open_path.clone();
        }
        let Some(daily) = self.daily.clone() else { return };
        let today = self.today.clone();
        let vault_root = self.vault_root.clone();
        cx.spawn(async move |this, cx| {
            let prepared = cx
                .background_executor()
                .spawn(async move { daily.open_daily_text(&today) })
                .await;
            this.update_in(cx, |this, window, cx| match prepared {
                Ok((abs, text)) => {
                    let rel = abs_to_rel(&abs, &vault_root);
                    this.install_text(rel, text, window, cx);
                    this.status = format!("今日日记 {}", this.today);
                    cx.notify();
                }
                Err(e) => {
                    this.report_failure(format!("打开日记失败:{e}"), cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// ⌘⇧J: send the todo at the cursor to today's daily.
    fn send_todo_to_daily(
        &mut self,
        _: &actions::SendTodoToDaily,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(root), Some(rel)) = (self.vault_root.clone(), self.open_path.clone()) else {
            return;
        };
        let Some(daily) = self.daily.clone() else { return };
        let text = self.editor.read(cx).value().to_string();
        let byte = self.editor.read(cx).cursor();
        let (line, _) = crate::apply_ops::byte_to_line_col(&text, byte);
        let abs = root.join(&rel).to_string_lossy().to_string();
        let today = self.today.clone();
        let daily_outcome = daily.clone();
        cx.spawn(async move |this, cx| {
            let (write, report) = cx
                .background_executor()
                .spawn(async move { daily.send_todo(&abs, &text, &[line], &today) })
                .await;
            this.update_in(cx, |this, window, cx| {
                if let Some(w) = write {
                    daily_outcome.record_synced(&w.path, &w.text);
                    if report.not_todo > 0 {
                        this.status = "光标不在待办上".to_string();
                    } else {
                        this.status = format!("已发送到今日日记({} 项)", report.sent);
                    }
                    // The send wrote a link: the source line's synced pip (and
                    // a daily-side label) come from the store, so the marks
                    // must be rebuilt.
                    this.preview_dirty = true;
                    // If the open note IS a daily mirror target, refresh it.
                    let open_abs = this
                        .vault_root
                        .as_ref()
                        .zip(this.open_path.clone())
                        .map(|(r, p)| r.join(p).to_string_lossy().to_string());
                    if open_abs.as_deref() == Some(w.path.as_str()) {
                        this.install_text(this.open_path.clone().unwrap_or_default(), w.text.clone(), window, cx);
                    }
                } else if report.not_todo > 0 {
                    this.status = "光标不在待办上".to_string();
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// ⌘N: create an untitled note in the vault root and open it.
    fn new_note(&mut self, _: &actions::NewNote, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.vault_root.clone() else {
            self.status = "先打开一个仓库".to_string();
            cx.notify();
            return;
        };
        let state = self.state.clone();
        cx.spawn(async move |this, cx| {
            let created = cx
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::files::create_file(
                        &state,
                        root.to_string_lossy().to_string(),
                        "未命名.md".to_string(),
                    )
                })
                .await;
            this.update_in(cx, |this, window, cx| match created {
                Ok(entry) => {
                    this.status = format!("新建 {}", entry.rel_path);
                    this.open_note(entry.rel_path.clone(), window, cx);
                }
                Err(e) => {
                    this.report_failure(format!("新建失败:{e}"), cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// TS `workspace.new-folder` (`actions.newFolder()` with no parent): a
    /// 「新建文件夹」 in the vault root, then the tree sidebar shows it.
    fn new_folder(&mut self, _: &actions::NewFolder, _window: &mut Window, cx: &mut Context<Self>) {
        self.create_in_tree(String::new(), false, cx);
    }

    /// TS `workspace.open-vault`: the folder picker (the welcome screen's
    /// button, reachable from the palette without a default key).
    fn open_vault(&mut self, _: &actions::OpenVault, window: &mut Window, cx: &mut Context<Self>) {
        self.pick_vault(window, cx);
    }

    fn toggle_sidebar(
        &mut self,
        _: &actions::ToggleSidebar,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sidebar_open = !self.sidebar_open;
        cx.notify();
    }

    fn focus_sidebar(
        &mut self,
        _: &actions::FocusSidebar,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.status = "文件树键盘导航随 vim 移植到位".to_string();
        cx.notify();
    }

    fn toggle_agent_panel(
        &mut self,
        _: &actions::ToggleAgentPanel,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.agent_open = !self.agent_open;
        cx.notify();
    }

    /// ⌘⇧V: attach/detach vim on the main editor. The choice persists to
    /// `config.json` (`settings.vim`, the same key the Tauri shell writes).
    fn toggle_vim(&mut self, _: &actions::ToggleVim, _window: &mut Window, cx: &mut Context<Self>) {
        self.vim_enabled = !self.vim_enabled;
        let enabled = self.vim_enabled;
        self.set_vim_enabled(enabled, cx);
        self.persist_vim_setting(enabled);
        self.status = if enabled {
            "vim 模式开启(普通模式)".to_string()
        } else {
            "vim 模式关闭".to_string()
        };
        cx.notify();
    }

    /// Attach/detach the editor and sync its readonly gate; no persistence.
    fn set_vim_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let editor = self.editor.clone();
        if enabled {
            self.vim_bridge.attach(editor, cx);
        } else {
            self.vim_bridge.detach(&editor, cx);
        }
    }

    fn persist_vim_setting(&self, enabled: bool) {
        self.persist_setting_off_thread("vim", serde_json::Value::Bool(enabled));
    }

    /// Write one `settings.*` key of `config.json` — the same shape the Tauri
    /// shell persists, so both shells agree. The write is synchronous like
    /// [`Workspace::persist_vim_setting`] was: a settings toggle is a rare,
    /// user-initiated event and the file is small.
    fn persist_setting(&self, key: &str, value: serde_json::Value, _cx: &mut Context<Self>) {
        self.persist_setting_off_thread(key, value);
    }

    fn persist_setting_off_thread(&self, key: &str, value: serde_json::Value) {
        let state = self.state.clone();
        let mut cfg = load_config_value(&state);
        let Some(obj) = cfg.as_object_mut() else { return };
        let settings = obj
            .entry("settings".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(settings) = settings.as_object_mut() {
            settings.insert(key.to_string(), value);
        }
        if let Err(e) = bnote_core::commands::config::save_app_config(&state, cfg) {
            eprintln!("settings: 写入 {key} 失败 {e}");
        }
    }

    /// ⌘,: open the settings modal. A link-suggest panel gives way (TS closes
    /// the panel when a modal opens).
    fn open_settings(
        &mut self,
        _: &actions::OpenSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings_open {
            self.close_settings(window, cx);
            return;
        }
        self.open_settings_modal(window, cx);
    }

    /// Open the settings modal. The quick-add rows are rebuilt from the saved
    /// list, so the fields always show what the file holds.
    fn open_settings_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The other overlays must not keep the foreground behind a modal.
        self.link_suggest = false;
        self.qa_open = false;
        self.settings_open = true;
        self.ime_sync(cx);
        let cfg = load_config_value(&self.state);
        let commands = bnote_core::commands::config::quick_add_commands(&cfg);
        self.qa_rows.clear();
        for cmd in commands {
            let (name, folder) = (cmd.name.clone(), cmd.folder.clone());
            self.qa_add_row(&name, &folder, window, cx);
        }
        cx.notify();
    }

    /// The pickers' data (TS `listInputSources`): the TIS enumeration is slow
    /// the first time and must not sit on the UI thread. Loaded when the IME
    /// tab or a picker is first shown — never at startup, and never with the
    /// settings modal merely open. Idempotent: one fetch per session.
    fn ensure_ime_sources(&mut self, cx: &mut Context<Self>) {
        if !self.ime_sources.is_empty() || self.ime_loading {
            return;
        }
        self.ime_loading = true;
        let listing = (self.ime_services.list)(cx);
        cx.spawn(async move |this, cx| {
            let sources = listing.await;
            this.update(cx, |this, cx| {
                this.ime_loading = false;
                this.ime_sources = sources;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Switch the settings modal's tab; the IME tab pulls its source list in.
    fn set_settings_tab(&mut self, tab: SettingsTab, cx: &mut Context<Self>) {
        self.settings_tab = tab;
        if tab == SettingsTab::Ime {
            self.ensure_ime_sources(cx);
        }
        cx.notify();
    }

    /// Open one of the IME tab's source pickers.
    fn open_ime_picker(&mut self, field: ImePickField, cx: &mut Context<Self>) {
        self.ime_pick = Some(field);
        self.ensure_ime_sources(cx);
        self.ime_sync(cx);
        cx.notify();
    }

    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.settings_open {
            return;
        }
        self.settings_open = false;
        self.ime_pick = None;
        self.focus_editor(window, cx);
        self.ime_sync(cx);
        cx.notify();
    }

    /// ⌘↩ (TS `python.run-note`): run the whole note as one virtual `.py`
    /// file — every python fence, line-aligned, plus the synthesized
    /// `__main__` guard. No fence: nothing runs and the status line says so.
    fn run_python_note(
        &mut self,
        _: &actions::PythonRunNote,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.vault_root.clone() else {
            self.status = "先打开一个仓库".to_string();
            cx.notify();
            return;
        };
        let Some(rel) = self.open_path.clone() else {
            self.status = "没有打开的笔记".to_string();
            cx.notify();
            return;
        };
        let text = self.editor.read(cx).text().to_string();
        let eff = bnote_core::python::extract::extract_python(&text);
        if eff.blocks.is_empty() {
            self.status = "这篇笔记没有 python 代码块(```python 围栏)".to_string();
            cx.notify();
            return;
        }
        let md_path = root.join(&rel).to_string_lossy().to_string();
        let state = self.state.clone();
        let code = eff.effective_text;
        let this = cx.weak_entity();
        cx.spawn(async move |_, cx| {
            let started = cx
                .background_executor()
                .spawn(async move {
                    let run_state = state.clone();
                    bnote_core::commands::python::python_run(&run_state, md_path.clone(), code)
                        .map(|started| (started, md_path))
                })
                .await;
            this.update(cx, |this, cx| match started {
                Ok((started, md_path)) => {
                    // TS `beginRun(started, mdPath)`: the panel opens with the
                    // run's id, and only output carrying that id lands in it.
                    this.python_run.begin(
                        Some(started.run_id),
                        Some(md_path),
                        started.command.clone(),
                    );
                    this.py_body.clear();
                    this.py_body_highlights.clear();
                    this.status = format!("python: {}", started.command);
                    cx.notify();
                }
                Err(e) => {
                    this.report_failure(format!("运行失败: {e}"), cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// TS `python.run-stop`: cancel the live run (the panel's 停止 button).
    fn stop_python_run(&mut self, _: &actions::PythonRunStop, _: &mut Window, cx: &mut Context<Self>) {
        let Some(md_path) = self.python_run.md_path.clone() else {
            return;
        };
        let state = self.state.clone();
        cx.background_executor()
            .spawn(async move {
                let _ = bnote_core::commands::python::python_run_cancel(&state, md_path);
            })
            .detach();
    }

    /// One output chunk: append to the cached body (or rebuild it when the
    /// chunk cap dropped the head), then stick the view to the bottom when it
    /// was already there (TS's < 48px rule; gpui offsets are negative-going,
    /// so the distance to the bottom is `max_offset - offset`).
    fn py_push_output(&mut self, stream: PyStream, text: String, cx: &mut Context<Self>) {
        let trimmed = self.python_run.append(stream, text.clone());
        if trimmed {
            self.py_rebuild_body(cx);
        } else {
            let start = self.py_body.len();
            self.py_body.push_str(&text);
            let color = self.py_stream_color(stream, cx);
            self.py_body_highlights.push((
                start..self.py_body.len(),
                HighlightStyle { color: Some(color), ..Default::default() },
            ));
        }
        let near_bottom = {
            let h = &self.py_scroll;
            (h.max_offset().y - h.offset().y) < px(48.)
        };
        if near_bottom {
            self.py_scroll.scroll_to_bottom();
        }
        cx.notify();
    }

    /// The body text rebuilt from scratch (the cap dropped chunks, so the
    /// cached text no longer matches the lines).
    fn py_rebuild_body(&mut self, cx: &mut Context<Self>) {
        self.py_body.clear();
        self.py_body_highlights.clear();
        let lines = std::mem::take(&mut self.python_run.lines);
        for line in &lines {
            let start = self.py_body.len();
            self.py_body.push_str(&line.text);
            let color = self.py_stream_color(line.stream, cx);
            self.py_body_highlights.push((
                start..self.py_body.len(),
                HighlightStyle { color: Some(color), ..Default::default() },
            ));
        }
        self.python_run.lines = lines;
    }

    /// A stream's colour in the panel body (`--text` / `--danger` /
    /// `--text-faint`).
    fn py_stream_color(&self, stream: PyStream, cx: &mut Context<Self>) -> gpui::Hsla {
        let theme = cx.theme();
        match stream {
            PyStream::Stdout => theme.foreground,
            PyStream::Stderr => theme.danger,
            PyStream::System => theme.muted_foreground,
        }
    }

    /// The notes column: the editor takes the height the run panel does not
    /// (TS `EditorPane`'s editor-host + `<PythonRunPanel />`).
    fn render_editor_column(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let palette = self.preview.palette(cx);
        // `.cm-content`'s prose column: capped at `--content-line-width`
        // (700px) plus the two 48px insets and centered in the pane — GPUI's
        // border-box sizing makes `--content-line-width + 2 * --content-pad-x`
        // the same 796px box the CSS declares. The 45vh bottom padding is the
        // engine's own half-viewport scroll margin, already in place.
        let column_width = px(palette.content_line_width + 2. * palette.content_pad_x);
        let pad_x = px(palette.content_pad_x);
        let editor = Editor::new(&self.editor)
            .bordered(false)
            .p_0()
            .h(relative(1.))
            // The editor reads and writes prose: it wears the UI font at
            // `--editor-font-size` (`.cm-content`), not the code font.
            .font_family(theme.font_family.clone())
            .text_size(theme.font_size)
            .flex_1();
        let mut column = v_flex().size_full().min_h_0().child(
            div().flex_1().min_h_0().w_full().child(
                div()
                    .size_full()
                    .max_w(column_width)
                    .mx_auto()
                    .px(pad_x)
                    .pt(px(24.))
                    .child(editor.into_any_element()),
            ),
        );
        if let Some(panel) = self.render_python_panel(cx) {
            column = column.child(panel);
        }
        column.into_any_element()
    }

    // -----------------------------------------------------------------------
    // 学习模式(TS `StudyLayout.tsx`:agent | 内容 | 笔记)
    // -----------------------------------------------------------------------

    /// ⌘⇧S (TS `view.toggle-study-mode`): enter or leave the three-pane study
    /// layout. Session-only, like the TS store flag; the split is persisted.
    fn toggle_study_mode(
        &mut self,
        _: &actions::ToggleStudyMode,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.study_mode = !self.study_mode;
        self.status = if self.study_mode {
            "学习模式:左问 agent、中看内容、右记笔记".to_string()
        } else {
            "退出学习模式".to_string()
        };
        if self.study_mode {
            // TS restarts the agent session when the content changes; entering
            // the mode is when the current content first reaches the session.
            self.sync_study_session(cx);
        }
        cx.notify();
    }

    /// "选择 PDF 文件" (TS's file dialog): pick, convert, open the markdown.
    fn pick_study_pdf(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("选择 PDF 文件".into()),
        });
        cx.spawn(async move |this, cx| {
            let picked = receiver
                .await
                .ok()
                .and_then(|result| result.ok())
                .flatten()
                .and_then(|paths| paths.into_iter().next());
            let Some(path) = picked else { return };
            this.update_in(cx, |this, _window, cx| this.convert_study_pdf(path, cx))
            .ok();
        })
        .detach();
    }

    /// A file dropped on the window (TS `handleDrop`): a PDF converts, a
    /// markdown file opens directly; anything else is reported and ignored.
    fn on_study_drop(&mut self, paths: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        let pick = |wanted: &[&str]| {
            paths.iter().find(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| wanted.contains(&ext.to_ascii_lowercase().as_str()))
                    .unwrap_or(false)
            })
        };
        if let Some(pdf) = pick(&["pdf"]) {
            let pdf = pdf.clone();
            if !self.study_mode {
                self.study_mode = true;
            }
            self.convert_study_pdf(pdf, cx);
            return;
        }
        if let Some(md) = pick(&["md", "markdown", "txt"]) {
            let md = md.clone();
            if !self.study_mode {
                self.study_mode = true;
            }
            let title = md
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
                .unwrap_or_default();
            self.load_study_markdown(md.to_string_lossy().to_string(), title, cx);
            let _ = window;
            return;
        }
        self.status = "请拖入 PDF 或 Markdown 文件".to_string();
        cx.notify();
    }

    /// PDF → markdown in the vault (`pdfs/<stem>.md`, figures under
    /// `pdfs/assets/<stem>/`), then open the result in the middle pane.
    fn convert_study_pdf(&mut self, pdf: PathBuf, cx: &mut Context<Self>) {
        if self.vault_root.is_none() {
            self.status = "先打开一个仓库".to_string();
            cx.notify();
            return;
        }
        self.status = "正在转换 PDF…".to_string();
        self.study_content = None;
        cx.notify();
        let state = self.state.clone();
        let pdf = pdf.to_string_lossy().to_string();
        cx.spawn(async move |this, cx| {
            let converted = cx
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::agent::convert_pdf_to_markdown(
                        &state,
                        pdf,
                        "pdfs".to_string(),
                    )
                })
                .await;
            this.update_in(cx, |this, _window, cx| match converted {
                Ok(value) => {
                    let md = value
                        .get("mdPath")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let title = value
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let pages = value.get("pages").and_then(|v| v.as_u64()).unwrap_or(0);
                    this.status = format!("转换完成:{pages} 页");
                    this.load_study_markdown(md, title, cx);
                }
                Err(e) => {
                    this.report_failure(format!("转换失败: {e}"), cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Show a vault note in the study pane (a converted PDF, or any markdown).
    fn load_study_markdown(&mut self, path: String, title: String, cx: &mut Context<Self>) {
        let state = self.state.clone();
        let read = path.clone();
        cx.spawn(async move |this, cx| {
            let text = cx
                .background_executor()
                .spawn(async move { bnote_core::commands::files::read_file(&state, read) })
                .await;
            this.update_in(cx, |this, window, cx| match text {
                Ok(text) => {
                    this.study_editor
                        .update(cx, |editor, cx| editor.set_value(text, window, cx));
                    // Figures resolve against the study note's own directory
                    // (pdf2md writes `assets/<stem>/…`), like the TS.
                    let dir = std::path::Path::new(&path).parent().map(|p| p.to_path_buf());
                    this.study_preview.images().set_doc_dir(dir);
                    this.study_dirty = true;
                    this.study_rows = None;
                    this.study_content = Some(StudyContent::Markdown { path, title });
                    this.sync_study_session(cx);
                    cx.notify();
                }
                Err(e) => {
                    this.report_failure(format!("打开失败: {e}"), cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// The URL box (TS opens it in a native child webview; this shell has no
    /// web view). The pane shows the address, the browser opens it, and the
    /// agent can still read it (`read_study_content` fetches the page).
    fn open_study_url(&mut self, url: String, cx: &mut Context<Self>) {
        let url = if url.contains("://") { url } else { format!("https://{url}") };
        let title = url
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or(&url)
            .to_string();
        cx.open_url(&url);
        self.study_content = Some(StudyContent::Url { url, title });
        self.sync_study_session(cx);
        cx.notify();
    }

    /// Close the middle pane's content (TS's ✕).
    fn close_study_content(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.study_content = None;
        self.study_editor
            .update(cx, |editor, cx| editor.set_value("", window, cx));
        self.sync_study_session(cx);
        cx.notify();
    }

    /// The agent session carries the study content (TS restarts the session
    /// when it changes; `read_study_content` grounds the answers in it).
    fn sync_study_session(&mut self, cx: &mut Context<Self>) {
        let key = match &self.study_content {
            Some(StudyContent::Markdown { path, .. }) => Some(format!("md:{path}")),
            Some(StudyContent::Url { url, .. }) => Some(format!("url:{url}")),
            None => None,
        };
        if self.study_session_for == key {
            return;
        }
        self.study_session_for = key;
        let study = self.study_content.clone().map(|content| match content {
            StudyContent::Markdown { path, title } => {
                bnote_core::agent::tools::StudyContent::Markdown { path, title }
            }
            StudyContent::Url { url, title } => {
                bnote_core::agent::tools::StudyContent::Url { url, title }
            }
        });
        self.agent.update(cx, |panel, cx| panel.set_study(study, cx));
    }

    /// The study panes' resize handler (TS's pointer-up persist): the two
    /// panes' fractions of the layout width, clamped, into `settings.studySplit`.
    fn persist_study_split(&mut self, cx: &mut Context<Self>) {
        let width: f32 = self.study_resize.read(cx).container_size().into();
        if width <= 0. {
            return;
        }
        let sizes = self.study_resize.read(cx).sizes().clone();
        let Some((agent, content)) = sizes.first().zip(sizes.get(1)) else {
            return;
        };
        let agent: f32 = (*agent).into();
        let content: f32 = (*content).into();
        let split = normalize_split([agent / width, content / width]);
        if split == self.study_split {
            return;
        }
        self.study_split = split;
        self.persist_setting(
            "studySplit",
            serde_json::json!([split[0], split[1]]),
            cx,
        );
    }

    /// The middle pane: the toolbar (title, URL box, ✕) and the content.
    fn render_study_content(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let title = match &self.study_content {
            Some(StudyContent::Markdown { title, .. }) => title.clone(),
            Some(StudyContent::Url { title, .. }) => title.clone(),
            None => "学习内容".to_string(),
        };
        let mut toolbar = h_flex()
            .flex_none()
            .items_center()
            .gap_2()
            .px_3()
            .py_1()
            .border_b_1()
            .border_color(theme.border)
            .child(Label::new(title).text_sm())
            .child(div().flex_1());
        let url_state = self.study_url_state.clone();
        toolbar = toolbar.child(div().w(px(240.)).child(Input::new(&url_state).h(px(26.)).bordered(false)));
        toolbar = toolbar.child(
            Button::new("study-url-open")
                .ghost()
                .label("打开网址")
                .on_click(cx.listener(|this, _, window, cx| {
                    let url = this.study_url_state.read(cx).value().trim().to_string();
                    let _ = window;
                    if !url.is_empty() {
                        this.open_study_url(url, cx);
                    }
                })),
        );
        if self.study_content.is_some() {
            toolbar = toolbar.child(
                Button::new("study-close")
                    .ghost()
                    .label("✕")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.close_study_content(window, cx)
                    })),
            );
        }

        let body: gpui::AnyElement = match self.study_content.clone() {
            Some(StudyContent::Markdown { .. }) => Editor::new(&self.study_editor)
                .bordered(false)
                .p_0()
                .h(relative(1.))
                .font_family(theme.mono_font_family.clone())
                .text_size(theme.mono_font_size)
                .into_any_element(),
            Some(StudyContent::Url { url, .. }) => v_flex()
                .gap_2()
                .p_6()
                .child(Label::new("网页已在浏览器打开(本应用没有内嵌 web 视图)"))
                .child(
                    Label::new(url)
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .into_any_element(),
            None => v_flex()
                .gap_3()
                .items_center()
                .justify_center()
                .size_full()
                .child(Label::new("拖入或选择 PDF 开始学习"))
                .child(
                    Label::new("PDF 会转换成 Markdown(公式转为 LaTeX、图表原位保留)")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    Button::new("study-pick-pdf")
                        .label("选择 PDF 文件")
                        .on_click(cx.listener(|this, _, _, cx| this.pick_study_pdf(cx))),
                )
                .into_any_element(),
        };

        v_flex()
            .size_full()
            .min_w_0()
            .child(toolbar)
            .child(div().flex_1().min_h_0().child(body))
            .into_any_element()
    }

    /// The three-pane study layout. Widths come from the stored fractions on
    /// first layout; the kit's resizable keeps them proportional afterwards.
    fn render_study_layout(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let width: f32 = window.bounds().size.width.into();
        let agent_w = px((width * self.study_split[0]).round());
        let content_w = px((width * self.study_split[1]).round());
        let notes = self.render_editor_column(window, cx);
        h_resizable("study-layout")
            .with_state(&self.study_resize)
            .child(resizable_panel().size(agent_w).size_range(px(220.)..gpui::Pixels::MAX).child(self.agent.clone()))
            .child(resizable_panel().size(content_w).size_range(px(260.)..gpui::Pixels::MAX).child(self.render_study_content(window, cx)))
            .child(resizable_panel().size_range(px(220.)..gpui::Pixels::MAX).child(notes))
            .into_any_element()
    }

    // -----------------------------------------------------------------------
    // ty 类型检查(TS `src/python/lsp.ts` 的壳侧)
    // -----------------------------------------------------------------------

    /// The note's absolute path (the key every python command takes).
    fn open_note_abs(&self) -> Option<String> {
        let root = self.vault_root.as_ref()?;
        let rel = self.open_path.as_ref()?;
        Some(root.join(rel).to_string_lossy().to_string())
    }

    /// Every edit schedules the sync after the quiet period (TS
    /// `scheduleSync`); only the newest timer fires.
    fn schedule_py_lsp_sync(&mut self, cx: &mut Context<Self>) {
        if self.open_note_abs().is_none() {
            return;
        }
        self.py_lsp_seq = self.py_lsp_seq.wrapping_add(1);
        let seq = self.py_lsp_seq;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SYNC_DEBOUNCE).await;
            this.update(cx, |this, cx| {
                if this.py_lsp_seq != seq {
                    return;
                }
                let text = this.editor.read(cx).text().to_string();
                this.py_lsp.update(cx, |host, cx| host.sync_now(&text, cx));
            })
            .ok();
        })
        .detach();
    }

    /// The note the follow is tracking (called on every open / close).
    fn py_lsp_set_path(&mut self, cx: &mut Context<Self>) {
        let path = self.open_path.as_ref().and_then(|_| self.open_note_abs());
        self.py_lsp.update(cx, |host, cx| host.set_path(path, cx));
    }

    /// `python-lsp-diagnostics` → the editor's own diagnostic set (the kit
    /// paints the wavy underline and the hover popover from it).
    fn apply_py_diagnostics(&mut self, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).text().to_string();
        let mapped = self.py_lsp.update(cx, |host, _| host.diagnostics(&text));
        self.editor.update(cx, |state, cx| {
            let rope = state.text().clone();
            let Some(set) = state.diagnostics_mut() else {
                return; // a non-code editor has no diagnostics channel
            };
            set.reset(&rope);
            for diagnostic in mapped {
                set.push(diagnostic);
            }
            cx.notify();
        });
    }

    /// TS `python.toggle-lsp`: flip the project's ty mode for the open note.
    fn toggle_python_lsp(
        &mut self,
        _: &actions::PythonToggleLsp,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.open_note_abs().is_none() {
            self.status = "没有打开的笔记".to_string();
            cx.notify();
            return;
        }
        let text = self.editor.read(cx).text().to_string();
        self.py_lsp.update(cx, |host, cx| host.toggle_lsp(text, cx));
        // The mode flips asynchronously (the config write is on the disk
        // thread); the diagnostics clear and reappear on their own.
        self.status = "ty 类型检查:切换中…".to_string();
        cx.notify();
    }

    /// TS `python.create-uv-env`: the uv log lands in the run panel's system
    /// stream (`beginSystem` / `finishSystem`).
    fn create_py_uv_env(
        &mut self,
        _: &actions::PythonCreateUvEnv,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(path) = self.open_note_abs() else {
            self.status = "没有打开的笔记".to_string();
            cx.notify();
            return;
        };
        self.python_run.begin(None, Some(path.clone()), "uv 环境".to_string());
        self.py_body.clear();
        self.py_body_highlights.clear();
        self.status = "正在创建 uv 环境…".to_string();
        let state = self.state.clone();
        let uv = {
            let services = self.py_lsp.read(cx).services().uv_create.clone();
            (services)(&state, path, cx)
        };
        cx.spawn(async move |this, cx| {
            let outcome = uv.await;
            this.update(cx, |this, cx| {
                match outcome {
                    Ok(outcome) => {
                        this.py_push_output(PyStream::System, outcome.log, cx);
                        this.python_run.finish(Some(0), 0, false, false);
                        this.status = "uv 环境已就绪".to_string();
                    }
                    Err(e) => {
                        this.py_push_output(PyStream::Stderr, e, cx);
                        this.python_run.finish(Some(1), 0, false, false);
                        this.status = "uv 环境创建失败".to_string();
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The run panel (TS `PythonRunPanel`): a 200px strip at the bottom of the
    /// editor column — header with status, duration, command and the buttons,
    /// then the output body.
    fn render_python_panel(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.python_run.open {
            return None;
        }
        let theme = cx.theme().clone();
        let (status, kind) = self.python_run.status();
        let status_color = match kind {
            PyStatus::Running => theme.accent,
            PyStatus::Ok => theme.foreground,
            PyStatus::Bad => theme.danger,
        };
        let duration = self.python_run.duration_ms.filter(|_| !self.python_run.running);
        let running = self.python_run.running;

        let mut head = h_flex()
            .flex_none()
            .items_center()
            .gap_2()
            .px_2p5()
            .py_1()
            .border_b_1()
            .border_color(theme.border)
            .text_size(px(12.))
            .child(Label::new(status).text_color(status_color).text_sm())
            .children(duration.map(|ms| {
                Label::new(format!("{:.2}s", ms as f64 / 1000.0))
                    .text_sm()
                    .text_color(theme.muted_foreground)
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(11.5))
                    .font_family(theme.mono_font_family.clone())
                    .text_color(theme.muted_foreground)
                    .child(SharedString::from(self.python_run.command.clone())),
            );
        if running {
            head = head.child(
                Button::new("python-run-stop")
                    .ghost()
                    .label("停止")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.stop_python_run(&actions::PythonRunStop, window, cx);
                    })),
            );
        }
        head = head
            .child(
                Button::new("python-run-clear")
                    .ghost()
                    .label("清空")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.python_run.lines.clear();
                        this.py_body.clear();
                        this.py_body_highlights.clear();
                        cx.notify();
                    })),
            )
            .child(
                Button::new("python-run-close")
                    .ghost()
                    .label("关闭")
                    .on_click(cx.listener(|this, _, _, cx| {
                        // TS `close()` only flips `open`: a live run keeps
                        // going and its output keeps landing.
                        this.python_run.open = false;
                        cx.notify();
                    })),
            );

        let body = div()
            .id("python-run-body")
            .flex_1()
            .min_h_0()
            .px_3()
            .py_2()
            .text_size(px(12.))
            .font_family(theme.mono_font_family.clone())
            .overflow_y_scroll()
            .track_scroll(&self.py_scroll)
            .child(
                StyledText::new(self.py_body.clone())
                    .with_highlights(self.py_body_highlights.clone()),
            )
            .vertical_scrollbar(&self.py_scroll);

        Some(
            v_flex()
                .flex_none()
                .h(px(200.))
                .min_h_0()
                .border_t_1()
                .border_color(theme.border)
                .bg(theme.sidebar)
                .child(head)
                .child(body)
                .into_any_element(),
        )
    }

    /// The IME context the overlays put the keyboard in, if any (TS
    /// `imeDesiredSource`'s modal arms): an ASCII search field wants English,
    /// every other overlay leaves the user's own source alone.
    fn ime_modal_context(&self) -> Option<ImeWhere> {
        let ascii_search = self.link_suggest
            || matches!(self.palette, Some(PaletteKind::Files))
            || (self.qa_open && !self.qa_naming);
        if ascii_search {
            return Some(ImeWhere::AsciiSearch);
        }
        let other_overlay = self.settings_open
            || self.palette.is_some()
            || self.qa_open
            || self.rename_prompt.is_some()
            || self.ime_pick.is_some();
        other_overlay.then_some(ImeWhere::Neutral)
    }

    /// Route the IME follow after any context change: the overlays first (a
    /// modal owns the keyboard when it is up), otherwise the editor's own
    /// mode and caret.
    fn ime_sync(&mut self, cx: &mut Context<Self>) {
        match self.ime_modal_context() {
            Some(at) => {
                let ime = self.ime.clone();
                ime.update(cx, |host, cx| host.sync_modal(at, cx));
            }
            None => self.ime_follow_editor(cx),
        }
    }

    /// The editor's own trigger (TS `imeSwitchExtension`): vim's mode and the
    /// caret, with the document so math / fenced-code regions can be cached
    /// per revision.
    fn ime_follow_editor(&mut self, cx: &mut Context<Self>) {
        let mode = self.vim_bridge.mode_of(&self.editor);
        let (text, caret, revision) = {
            let ed = self.editor.read(cx);
            (ed.value(), ed.cursor(), ed.document_revision())
        };
        let ime = self.ime.clone();
        ime.update(cx, |host, cx| host.follow_editor(mode, &text, caret, revision, cx));
    }

    /// Right-click on a tree row (TS `TreeItem.openMenu`).
    fn open_tree_menu(
        &mut self,
        rel: String,
        is_folder: bool,
        at: gpui::Point<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) {
        self.tree_menu = Some(TreeMenu {
            rel,
            is_folder,
            x: f32::from(at.x),
            y: f32::from(at.y),
        });
        cx.notify();
    }

    fn close_tree_menu(&mut self, cx: &mut Context<Self>) {
        if self.tree_menu.take().is_some() {
            cx.notify();
        }
    }

    /// Create a note or a folder in `dir` (a vault-relative path, empty for
    /// the root) and let the tree follow. Shared by the tree menu and the
    /// palette's `workspace.new-note` / `workspace.new-folder`.
    fn create_in_tree(&mut self, dir: String, is_note: bool, cx: &mut Context<Self>) {
        let state = self.state.clone();
        cx.spawn(async move |this, cx| {
            let created = cx
                .background_executor()
                .spawn(async move {
                    if is_note {
                        bnote_core::commands::files::create_file(
                            &state,
                            dir,
                            "未命名.md".to_string(),
                        )
                        .map(|e| (e.rel_path, true))
                    } else {
                        bnote_core::commands::files::create_dir(
                            &state,
                            dir,
                            "新建文件夹".to_string(),
                        )
                        .map(|e| (e.rel_path, false))
                    }
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                match created {
                    Ok((rel_path, is_note)) => {
                        this.status = format!(
                            "{}{}",
                            if is_note { "新建 " } else { "新建文件夹 " },
                            rel_path
                        );
                        if is_note {
                            this.open_note(rel_path, window, cx);
                        }
                        this.refresh_tree(cx);
                    }
                    Err(e) => this.report_failure(format!("新建失败:{e}"), cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A tree-menu pick. Create and delete run on the background executor and
    /// re-resolve the absolute path from the *current* vault root when they
    /// land — the menu may have been open across a vault switch.
    fn tree_menu_pick(
        &mut self,
        item: TreeMenuItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(menu) = self.tree_menu.take() else { return };
        let Some(root) = self.vault_root.clone() else { return };
        let rel = menu.rel.clone();
        let abs = root.join(&rel).to_string_lossy().to_string();
        match item {
            TreeMenuItem::Open => self.open_note(rel, window, cx),
            TreeMenuItem::Rename => {
                let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
                self.rename_prompt = Some(RenamePrompt { rel, is_folder: menu.is_folder });
                self.ime_sync(cx);
                let state = self.rename_state.clone();
                state.update(cx, |st, cx| {
                    st.set_value(name, window, cx);
                    st.focus(window, cx);
                });
                cx.notify();
            }
            TreeMenuItem::NewNote | TreeMenuItem::NewFolder => {
                self.create_in_tree(rel.clone(), item == TreeMenuItem::NewNote, cx);
            }
            TreeMenuItem::Delete => {
                let open_path = self.open_path.clone();
                let state = self.state.clone();
                let removed_open = deletion_hits_open_note(open_path.as_deref(), &rel);
                cx.spawn(async move |this, cx| {
                    let done = cx
                        .background_executor()
                        .spawn(async move {
                            bnote_core::commands::files::trash_path(&state, abs)
                        })
                        .await;
                    this.update_in(cx, |this, window, cx| {
                        match done {
                            Ok(()) => {
                                this.status = format!("已删除 {rel}");
                                if removed_open {
                                    // The deleted entry held the open note
                                    // (possibly as its parent): close it.
                                    this.close_note(window, cx);
                                }
                                this.refresh_tree(cx);
                            }
                            Err(e) => this.report_failure(format!("删除失败:{e}"), cx),
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
        }
    }

    /// Empty the editor (TS `closeFile` + `loadDocument(view, "")`).
    fn close_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.flush_cursor_save_now(cx);
        self.open_path = None;
        self.dirty = false;
        self.py_lsp_set_path(cx);
        self.replace_buffer("", window, cx);
        self.snippets.reset(&self.editor);
        cx.notify();
    }

    /// TS `renameEntry`: rename on disk, then follow the open note to its new
    /// path (the file itself, or a parent folder's new prefix).
    fn commit_rename(&mut self, cx: &mut Context<Self>) {
        let Some(prompt) = self.rename_prompt.take() else { return };
        self.ime_sync(cx);
        let Some(root) = self.vault_root.clone() else { return };
        let mut name = self.rename_state.read(cx).value().trim().to_string();
        if name.is_empty() {
            cx.notify();
            return;
        }
        // A file renamed without an extension keeps the old one — otherwise
        // the file drops out of the note index (TS `renameEntry`).
        if !prompt.is_folder && !name.contains('.') {
            let old = prompt.rel.rsplit('/').next().unwrap_or(&prompt.rel);
            if let Some(dot) = old.rfind('.') {
                name.push_str(&old[dot..]);
            }
        }
        let abs = root.join(&prompt.rel).to_string_lossy().to_string();
        let open_path = self.open_path.clone();
        let state = self.state.clone();
        let dir = prompt.rel.clone();
        // The open note may live inside the renamed folder: follow the new
        // prefix instead of the file's own name.
        let follow = open_path
            .as_deref()
            .filter(|p| *p == dir || p.starts_with(&format!("{dir}/")))
            .map(|p| p.to_string());
        cx.spawn(async move |this, cx| {
            let renamed = cx
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::files::rename_path(&state, abs, name)
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                match renamed {
                    Ok(new_abs) => {
                        this.status = format!("已重命名 {}", dir);
                        this.refresh_tree(cx);
                        if let Some(old_rel) = follow {
                            let root = this.vault_root.clone();
                            if let (Some(root), Some(new_abs)) =
                                (root, Some(new_abs.clone()))
                            {
                                let new_abs = PathBuf::from(new_abs);
                                let new_rel = new_abs
                                    .strip_prefix(&root)
                                    .map(|p| p.to_string_lossy().to_string())
                                    .unwrap_or_else(|_| {
                                        new_abs.to_string_lossy().to_string()
                                    });
                                let target = renamed_open_note(&old_rel, &dir, &new_rel);
                                this.open_note(target, window, cx);
                            }
                        }
                    }
                    Err(e) => this.report_failure(format!("重命名失败:{e}"), cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Rebuild the file tree off the UI thread (the same path the vault
    /// watcher takes).
    fn refresh_tree(&mut self, cx: &mut Context<Self>) {
        let tree = self.tree_state.clone();
        cx.spawn(async move |this, cx| reload_tree(this, tree, cx).await).detach();
    }

    /// The tree's highlighted row is the open note (TS `.tree-row.current`),
    /// never the last-clicked row: the kit selects on any entry click, so the
    /// clicks and every rebuild re-aim it here.
    fn sync_tree_selection(&mut self, cx: &mut Context<Self>) {
        let target = self
            .open_path
            .as_ref()
            .and_then(|path| self.tree_state.read(cx).index_of(&path.clone().into()));
        self.tree_state.update(cx, |state, cx| {
            if state.selected_index() != target {
                state.set_selected_index(target, cx);
            }
        });
    }

    // ---- ex command line (`:` in a modal vim mode) -----------------------

    /// Open the one-line ex input (the vim bridge's `:` observer calls this).
    fn open_ex_line(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ex_open = true;
        self.ex_state.update(cx, |st, cx| {
            st.set_value("", window, cx);
            st.focus(window, cx);
        });
        self.ime_sync(cx);
        cx.notify();
    }

    /// Enter in the ex line: run the command, close the line.
    fn commit_ex(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.ex_state.read(cx).value().trim().to_string();
        self.ex_open = false;
        self.focus_editor(window, cx);
        self.ime_sync(cx);
        if input.is_empty() {
            cx.notify();
            return;
        }
        // TS vim.ts's EX_ALIASES pass through the same table the vimrc's
        // `:…<CR>` right-hand sides use — one alias source.
        let id = crate::editor::vim::vimrc::ex_command(&input);
        match crate::commands::action_for(&id) {
            Some(action) => window.dispatch_action(action, cx),
            None => {
                self.status = format!("未知命令 :{}", input);
                self.show_toast(format!("未知命令 :{}", input), cx);
            }
        }
        cx.notify();
    }

    /// Close the ex line without running anything (Esc).
    fn close_ex_line(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.ex_open {
            return;
        }
        self.ex_open = false;
        self.focus_editor(window, cx);
        self.ime_sync(cx);
        cx.notify();
    }

    /// Persist one IME setting and push it into the follow (the follow holds
    /// its own copy; the modal is the only writer).
    fn patch_ime_settings(
        &mut self,
        patch: impl FnOnce(&mut ime_cmd::ImeSettings),
        cx: &mut Context<Self>,
    ) {
        let mut settings = self.ime.read(cx).settings().clone();
        patch(&mut settings);
        let mut cfg = load_config_value(&self.state);
        ime_cmd::set_ime_settings(&mut cfg, &settings);
        if let Err(e) = bnote_core::commands::config::save_app_config(&self.state, cfg) {
            eprintln!("settings: 写入 ime 失败 {e}");
        }
        let ime = self.ime.clone();
        ime.update(cx, |host, cx| host.set_settings(settings, cx));
        // The new rules apply to the context in front right now.
        self.ime_sync(cx);
        self.ime_pick = None;
        cx.notify();
    }

    fn set_ime_enabled(&mut self, on: bool, cx: &mut Context<Self>) {
        self.patch_ime_settings(|s| s.enabled = on, cx);
    }

    fn set_ime_math(&mut self, on: bool, cx: &mut Context<Self>) {
        self.patch_ime_settings(|s| s.math_keeps_english = on, cx);
    }

    fn set_ime_code(&mut self, on: bool, cx: &mut Context<Self>) {
        self.patch_ime_settings(|s| s.code_keeps_english = on, cx);
    }

    fn pick_ime_source(&mut self, field: ImePickField, id: String, cx: &mut Context<Self>) {
        self.patch_ime_settings(
            |s| match field {
                ImePickField::Insert => s.insert_source = id,
                ImePickField::Normal => s.normal_source = id,
            },
            cx,
        );
    }

    /// The source picker (TS's `<select>` over `listInputSources`): the
    /// selectable sources, the current one marked.
    fn render_ime_picker(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let field = self.ime_pick?;
        let theme = cx.theme().clone();
        let settings = self.ime.read(cx).settings().clone();
        let current = match field {
            ImePickField::Insert => settings.insert_source.clone(),
            ImePickField::Normal => settings.normal_source.clone(),
        };
        let rows: Vec<gpui::AnyElement> = self
            .ime_sources
            .iter()
            .map(|source| {
                let id = source.id.clone();
                let active = id == current;
                let label = format!("{}（{}）", source.name, id);
                let row = div().px_3().py_1p5().rounded_sm().text_sm();
                let row = if active { row.bg(theme.list_active).text_color(theme.accent) } else { row };
                row.id(id.clone())
                    .cursor_default()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.pick_ime_source(field, id.clone(), cx);
                    }))
                    .child(Label::new(label))
                    .into_any_element()
            })
            .collect();
        let empty = self.ime_sources.is_empty();
        Some(
            div()
                .absolute()
                .inset_0()
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                this.ime_pick = None;
                                this.ime_sync(cx);
                                cx.notify();
                            }),
                        ),
                )
                .child(
                    div()
                        .id("ime-picker")
                        .absolute()
                        .inset_0()
                        .flex()
                        .justify_center()
                        .items_start()
                        .pt(px(140.))
                        .child(
                            v_flex()
                                .w(px(460.))
                                .max_h(px(420.))
                                .p_2()
                                .gap_0p5()
                                .rounded_lg()
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.popover)
                                .occlude()
                                .child(
                                    Label::new("选择输入法源")
                                        .text_sm()
                                        .px_2()
                                        .pb_1(),
                                )
                                .children(if empty {
                                    vec![
                                        settings_hint("正在读取系统输入法列表…", &theme)
                                            .into_any_element(),
                                    ]
                                } else {
                                    rows
                                }),
                        ),
                )
                .into_any_element(),
        )
    }

    /// ⌘⇧A: open quick add. The command list is re-read from `config.json`
    /// (the settings tab writes it), so an edit there shows up at once.
    fn quick_add(&mut self, _: &actions::QuickAdd, window: &mut Window, cx: &mut Context<Self>) {
        if self.qa_open {
            self.close_quick_add(window, cx);
            return;
        }
        // One modal at a time: quick add takes the foreground.
        self.settings_open = false;
        self.link_suggest = false;
        self.palette = None;
        let cfg = load_config_value(&self.state);
        self.qa_commands = bnote_core::commands::config::quick_add_commands(&cfg);
        self.qa_open = true;
        self.qa_naming = false;
        self.ime_sync(cx);
        let state = self.qa_state.clone();
        state.update(cx, |s, cx| {
            s.set_query("", window, cx);
            s.focus(window, cx);
        });
        cx.notify();
    }

    fn close_quick_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.qa_open {
            return;
        }
        self.qa_open = false;
        self.qa_naming = false;
        self.focus_editor(window, cx);
        self.ime_sync(cx);
        cx.notify();
    }

    /// The pick stage: remember the command, switch the field to naming.
    fn qa_pick(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cmd) = self.qa_commands.get(ix).cloned() else { return };
        self.qa_naming = true;
        self.qa_picked = Some(cmd.clone());
        // Naming a note may well be Chinese: the ASCII search scope ends here
        // (TS restores the source as soon as a command is picked).
        self.ime_sync(cx);
        let state = self.qa_name_state.clone();
        state.update(cx, |st, cx| {
            st.set_value("", window, cx);
            st.focus(window, cx);
        });
        self.status = format!(
            "快速添加:{}",
            if cmd.folder.is_empty() { "仓库根目录".to_string() } else { cmd.folder }
        );
        cx.notify();
    }

    fn qa_back_to_pick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.qa_naming = false;
        self.ime_sync(cx);
        let state = self.qa_state.clone();
        state.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }

    /// Stage two's Enter: create the named note in the picked command's folder
    /// and open it.
    fn qa_create(&mut self, cx: &mut Context<Self>) {
        let Some(cmd) = self.qa_picked.clone() else { return };
        let name = strip_note_ext(self.qa_name_state.read(cx).value().trim())
            .trim()
            .to_string();
        if name.is_empty() {
            return;
        }
        if self.vault_root.is_none() {
            self.status = "先打开一个仓库".to_string();
            cx.notify();
            return;
        }
        let folder = cmd.folder.clone();
        self.qa_open = false;
        self.qa_naming = false;
        let state = self.state.clone();
        cx.spawn(async move |this, cx| {
            let created = cx
                .background_executor()
                .spawn(async move {
                    if !folder.is_empty() {
                        bnote_core::commands::files::ensure_dir(&state, folder.clone())?;
                    }
                    bnote_core::commands::files::create_file(
                        &state,
                        folder,
                        format!("{name}.md"),
                    )
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                match created {
                    Ok(entry) => {
                        this.status = format!("快速添加 {}", entry.rel_path);
                        this.open_note(entry.rel_path.clone(), window, cx);
                    }
                    Err(e) => {
                        this.report_failure(format!("快速添加失败:{e}"), cx);
                        this.focus_editor(window, cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// One 「快速添加」 row: two fields, both re-syncing `settings.quickAdd` on
    /// every edit (TS `patchSettings` persists per keystroke too).
    fn qa_add_row(&mut self, name: &str, folder: &str, window: &mut Window, cx: &mut Context<Self>) {
        let name_input = cx.new(|cx| InputState::new(window, cx));
        name_input.update(cx, |st, cx| st.set_value(name, window, cx));
        let folder_input = cx.new(|cx| InputState::new(window, cx));
        folder_input.update(cx, |st, cx| st.set_value(folder, window, cx));
        let id = self.qa_next_row_id;
        self.qa_next_row_id += 1;
        // Both fields report through the same rebuild, so a removal between
        // the edit and the callback cannot write into the wrong row.
        let subs = [name_input.clone(), folder_input.clone()]
            .into_iter()
            .map(|input| {
                cx.subscribe(&input, move |this, _input, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change { .. }) {
                        this.qa_persist(cx);
                    }
                })
            })
            .collect();
        self.qa_rows.push(QaRow { id, name: name_input, folder: folder_input, _subs: subs });
        cx.notify();
    }

    fn qa_remove_row(&mut self, id: u64, cx: &mut Context<Self>) {
        self.qa_rows.retain(|row| row.id != id);
        self.qa_persist(cx);
    }

    /// Write `settings.quickAdd` from the rows' current field values.
    fn qa_persist(&self, cx: &gpui::App) {
        let list: Vec<bnote_core::commands::config::QuickAddCommand> = self
            .qa_rows
            .iter()
            .map(|row| bnote_core::commands::config::QuickAddCommand {
                name: row.name.read(cx).value().trim().to_string(),
                folder: row.folder.read(cx).value().trim().trim_matches('/').to_string(),
            })
            .collect();
        let mut cfg = load_config_value(&self.state);
        bnote_core::commands::config::set_quick_add_commands(&mut cfg, &list);
        if let Err(e) = bnote_core::commands::config::save_app_config(&self.state, cfg) {
            eprintln!("settings: 写入 quickAdd 失败 {e}");
        }
    }

    /// `settings.autoNumberHeadings`: turning it on renumbers the open note at
    /// once for immediate feedback (TS `App.tsx`'s change subscription), then
    /// the pending pass runs from `render` like every other renumbering.
    fn set_auto_number(&mut self, on: bool, cx: &mut Context<Self>) {
        self.auto_number = on;
        if on {
            self.renumber_pending = true;
        }
        self.persist_setting_off_thread("autoNumberHeadings", serde_json::json!(on));
        cx.notify();
    }

    fn set_typewriter(&mut self, on: bool, cx: &mut Context<Self>) {
        self.typewriter = on;
        self.editor
            .update(cx, |state, cx| state.set_center_cursor(on, cx));
        self.persist_setting_off_thread("typewriter", serde_json::json!(on));
        cx.notify();
    }

    /// `settings.livePreview` (TS `editor.toggle-live-preview`): off means the
    /// editor shows pure source — no hidden marks, no widgets, no line styles.
    fn set_live_preview(&mut self, on: bool, cx: &mut Context<Self>) {
        self.live_preview = on;
        self.persist_setting("livePreview", serde_json::json!(on), cx);
        // Both directions take one scan pass: on rebuilds the decorations, off
        // clears them. The render gate is the single writer of that state.
        self.preview_dirty = true;
        cx.notify();
    }

    /// TS `editor.toggle-live-preview` (⌘E).
    fn toggle_live_preview(
        &mut self,
        _: &actions::ToggleLivePreview,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let next = !self.live_preview;
        self.set_live_preview(next, cx);
        self.status = if next { "实时渲染:开".to_string() } else { "实时渲染:关(源码)".to_string() };
        cx.notify();
    }

    /// TS `editor.toggle-typewriter` (⌘⇧T).
    fn toggle_typewriter(
        &mut self,
        _: &actions::ToggleTypewriter,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let next = !self.typewriter;
        self.set_typewriter(next, cx);
        self.status = if next { "打字机模式:开".to_string() } else { "打字机模式:关".to_string() };
        cx.notify();
    }

    /// TS `editor.toggle-snippets` (⌘⇧L).
    fn toggle_snippets(
        &mut self,
        _: &actions::ToggleSnippets,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let next = !self.snippets_enabled;
        self.set_snippets_enabled(next, cx);
        self.status = if next { "公式片段:开".to_string() } else { "公式片段:关".to_string() };
        cx.notify();
    }

    /// The effects of a new `settings.fontSize`: the field, the theme and the
    /// persisted value. The slider's own drag calls this too — it is the one
    /// path that does not need the slider synced back.
    fn apply_font_size_value(&mut self, size: f32, cx: &mut Context<Self>) {
        self.font_size = size;
        crate::theme::apply_font_size(size, cx);
        self.persist_setting("fontSize", serde_json::json!(size), cx);
    }

    /// TS `view.zoom-in` / `view.zoom-out` / `view.zoom-reset`: the editor's
    /// font size steps by one px inside the slider's range, reset is the
    /// default. The settings slider follows, so reopening the modal agrees.
    fn zoom(&mut self, next: f32, window: &mut Window, cx: &mut Context<Self>) {
        let next = next.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX);
        if next == self.font_size {
            return;
        }
        self.apply_font_size_value(next, cx);
        let slider = self.font_slider.clone();
        slider.update(cx, |slider, cx| slider.set_value(next, window, cx));
        self.status = format!("字号 {}px", next.round());
        cx.notify();
    }

    fn zoom_in(&mut self, _: &actions::ZoomIn, window: &mut Window, cx: &mut Context<Self>) {
        self.zoom(self.font_size + 1.0, window, cx);
    }

    fn zoom_out(&mut self, _: &actions::ZoomOut, window: &mut Window, cx: &mut Context<Self>) {
        self.zoom(self.font_size - 1.0, window, cx);
    }

    fn zoom_reset(&mut self, _: &actions::ZoomReset, window: &mut Window, cx: &mut Context<Self>) {
        self.zoom(FONT_SIZE_DEFAULT, window, cx);
    }

    /// TS `workspace.close-window`: close the window. The close path flushes
    /// the caret and a dirty buffer synchronously, so `:q` never loses an
    /// edit; `:wq` is the same call (TS writes first, the flush is the write).
    fn close_window(&mut self, _: &actions::CloseWindow, window: &mut Window, _: &mut Context<Self>) {
        window.remove_window();
    }

    fn save_note_and_close(
        &mut self,
        _: &actions::SaveNoteAndClose,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.remove_window();
    }

    /// TS `editor.clear-search-highlight`. The search bar is not ported, so
    /// the command says so instead of pretending.
    fn clear_search_highlight(
        &mut self,
        _: &actions::ClearSearchHighlight,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.status = "搜索功能尚未移植,没有高亮可清除".to_string();
        cx.notify();
    }

    /// `settings.autoSave`: the 0.8 s autosave only runs while it is on; ⌘S
    /// always writes (TS keeps the same split).
    fn set_auto_save(&mut self, on: bool, cx: &mut Context<Self>) {
        self.auto_save = on;
        if !on {
            // A debounced write scheduled before the flip must not land.
            self.autosave_gen += 1;
        }
        self.persist_setting("autoSave", serde_json::json!(on), cx);
        cx.notify();
    }

    fn set_math_preview(&mut self, on: bool, cx: &mut Context<Self>) {
        self.math_preview = on;
        self.preview.set_math_preview(on);
        // The next scan has to re-shape the math blocks it skipped.
        self.preview_dirty = true;
        self.persist_setting_off_thread("mathPreview", serde_json::json!(on));
        cx.notify();
    }

    fn set_snippets_enabled(&mut self, on: bool, cx: &mut Context<Self>) {
        self.snippets_enabled = on;
        self.snippets.set_enabled(&self.editor, on);
        self.persist_setting_off_thread("snippets", serde_json::json!(on));
        cx.notify();
    }

    /// `settings.vim` from the modal: the same path ⌘⇧V takes, minus the
    /// status line the shortcut writes.
    fn set_vim_setting(&mut self, on: bool, cx: &mut Context<Self>) {
        self.vim_enabled = on;
        self.set_vim_enabled(on, cx);
        self.persist_vim_setting(on);
        cx.notify();
    }

    fn set_theme(&mut self, mode: ThemeMode, window: &mut Window, cx: &mut Context<Self>) {
        if self.theme_mode == mode {
            return;
        }
        self.theme_mode = mode;
        Theme::change(mode, Some(window), cx);
        crate::theme::apply(mode, cx);
        // A mode change resets the size metrics to the palette default.
        crate::theme::apply_font_size(self.font_size, cx);
        self.preview_styles.set(Vec::new(), cx);
        self.persist_setting_off_thread(
            "theme",
            serde_json::json!(if mode == ThemeMode::Light { "light" } else { "dark" }),
        );
        cx.notify();
    }

    /// The quick-add modal (TS `QuickAddModal.tsx`): stage one searches the
    /// configured commands, stage two names the note and creates it. Esc (or
    /// ⌘⇧A again) closes; Tab in stage two goes back to the search.
    fn render_quick_add(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.qa_open {
            return None;
        }
        let theme = cx.theme().clone();
        let weak = cx.entity().downgrade();

        let body: gpui::AnyElement = if self.qa_naming {
            let picked = self.qa_picked.clone().unwrap_or_default();
            let folder_label = if picked.folder.is_empty() {
                "仓库根目录".to_string()
            } else {
                picked.folder.clone()
            };
            let name = self.qa_name_state.read(cx).value().to_string();
            v_flex()
                .gap_0p5()
                .p_1()
                .child(div().px_1().child(Input::new(&self.qa_name_state).cleanable(true)))
                .child(
                    div()
                        .px_2()
                        .py_1p5()
                        .rounded_md()
                        .bg(theme.list_active)
                        .id("qa-create-row")
                        .cursor_default()
                        .on_click(cx.listener(|this, _, _, cx| this.qa_create(cx)))
                        .child(
                            h_flex()
                                .gap_2()
                                .items_baseline()
                                .child(Label::new(if name.trim().is_empty() {
                                    "输入文件名…".to_string()
                                } else {
                                    name.trim().to_string()
                                }))
                                .child(
                                    Label::new(folder_label)
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .ml_auto(),
                                ),
                        ),
                )
                .child(settings_hint("Tab 返回命令选择 · Enter 创建文件", &theme))
                .into_any_element()
        } else if self.qa_commands.is_empty() {
            v_flex()
                .gap_2()
                .p_3()
                .child(Label::new("还没有快速添加命令，先到「设置 → 快速添加」中配置"))
                .child(
                    div()
                        .child(
                            Button::new("qa-open-settings")
                                .outline()
                                .label("打开设置")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.qa_open = false;
                                    this.open_settings_modal(window, cx);
                                    this.settings_tab = SettingsTab::QuickAdd;
                                    cx.notify();
                                })),
                        )
                        .into_any_element(),
                )
                .into_any_element()
        } else {
            let weak_confirm = weak.clone();
            let weak_cancel = weak.clone();
            let items: Vec<CommandItem> = self
                .qa_commands
                .iter()
                .map(|cmd| {
                    let name = cmd.name.clone();
                    let folder = if cmd.folder.is_empty() {
                        "仓库根目录".to_string()
                    } else {
                        cmd.folder.clone()
                    };
                    CommandItem::new().label(name.clone()).child(move |_window, cx| {
                        h_flex()
                            .flex_1()
                            .gap_2()
                            .items_baseline()
                            .child(Label::new(name.clone()).text_sm())
                            .child(
                                Label::new(folder.clone())
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .ml_auto(),
                            )
                            .into_any_element()
                    })
                })
                .collect();
            Command::new(&self.qa_state)
                .items(items)
                .placeholder("搜索快速添加命令…")
                .on_confirm(move |ix, window, cx| {
                    defer_workspace(&weak_confirm, window, cx, move |this, window, cx| {
                        this.qa_pick(ix.row, window, cx);
                    });
                })
                .on_cancel(move |window, cx| {
                    defer_workspace(&weak_cancel, window, cx, |this, window, cx| {
                        this.close_quick_add(window, cx);
                    });
                })
                .into_any_element()
        };

        Some(
            div()
                .absolute()
                .inset_0()
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(theme.background.opacity(0.45))
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, window, cx| {
                                this.close_quick_add(window, cx);
                            }),
                        ),
                )
                .child(
                    div()
                        .id("quick-add-modal")
                        .absolute()
                        .inset_0()
                        .flex()
                        .justify_center()
                        .items_start()
                        .pt(px(120.))
                        .capture_key_down(cx.listener(
                            |this, event: &KeyDownEvent, window, cx| {
                                let key = event.keystroke.key.as_str();
                                if key == "escape" {
                                    this.close_quick_add(window, cx);
                                    cx.stop_propagation();
                                } else if key == "tab" && this.qa_naming {
                                    this.qa_back_to_pick(window, cx);
                                    cx.stop_propagation();
                                }
                            },
                        ))
                        .child(
                            div()
                                .w(px(620.))
                                .rounded_lg()
                                .overflow_hidden()
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.popover)
                                .occlude()
                                .child(body),
                        ),
                )
                .into_any_element(),
        )
    }

    /// The settings modal: a nav on the left, the active tab's rows on the
    /// right. Esc (captured before any focused input) or a click outside
    /// closes it.
    fn render_settings(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.settings_open {
            return None;
        }
        let theme = cx.theme().clone();

        let nav = v_flex()
            .w(px(176.))
            .h_full()
            .flex_shrink_0()
            .gap_0p5()
            .p_2()
            .bg(theme.sidebar)
            .child(
                Label::new("设置")
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .px_2()
                    .pb_1(),
            )
            .children(
                [
                    (SettingsTab::General, "通用"),
                    (SettingsTab::Editor, "编辑器"),
                    (SettingsTab::Hotkeys, "快捷键"),
                    (SettingsTab::Vim, "Vim"),
                    (SettingsTab::Snippets, "公式片段"),
                    (SettingsTab::QuickAdd, "快速添加"),
                    (SettingsTab::Ime, "输入法"),
                ]
                .into_iter()
                .map(|(tab, label)| {
                    let active = self.settings_tab == tab;
                    let item = div().px_2().py_1().rounded_md().text_sm();
                    let item = if active {
                        item.bg(theme.list_active).text_color(theme.accent)
                    } else {
                        item
                    };
                    item.id(label)
                        .cursor_default()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.set_settings_tab(tab, cx);
                        }))
                        .child(Label::new(label))
                }),
            );

        let content: gpui::AnyElement = match self.settings_tab {
            SettingsTab::General => {
                let vault = self
                    .vault_root
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "未打开".to_string());
                v_flex()
                    .gap_3()
                    .child(settings_heading("仓库", &theme))
                    .child(settings_row(
                        "当前仓库",
                        &vault,
                        div()
                            .child(
                                Button::new("settings-pick-vault")
                                    .outline()
                                    .label("打开其他仓库…")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.settings_open = false;
                                        this.pick_vault(window, cx);
                                    })),
                            )
                            .into_any_element(),
                        &theme,
                    ))
                    .into_any_element()
            }
            SettingsTab::Editor => v_flex()
                .gap_3()
                .child(settings_heading("编辑行为", &theme))
                .child(self.settings_switch(
                    "settings-live-preview",
                    "实时渲染(Live Preview)",
                    "标题、粗体、公式、代码块等在非编辑区域直接渲染;当前行保持源码",
                    self.live_preview,
                    |this, on, cx| this.set_live_preview(on, cx),
                    &theme,
                    cx,
                ))
                .child(self.settings_switch(
                    "settings-auto-save",
                    "自动保存",
                    "停止输入约 0.8 秒后自动保存(⌘S 始终可用)",
                    self.auto_save,
                    |this, on, cx| this.set_auto_save(on, cx),
                    &theme,
                    cx,
                ))
                .child(self.settings_switch(
                    "settings-auto-number",
                    "标题自动编号",
                    "用 ⌘1–⌘4 设置标题时按层级编号(1 / 1.1 / 1.1.2),并重排全文已有编号",
                    self.auto_number,
                    |this, on, cx| this.set_auto_number(on, cx),
                    &theme,
                    cx,
                ))
                .child(self.settings_switch(
                    "settings-typewriter",
                    "打字机模式",
                    "光标所在行始终保持屏幕垂直居中",
                    self.typewriter,
                    |this, on, cx| this.set_typewriter(on, cx),
                    &theme,
                    cx,
                ))
                .child(self.settings_switch(
                    "settings-math-preview",
                    "公式实时预览",
                    "光标在公式内编辑时,保留源码并在下方实时显示渲染结果",
                    self.math_preview,
                    |this, on, cx| this.set_math_preview(on, cx),
                    &theme,
                    cx,
                ))
                .child(settings_row(
                    "代码块语言",
                    "「插入代码块」(⌘⇧C)在开栏预填的语言标识;留空则不带语言",
                    div()
                        .w(px(140.))
                        .child(Input::new(&self.lang_state).cleanable(true))
                        .into_any_element(),
                    &theme,
                ))
                .child(settings_heading("外观", &theme))
                .child(settings_row(
                    "主题",
                    "深色 / 浅色整套界面配色(含编辑器语法高亮),立即生效",
                    h_flex()
                        .gap_2()
                        .children(
                            [(ThemeMode::Dark, "深色"), (ThemeMode::Light, "浅色")]
                                .into_iter()
                                .map(|(mode, label)| {
                                    self.settings_chip(
                                        label,
                                        self.theme_mode == mode,
                                        mode,
                                        &theme,
                                        cx,
                                    )
                                }),
                        )
                        .into_any_element(),
                    &theme,
                ))
                .child(settings_row(
                    "编辑区字号",
                    &format!("{}px", self.font_size.round()),
                    div()
                        .w(px(180.))
                        .child(
                            Slider::new(&self.font_slider).horizontal(),
                        )
                        .into_any_element(),
                    &theme,
                ))
                .into_any_element(),
            SettingsTab::Hotkeys => self.render_hotkeys_tab(&theme, cx),
            SettingsTab::Vim => v_flex()
                .gap_3()
                .child(self.settings_switch(
                    "settings-vim",
                    "启用 Vim 模式",
                    "normal / insert / visual 模式;键位与 bnote 的 vim 引擎一致",
                    self.vim_enabled,
                    |this, on, cx| this.set_vim_setting(on, cx),
                    &theme,
                    cx,
                ))
                .child(settings_hint(
                    "vimrc(全局与仓库 .bnote/vimrc)随 vim 配置层一起移植,暂未接入。",
                    &theme,
                ))
                .into_any_element(),
            SettingsTab::Snippets => v_flex()
                .gap_3()
                .child(self.settings_switch(
                    "settings-snippets",
                    "启用 LaTeX 片段",
                    "输入触发串后按 Tab 展开(如 // → \\frac{}{}),或使用 A 选项的自动片段",
                    self.snippets_enabled,
                    |this, on, cx| this.set_snippets_enabled(on, cx),
                    &theme,
                    cx,
                ))
                .child(settings_hint(
                    "片段来源:<仓库>/.bnote/snippets.js(存在即取代内置集,保存后热加载);编辑该文件即可。",
                    &theme,
                ))
                .into_any_element(),
            SettingsTab::QuickAdd => {
                let rows: Vec<gpui::AnyElement> = self
                    .qa_rows
                    .iter()
                    .map(|row| {
                        let id = row.id;
                        h_flex()
                            .w_full()
                            .gap_2()
                            .items_center()
                            .child(div().flex_1().child(Input::new(&row.name)))
                            .child(div().flex_1().child(Input::new(&row.folder)))
                            .child(
                                Button::new(("qa-remove", id))
                                    .ghost()
                                    .label("✕")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.qa_remove_row(id, cx);
                                    })),
                            )
                            .into_any_element()
                    })
                    .collect();
                v_flex()
                    .gap_3()
                    .child(settings_heading("快速添加命令", &theme))
                    .child(settings_hint(
                        "触发「快速添加文件」(⌘⇧A)后搜索命令,选中并输入文件名即可在目标文件夹创建笔记;文件夹不存在时自动创建,支持 a/b 子路径。改动即时保存。",
                        &theme,
                    ))
                    .children(rows)
                    .child(
                        div()
                            .child(
                                Button::new("qa-add-row").outline().label("添加命令").on_click(
                                    cx.listener(|this, _, window, cx| {
                                        this.qa_add_row("", "", window, cx);
                                    }),
                                ),
                            )
                            .into_any_element(),
                    )
                    .into_any_element()
            }
            SettingsTab::Ime => {
                let ime = self.ime.read(cx).settings().clone();
                // Both pickers show the source's display name (the id when the
                // list has not landed yet).
                let source_label = |id: &str, this: &Self| -> String {
                    this.ime_sources
                        .iter()
                        .find(|s| s.id == id)
                        .map(|s| s.name.clone())
                        .unwrap_or_else(|| id.to_string())
                };
                let insert_label = source_label(&ime.insert_source, self);
                let normal_label = source_label(&ime.normal_source, self);
                v_flex()
                    .gap_3()
                    .child(self.settings_switch(
                        "settings-ime-enabled",
                        "输入法跟随 Vim 模式",
                        "进入 insert 切到中文输入法,回到 normal/visual 切到英文;打开快速切换器时也切到英文,关闭后还原(仅 macOS)",
                        ime.enabled,
                        |this, on, cx| this.set_ime_enabled(on, cx),
                        &theme,
                        cx,
                    ))
                    .child(settings_hint(
                        "通过系统输入法框架(TIS)在应用内直接切换,无进程启动、不抢焦点;macOS 26 上偶发的切换竞态会自动重试。",
                        &theme,
                    ))
                    .child(settings_row(
                        "insert 模式输入法",
                        "写中文笔记用的输入法",
                        div()
                            .child(
                                Button::new("ime-pick-insert")
                                    .outline()
                                    .label(insert_label)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.open_ime_picker(ImePickField::Insert, cx);
                                    })),
                            )
                            .into_any_element(),
                        &theme,
                    ))
                    .child(settings_row(
                        "normal / visual 模式输入法",
                        "一般选英文键盘(ABC)",
                        div()
                            .child(
                                Button::new("ime-pick-normal")
                                    .outline()
                                    .label(normal_label)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.open_ime_picker(ImePickField::Normal, cx);
                                    })),
                            )
                            .into_any_element(),
                        &theme,
                    ))
                    .child(self.settings_switch(
                        "settings-ime-math",
                        "公式内进入 insert 保持英文",
                        "光标位于 $…$ 或 $$…$$ 内时不切中文,避免输入法干扰公式输入",
                        ime.math_keeps_english,
                        |this, on, cx| this.set_ime_math(on, cx),
                        &theme,
                        cx,
                    ))
                    .child(self.settings_switch(
                        "settings-ime-code",
                        "代码块内进入 insert 保持英文",
                        "光标位于 ``` 围栏代码块内时不切中文,代码内容是 ASCII",
                        ime.code_keeps_english,
                        |this, on, cx| this.set_ime_code(on, cx),
                        &theme,
                        cx,
                    ))
                    .into_any_element()
            }
        };

        Some(
            div()
                .absolute()
                .inset_0()
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(theme.background.opacity(0.45))
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, window, cx| {
                                this.close_settings(window, cx);
                            }),
                        ),
                )
                .child(
                    div()
                        .id("settings-modal")
                        .absolute()
                        .inset_0()
                        .flex()
                        .justify_center()
                        .items_center()
                        .child(
                            h_flex()
                                .w(px(760.))
                                .h(px(520.))
                                .rounded_lg()
                                .overflow_hidden()
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.popover)
                                .occlude()
                                .child(nav)
                                .child(
                                    div()
                                        .flex_1()
                                        .h_full()
                                        .p_4()
                                        .overflow_y_scrollbar()
                                        .child(content),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    /// The hotkeys tab (TS `HotkeysTab`): every registry command with its
    /// effective bindings, a search field and the assigned/unassigned filter.
    /// Clicking a row starts a capture — the next keystroke becomes the
    /// binding, Esc cancels — and the file is rewritten on every change.
    fn render_hotkeys_tab(
        &self,
        theme: &gpui_kit::component::theme::Theme,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let query = self.hotkey_query.read(cx).value().to_lowercase();
        let effective = keybindings::effective_bindings(&self.key_overrides);
        let rows: Vec<&'static str> = COMMANDS
            .iter()
            .filter(|def| {
                if !query.is_empty()
                    && !format!("{}{}", def.id, def.label).to_lowercase().contains(&query)
                {
                    return false;
                }
                let bound = effective[def.id].iter().any(|key| !key.is_empty());
                match self.hotkey_filter {
                    HotkeyFilter::All => true,
                    HotkeyFilter::Assigned => bound,
                    HotkeyFilter::Unassigned => !bound,
                }
            })
            .map(|def| def.id)
            .collect();
        let capturing = self.hotkey_capturing.clone();
        let mut list = v_flex().gap_1();
        for id in &rows {
            let row = self.render_hotkey_row(id, &effective[id], capturing.as_deref(), theme, cx);
            list = list.child(row);
        }
        let mut chips = h_flex().gap_2();
        for (filter, label) in [
            (HotkeyFilter::All, "全部"),
            (HotkeyFilter::Assigned, "已分配"),
            (HotkeyFilter::Unassigned, "未分配"),
        ] {
            chips = chips.child(self.hotkey_filter_chip(label, filter, theme, cx));
        }
        v_flex()
            .gap_3()
            .child(
                div()
                    .w_full()
                    .child(Input::new(&self.hotkey_query).cleanable(true)),
            )
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .child(chips)
                    .child(div().flex_1())
                    .child(
                        Button::new("hotkeys-reset-all")
                            .ghost()
                            .label("全部恢复默认")
                            .on_click(cx.listener(|this, _, _, cx| this.reset_all_hotkeys(cx))),
                    ),
            )
            .children(if rows.is_empty() {
                vec![settings_hint("没有匹配的命令。", theme).into_any_element()]
            } else {
                vec![]
            })
            .child(list)
            .into_any_element()
    }

    /// One hotkeys row: the label, its binding chips, the unbind and reset
    /// buttons. The row itself starts the capture.
    fn render_hotkey_row(
        &self,
        id: &'static str,
        keys: &[String],
        capturing: Option<&str>,
        theme: &gpui_kit::component::theme::Theme,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let is_capturing = capturing == Some(id);
        let def = def_of(id);
        let label = def.map(|d| d.label).unwrap_or(id);
        let mut bindings = h_flex().gap_1().items_center();
        for key in keys {
            bindings = bindings.child(
                div()
                    .px_1p5()
                    .py_0p5()
                    .rounded_sm()
                    .border_1()
                    .border_color(theme.border)
                    .text_xs()
                    .child(Label::new(keybindings::format_binding(key))),
            );
        }
        let mut row = h_flex()
            .id(id)
            .w_full()
            .items_center()
            .gap_3()
            .px_2()
            .py_1()
            .rounded_md()
            .cursor_default()
            .hover(|style| style.bg(theme.list_hover));
        if is_capturing {
            row = row.bg(theme.list_active);
        }
        row = row
            .on_click(cx.listener(move |this, _, window, cx| this.capture_hotkey(id, window, cx)))
            .child(Label::new(label.to_string()).text_sm().flex_1());
        if is_capturing {
            row = row.child(
                Label::new("按下新快捷键…(Esc 取消)")
                    .text_xs()
                    .text_color(theme.accent),
            );
        } else {
            row = row.child(bindings);
        }
        if keys.is_empty() && !is_capturing {
            row = row.child(
                Label::new("未设置")
                    .text_xs()
                    .text_color(theme.muted_foreground),
            );
        }
        if !keys.is_empty() {
            row = row.child(
                Button::new(format!("hotkeys-unbind-{id}"))
                    .ghost()
                    .label("✕")
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.set_hotkey_binding(id, Vec::new(), cx);
                    })),
            );
        }
        row = row.child(
            Button::new(format!("hotkeys-reset-{id}"))
                .ghost()
                .label("↺")
                .on_click(cx.listener(move |this, _, _, cx| this.reset_hotkey(id, cx))),
        );
        row.into_any_element()
    }

    /// One filter chip of the hotkeys tab (TS `.chip`).
    fn hotkey_filter_chip(
        &self,
        label: &'static str,
        filter: HotkeyFilter,
        theme: &gpui_kit::component::theme::Theme,
        cx: &mut Context<Self>,
    ) -> impl gpui::IntoElement {
        let active = self.hotkey_filter == filter;
        let chip = div()
            .px_2()
            .py_0p5()
            .rounded_md()
            .border_1()
            .border_color(if active { theme.accent } else { theme.border })
            .text_xs();
        let chip = if active {
            chip.bg(theme.list_active).text_color(theme.accent)
        } else {
            chip
        };
        chip.id(label)
            .cursor_default()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.hotkey_filter = filter;
                cx.notify();
            }))
            .child(Label::new(label))
    }

    /// Write the overrides file and rebuild the keymap from it — the two
    /// effects of any edit here, in one place.
    fn persist_hotkeys(&mut self, cx: &mut Context<Self>) {
        if let Err(e) = keybindings::save(&self.state, &self.key_overrides) {
            self.report_failure(format!("快捷键保存失败:{e}"), cx);
        }
        keybindings::apply(cx, &self.key_overrides);
    }

    /// Assign one binding to a command (TS `setOverride`), sweeping any other
    /// command that held it (TS sets the loser to `null`).
    fn set_hotkey_binding(&mut self, id: &str, keys: Vec<String>, cx: &mut Context<Self>) {
        let mut swept: Vec<&'static str> = Vec::new();
        for key in &keys {
            for other in keybindings::commands_holding_key(&self.key_overrides, key, id) {
                self.key_overrides.insert(other.to_string(), Vec::new());
                swept.push(other);
            }
        }
        let label = def_of(id).map(|d| d.label).unwrap_or(id);
        let shown = keys
            .iter()
            .map(|k| keybindings::format_binding(k))
            .collect::<Vec<_>>()
            .join(" / ");
        self.key_overrides.insert(id.to_string(), keys);
        self.persist_hotkeys(cx);
        self.status = if swept.is_empty() {
            format!("{label} → {shown}")
        } else {
            let losers = swept
                .iter()
                .filter_map(|other| def_of(other).map(|d| d.label))
                .collect::<Vec<_>>()
                .join("、");
            format!("{label} → {shown};与「{losers}」冲突,已解除其绑定")
        };
        cx.notify();
    }

    /// Drop one command's override (TS `clearOverride`): the registry default,
    /// if it has one, comes back.
    fn reset_hotkey(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.key_overrides.remove(id).is_none() {
            return;
        }
        self.persist_hotkeys(cx);
        self.status = format!(
            "{} 已恢复默认",
            def_of(id).map(|d| d.label).unwrap_or(id)
        );
        cx.notify();
    }

    /// TS `resetAllOverrides`.
    fn reset_all_hotkeys(&mut self, cx: &mut Context<Self>) {
        if self.key_overrides.is_empty() {
            return;
        }
        self.key_overrides.clear();
        self.persist_hotkeys(cx);
        self.status = "已恢复默认快捷键".to_string();
        cx.notify();
    }

    /// Start capturing the next keystroke for `id` (TS `capturing`): the
    /// interceptor eats every key until one lands or Esc cancels.
    fn capture_hotkey(&mut self, id: &str, _window: &mut Window, cx: &mut Context<Self>) {
        self.hotkey_capturing = Some(id.to_string());
        keybindings::HotkeyCaptureActive::set(cx, true);
        let weak = cx.weak_entity();
        self.hotkey_capture_sub = Some(cx.intercept_keystrokes(move |event, _window, cx| {
            let ks = event.keystroke.clone();
            weak.update(cx, |this, cx| this.on_hotkey_keystroke(&ks, cx)).ok();
            cx.stop_propagation();
        }));
        cx.notify();
    }

    fn cancel_hotkey_capture(&mut self, cx: &mut Context<Self>) {
        self.hotkey_capture_sub = None;
        if self.hotkey_capturing.take().is_some() {
            keybindings::HotkeyCaptureActive::set(cx, false);
            cx.notify();
        }
    }

    /// One captured keystroke: Esc cancels, a lone modifier is not a binding,
    /// anything else becomes this command's only binding (TS `eventToKey` +
    /// `setOverride`).
    fn on_hotkey_keystroke(&mut self, ks: &gpui::Keystroke, cx: &mut Context<Self>) {
        let Some(id) = self.hotkey_capturing.clone() else {
            return;
        };
        if ks.key.eq_ignore_ascii_case("escape") {
            self.cancel_hotkey_capture(cx);
            return;
        }
        // A lone modifier press is not a binding; keep waiting.
        if matches!(
            ks.key.as_str(),
            "shift" | "control" | "alt" | "platform" | "function" | "fn"
        ) {
            return;
        }
        let Some(key) = keybindings::normalize_key(&ks.unparse()) else {
            return;
        };
        self.hotkey_capture_sub = None;
        self.hotkey_capturing = None;
        keybindings::HotkeyCaptureActive::set(cx, false);
        self.set_hotkey_binding(&id, vec![key], cx);
    }

    /// One theme chip of the appearance row (TS `.chip`).
    fn settings_chip(
        &self,
        label: &'static str,
        active: bool,
        mode: ThemeMode,
        theme: &gpui_kit::component::theme::Theme,
        cx: &mut Context<Self>,
    ) -> impl gpui::IntoElement {
        let chip = div()
            .px_3()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(if active { theme.accent } else { theme.border })
            .text_sm();
        let chip = if active {
            chip.bg(theme.list_active).text_color(theme.accent)
        } else {
            chip
        };
        chip.id(label)
            .cursor_default()
            .on_click(cx.listener(move |this, _, window, cx| this.set_theme(mode, window, cx)))
            .child(Label::new(label))
    }

    /// One switch row of the settings modal. The setter is a method pointer so
    /// each row keeps the single-writer rule (the workspace owns the value).
    #[allow(clippy::too_many_arguments)]
    fn settings_switch(
        &self,
        id: &'static str,
        title: &'static str,
        desc: &'static str,
        checked: bool,
        set: fn(&mut Self, bool, &mut Context<Self>),
        theme: &gpui_kit::component::theme::Theme,
        cx: &mut Context<Self>,
    ) -> impl gpui::IntoElement {
        settings_row(
            title,
            desc,
            div()
                .child(
                    Switch::new(id)
                        .checked(checked)
                        .on_change(cx.listener(move |this, on: &bool, _window, cx| {
                            set(this, *on, cx);
                        })),
                )
                .into_any_element(),
            theme,
        )
    }

    // ---- palettes ---------------------------------------------------------

    fn command_palette(
        &mut self,
        _: &actions::CommandPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.settings_open = false;
        self.palette = Some(PaletteKind::Commands);
        self.ime_sync(cx);
        let state = self.cmd_state.clone();
        state.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }

    fn quick_switcher(
        &mut self,
        _: &actions::QuickSwitcher,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.settings_open = false;
        self.palette = Some(PaletteKind::Files);
        self.ime_sync(cx);
        let state = self.files_state.clone();
        state.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }

    /// ⌘⇧R: switch to the most recent *other* vault, directly (TS
    /// `switchRecentVault` — no palette; alt-tab feel). The vault palette
    /// stays available from the settings page.
    fn switch_recent_vault(
        &mut self,
        _: &actions::SwitchRecentVault,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = self.recent_vaults().first().cloned() else {
            self.status = "没有其他最近打开的仓库".to_string();
            self.show_toast("没有其他最近打开的仓库", cx);
            return;
        };
        self.switch_vault(target, cx);
    }

    /// 「打开笔记文件夹」: the native folder picker, then the same vault switch
    /// the palette's entries take (TS `pickVaultDialog` + `openVault`).
    fn pick_vault(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("打开笔记文件夹".into()),
        });
        cx.spawn_in(window, async move |this, window| {
            let picked = rx.await;
            this.update_in(window, |this, _window, cx| {
                match picked {
                    Ok(Ok(Some(paths))) => {
                        if let Some(path) = paths.into_iter().next() {
                            this.switch_vault(path.to_string_lossy().to_string(), cx);
                        }
                    }
                    Ok(Ok(None)) => {}
                    Ok(Err(e)) => this.report_failure(format!("打开仓库失败:{e}"), cx),
                    Err(e) => this.report_failure(format!("打开仓库失败:{e}"), cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        let focus = self.editor.focus_handle(cx);
        focus.focus(window, cx);
        self.ime_sync(cx);
        cx.notify();
    }

    fn recent_vaults(&self) -> Vec<String> {
        // Identity by filesystem truth, not by string: `config.json` stores
        // the user-entered path (`/var/folders/…`) while the shell holds the
        // canonicalized root (`/private/var/folders/…`) — on macOS those are
        // the same directory through /var's symlink, and a string compare
        // would offer the current vault as a switch target.
        let current = self
            .vault_root
            .as_ref()
            .and_then(|root| root.canonicalize().ok());
        bnote_core::commands::config::load_app_config(&self.state)
            .ok()
            .and_then(|cfg| {
                cfg.get("recentVaults")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect::<Vec<String>>()
                    })
            })
            .unwrap_or_default()
            .into_iter()
            .filter(|p| {
                let candidate =
                    std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
                current.as_ref().map(|c| &candidate != c).unwrap_or(true)
            })
            .collect()
    }

    fn switch_vault(&mut self, path: String, cx: &mut Context<Self>) {
        // TS `openVault`'s leave ritual: the dirty note and the pending
        // cursor write land in the *old* vault before anything clears, so a
        // failed switch loses nothing.
        self.flush_cursor_save_now(cx);
        self.flush_note_save_blocking(cx);
        self.palette = None;
        self.vault_root = None;
        self.open_path = None;
        self.daily = None;
        self.footprint = None;
        // Nothing cached describes the vault we are leaving.
        self.preview.images().clear();
        self.preview.images().set_doc_dir(None);
        self.status = format!("切换仓库:{}", path);
        self.restore_vault(PathBuf::from(path), cx);
        cx.notify();
    }

    // ---- opening notes ----------------------------------------------------

    fn open_note(&mut self, rel_path: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.vault_root.clone() else {
            return;
        };
        // The pending save still refers to the note being left — write it out
        // before the swap (TS `flushCursorSave`).
        self.flush_cursor_save_now(cx);
        // …and so does unsaved **content**: the swap marks the buffer clean, so
        // without this a switch inside the auto-save debounce (or with auto-save
        // off) drops the edits for good. TS `openNote` awaits the pending save
        // for the same reason; here the write is synchronous — a file switch is
        // rare and the note is small.
        if self.dirty && self.open_path.as_deref() != Some(rel_path.as_str()) {
            self.flush_note_save_blocking(cx);
            self.dirty = false;
        }
        let full = root.join(&rel_path);
        let state = self.state.clone();
        self.open_path = Some(rel_path.clone());
        self.dirty = false;
        self.status = format!("打开 {}", rel_path);
        self.mru.retain(|p| p != &rel_path);
        self.mru.insert(0, rel_path.clone());
        self.mru.truncate(50);
        // Agent context follows the open note (background, best effort).
        {
            let state2 = state.clone();
            let abs = full.to_string_lossy().to_string();
            cx.spawn(async move |_this, cx| {
                let _ = cx
                    .background_executor()
                    .spawn(async move {
                        bnote_core::commands::agent::agent_set_current_note(
                            &state2,
                            Some(abs),
                        )
                    })
                    .await;
            })
            .detach();
        }
        cx.spawn_in(window, async move |this, window| {
            let text = window
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::files::read_file(
                        &state,
                        full.to_string_lossy().to_string(),
                    )
                })
                .await;
            // Re-validate: the user may have switched files while we read.
            this.update_in(window, |this, window, cx| {
                if this.open_path.as_deref() != Some(rel_path.as_str()) {
                    return;
                }
                match text {
                    Ok(text) => {
                        this.install_text(rel_path.clone(), text, window, cx);
                    }
                    Err(e) => {
                        // The path is not a readable note (a directory, a file
                        // that vanished): the shell must not keep pretending it
                        // is open — the next save would target it (TS
                        // `openNote`'s catch → `closeFile`).
                        this.open_path = None;
                        this.close_note(window, cx);
                        this.status = format!("无法打开文件:{e}");
                        this.show_toast(format!("无法打开文件: {e}"), cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Install already-read text: set the buffer, baseline the sync host,
    /// refresh the recency list and the cursor label.
    fn install_text(
        &mut self,
        rel_path: String,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.replace_buffer(&text, window, cx);
        self.dirty = false;
        self.open_path = Some(rel_path.clone());
        self.py_lsp_set_path(cx);
        // Image references resolve against the note's own directory first
        // (`![](Images/a.png)` next to the note beats `Images/a.png` at the
        // vault root), so the store follows the open note.
        self.preview.images().set_doc_dir(self.doc_dir_of(&rel_path));
        if let Some(daily) = &self.daily {
            let abs = self
                .vault_root
                .as_ref()
                .map(|r| r.join(&rel_path).to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.clone());
            daily.record_synced(&abs, &text);
        }
        self.mru.retain(|p| p != &rel_path);
        self.mru.insert(0, rel_path.clone());
        self.mru.truncate(50);
        if self.vim_enabled {
            self.vim_bridge.reset(&self.editor);
        }
        // The buffer was replaced wholesale: the session chain (and the math
        // cache) describe a document that no longer exists.
        self.snippets.reset(&self.editor);
        self.snippet_marks_rows = None;
        self.restore_cursor_memory(&rel_path, cx);
        // A zone click asked for a specific line: it wins over the remembered
        // caret (TS `openNote(path, line)`).
        if let Some(line) = self.pending_open_line.take() {
            let text = self.editor.read(cx).text().to_string();
            let byte = line_col_to_byte(&text, line, 0);
            self.editor.update(cx, |st, cx| st.set_selected_range(byte..byte, cx));
            self.editor.update(cx, |st, cx| {
                st.set_scroll_offset(gpui::point(gpui::px(0.), gpui::px((line.saturating_sub(1)) as f32 * 26.)), cx)
            });
        }
        // The sidebar highlight follows the note (TS `.tree-row.current`).
        self.sync_tree_selection(cx);
        self.update_cursor_label(cx);
    }

    fn has_doc(&self) -> bool {
        self.open_path.is_some() && self.vault_root.is_some()
    }

    /// The window's title follows the open note (TS `document.title =
    /// `${fileName} - bnote``). The titlebar is transparent so nothing is
    /// drawn — the title is the window switcher's and AX's to read.
    fn sync_window_title(&self, window: &mut Window, _cx: &mut Context<Self>) {
        let title = match self.open_path.as_deref() {
            Some(path) => {
                let name = path.rsplit('/').next().unwrap_or(path);
                format!("{name} - bnote")
            }
            None => "bnote".to_string(),
        };
        window.set_window_title(&title);
    }

    // ---- images -----------------------------------------------------------

    /// The directory of a vault-relative note path, as an absolute path.
    fn doc_dir_of(&self, rel_path: &str) -> Option<PathBuf> {
        let root = self.vault_root.clone()?;
        Some(match rel_path.rfind('/') {
            Some(i) => root.join(&rel_path[..i]),
            None => root,
        })
    }

    /// The editor element's width as of the last prepaint (`Bounds::default`
    /// before the first frame, which the preview host treats as "unknown").
    fn editor_width(&self, cx: &Context<Self>) -> gpui::Pixels {
        self.editor.read(cx).input_bounds().size.width
    }

    /// Runs the image loads the last scan asked for, on the background
    /// executor. The result is written back only if it still describes the
    /// current state (the store checks its key and the generation captured at
    /// spawn time); a landed image marks the preview dirty so the next frame
    /// emits the widget in place of the source text.
    fn spawn_image_loads(&mut self, cx: &mut Context<Self>) {
        for request in self.preview.images().take_pending() {
            cx.spawn(async move |this, cx| {
                let outcome = cx
                    .background_executor()
                    .spawn(async move { editor_images::load(&request) })
                    .await;
                this.update_in(cx, |this, _window, cx| {
                    if this.preview.images().finish(outcome) {
                        this.preview_dirty = true;
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    /// Recompute the shell's line marks for the open document and hand them
    /// to the preview host.
    ///
    /// Two families, each a paint-only pip at the line's left edge (the TS
    /// line decorations `md-daily-link` / `md-footprint`):
    /// - daily links: a filled dot on todo lines a link binds — the source
    ///   side marks today's sends, the daily side marks synced-in entries and
    ///   adds the source note's label at the line's end;
    /// - footprints: a ring on the first line of every block today's
    ///   footprint recorded from this file (source side only — a daily is the
    ///   aggregation page itself).
    ///
    /// The predicates are pure (`bnote_core::daily::marks`,
    /// `bnote_core::footprint::view`); this only gathers the inputs.
    fn install_line_marks(&mut self, text: &str, cx: &mut Context<Self>) {
        use bnote_core::daily::marks::{build_daily_marks, DailyMark};
        use bnote_core::footprint::view::footprint_mark_lines;

        let mut marks: Vec<LineMark> = Vec::new();
        let visible = self.editor.read(cx).visible_row_range();
        let Some(root) = self.vault_root.as_ref() else {
            self.preview.set_line_marks(marks);
            return;
        };
        let root = root.to_string_lossy().to_string();
        let Some(rel) = self.open_path.clone() else {
            self.preview.set_line_marks(marks);
            return;
        };
        let path = format!("{}/{}", root.trim_end_matches('/'), rel);

        // Daily links: the store is shell state; the predicate is core's.
        let links = match self.daily.as_ref() {
            Some(daily) => daily.links_for_file(&path),
            None => Vec::new(),
        };
        if !links.is_empty() {
            let refs: Vec<&bnote_core::daily::links::DailyLink> = links.iter().collect();
            let today_daily = bnote_core::daily::model::daily_path_for(&root, &self.today);
            let found: Vec<DailyMark> =
                build_daily_marks(text, visible.clone(), &path, &refs, &today_daily);
            marks.extend(found.into_iter().map(|m| LineMark {
                line: m.line as u64,
                filled: true,
                trailing: m.source,
            }));
        }

        // Footprints: only outside the daily (the daily is the page showing
        // everything; a pip there would point at itself).
        if !bnote_core::daily::model::is_daily_path(&path) {
            if let Some(fp) = self.footprint.as_ref() {
                let blocks = fp.blocks_for(&path);
                marks.extend(footprint_mark_lines(&blocks, visible).into_iter().map(|line| {
                    LineMark { line: line as u64, filled: false, trailing: None }
                }));
            }
        }

        marks.sort_by_key(|m| m.line);
        self.preview.set_line_marks(marks);
    }

    /// Install the footprint zone when the open document is a daily with
    /// footprints (today from the live index, a historical day from the
    /// frozen archive); otherwise clear it.
    fn install_footprint_zone(&mut self) {
        let zone = self
            .vault_root
            .as_ref()
            .zip(self.open_path.as_deref())
            .and_then(|(root, rel)| {
                let root = root.to_string_lossy().to_string();
                let path = format!("{}/{}", root.trim_end_matches('/'), rel);
                let day = bnote_core::daily::model::daily_day_of(&path)?.to_string();
                let entries = self.footprint.as_ref()?.entries_for(&day);
                if entries.is_empty() {
                    return None;
                }
                let view = bnote_core::footprint::view::build_footprint_view(&entries);
                Some(ZoneInput {
                    is_today: day == self.today,
                    day,
                    groups: view.groups,
                    zone_collapsed: self.footprint_fold.zone_collapsed,
                    collapsed: self.footprint_fold.groups.clone(),
                })
            });
        self.preview.set_zone(zone);
    }

    /// The zone's header click: fold/unfold the whole zone.
    fn on_toggle_footprint_zone(
        &mut self,
        _: &ToggleFootprintZone,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.footprint_fold = bnote_core::footprint::view::toggle_zone(&self.footprint_fold);
        self.preview_dirty = true;
        cx.notify();
    }

    /// A group's arrow: fold/unfold that group.
    fn on_toggle_footprint_group(
        &mut self,
        action: &ToggleFootprintGroup,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.footprint_fold =
            bnote_core::footprint::view::toggle_group(&self.footprint_fold, &action.path);
        self.preview_dirty = true;
        cx.notify();
    }

    /// A group title or a block body: open the source file (at the block's
    /// first line when the click named one).
    fn on_open_footprint_source(
        &mut self,
        action: &OpenFootprintSource,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.vault_root.as_ref() else { return };
        let root = root.to_string_lossy().to_string();
        let Some(rel) = action
            .path
            .strip_prefix(&root)
            .map(|rest| rest.trim_start_matches('/').to_string())
        else {
            return;
        };
        let line = (action.line > 0).then_some(action.line);
        self.pending_open_line = line;
        self.open_note(rel, window, cx);
    }

    /// Replace the whole buffer, and declare the live preview stale.
    ///
    /// `set_value` is the silent door into the editor (`gpui-kit` emits no
    /// `InputEvent::Change` for it), so the event-driven invalidation that
    /// covers every keystroke cannot see a wholesale replacement. Every path
    /// that swaps the document out or rewrites it in one go goes through
    /// here, so the one signal that path needs cannot be forgotten at a call
    /// site. Whole-buffer writers: file open/reload (`install_text`), close,
    /// the auto-numbering rewrite, and the debug seams.
    fn replace_buffer(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |ed, cx| ed.set_value(text, window, cx));
        self.preview_dirty = true;
        // The caret just reset; the status bar's 行/列 follows it from here.
        self.update_cursor_label(cx);
        // …and so does the window's title (TS `document.title = …`).
        self.sync_window_title(window, cx);
    }

    /// Bring the editor's live-preview snapshot up to date with the document
    /// and the viewport as this frame sees them; the frame's own signals are
    /// checked here too. Returns whether the document/caret feed changed,
    /// which the caller uses to refresh the snippet marks.
    ///
    /// Runs on every render: an image span's width is a function of the
    /// editor width, so a resize (panel toggle, window drag) makes every image
    /// span stale — and the scan only emits for the visible window plus a
    /// margin, so scrolling out of the covered range must rebuild it. Both
    /// read last frame's measurement, so they settle one frame later. Within
    /// the margin the second check fires nothing, keeping whole-document
    /// scans off the scroll path.
    fn refresh_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.preview.needs_rescan(self.editor_width(cx)) {
            self.preview_dirty = true;
        }
        let visible = self.editor.read(cx).visible_byte_range();
        if self.preview.needs_rescan_for(visible.as_ref()) {
            self.preview_dirty = true;
        }
        let content_changed = self.preview_dirty;
        if self.preview_dirty {
            self.preview_dirty = false;
            if self.live_preview {
                let selection = self.editor.read(cx).selected_range();
                self.preview_selection = Some(selection.clone());
                let text = self.editor.read(cx).text().to_string();
                // The shell's line marks (synced-daily pips, footprint pips)
                // and the footprint zone ride the same snapshot: their state
                // lives outside the document, so it is pushed in before the
                // scan.
                self.install_line_marks(&text, cx);
                self.install_footprint_zone();
                let column = self.preview.text_column(self.editor_width(cx), &text, window);
                let decorations =
                    self.preview
                        .decorations(&text, &[selection], column, visible.as_ref(), window, cx);
                self.preview_styles.set(decorations.styles, cx);
                self.editor.update(cx, |state, cx| {
                    state.set_preview_decorations(decorations.decorations, cx)
                });
                // The scan just queued a load for every image whose size it does
                // not know yet; run them off the UI thread.
                self.spawn_image_loads(cx);
            } else {
                // Source mode owns the opposite invariant: no hidden marks, no
                // widgets, no styles. Doing it here (not only on the toggle)
                // covers every path that changes the document under it — a
                // file switch, a reload, a programmatic edit.
                self.preview_styles.set(Vec::new(), cx);
                self.editor.update(cx, |state, cx| {
                    state.set_preview_decorations(PreviewDecorations::default(), cx)
                });
            }
        }
        content_changed
    }

    /// The study pane's scan, the notes pane's protocol for the second
    /// host/editor pair (see the render-time block for the notes pane).
    fn refresh_study_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.study_content.is_none() {
            return;
        }
        let study_width = self.study_editor.read(cx).input_bounds().size.width;
        let study_visible = self.study_editor.read(cx).visible_byte_range();
        let rows = self.study_editor.read(cx).visible_row_range();
        if !(self.study_dirty
            || self.study_preview.needs_rescan(study_width)
            || self.study_preview.needs_rescan_for(study_visible.as_ref())
            || rows != self.study_rows)
        {
            return;
        }
        self.study_dirty = false;
        self.study_rows = rows;
        let text = self.study_editor.read(cx).text().to_string();
        let selection = self.study_editor.read(cx).selected_range();
        let column = self.study_preview.text_column(study_width, &text, window);
        let decorations = self.study_preview.decorations(
            &text,
            &[selection],
            column,
            study_visible.as_ref(),
            window,
            cx,
        );
        self.study_styles.set(decorations.styles, cx);
        self.study_editor.update(cx, |state, cx| {
            state.set_preview_decorations(decorations.decorations, cx)
        });
        for request in self.study_preview.images().take_pending() {
            cx.spawn(async move |this, cx| {
                let outcome = cx
                    .background_executor()
                    .spawn(async move { editor_images::load(&request) })
                    .await;
                this.update_in(cx, |this, _window, cx| {
                    // The store checks its own key and generation, so a stale
                    // load cannot land in the current snapshot.
                    if this.study_preview.images().finish(outcome) {
                        this.study_dirty = true;
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    /// Drops cached images the vault watcher reports as changed (a re-exported
    /// preview, an edited attachment). The next scan loads them again; until
    /// then the source text stays visible, so nothing flickers to a stale
    /// bitmap.
    fn invalidate_images(&mut self, paths: &[String], cx: &mut Context<Self>) {
        let Some(root) = self.vault_root.clone() else {
            return;
        };
        let store = self.preview.images();
        let study = self.study_preview.images();
        let mut hit = false;
        let mut study_hit = false;
        for path in paths {
            // The watcher reports vault-relative and absolute paths both.
            let abs = if std::path::Path::new(path).is_absolute() {
                PathBuf::from(path)
            } else {
                root.join(path)
            };
            if store.invalidate_path(&abs) {
                hit = true;
            }
            // The study pane's figures come from the same vault.
            if study.invalidate_path(&abs) {
                study_hit = true;
            }
        }
        if study_hit {
            self.study_dirty = true;
        }
        if hit {
            self.preview_dirty = true;
            cx.notify();
        }
    }

    // ---- rendering --------------------------------------------------------

    /// Status-bar vim badge ("" when vim is off).
    /// The status bar's mode badge, TS `updateStatus`: `NORMAL` / `INSERT` /
    /// `VISUAL`, empty when vim is off.
    fn vim_badge(&self, _cx: &Context<Self>) -> String {
        if !self.vim_enabled {
            return String::new();
        }
        match self.vim_bridge.mode_of(&self.editor) {
            Some(VimMode::Insert) | Some(VimMode::Replace) => "INSERT",
            Some(VimMode::Visual) | Some(VimMode::VisualLine) | Some(VimMode::VisualBlock) => {
                "VISUAL"
            }
            Some(VimMode::Normal) => "NORMAL",
            None => "",
        }
        .to_string()
    }

    /// `.vim-mode { color: var(--accent) }` with `.insert { color:
    /// var(--string) }`.
    fn vim_badge_color(&self, cx: &Context<Self>) -> gpui::Hsla {
        let palette = self.preview.palette(cx);
        if matches!(
            self.vim_bridge.mode_of(&self.editor),
            Some(VimMode::Insert) | Some(VimMode::Replace)
        ) {
            palette.color("string")
        } else {
            palette.color("accent")
        }
    }

    /// The sidebar (TS `Sidebar.tsx`): the header row over the file tree, with
    /// the 30px top inset the overlay titlebar's traffic lights need.
    fn render_sidebar(&self, _window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let dim = theme.muted_foreground;
        let hover_bg = theme.border;
        let hover_fg = theme.foreground;

        // `.icon-btn` (26×26, radius 6): dim at rest, bright on a bg3 hover.
        let icon_btn = move |id: &'static str| {
            div()
                .id(id)
                .size(px(26.))
                .rounded(px(6.))
                .flex()
                .items_center()
                .justify_center()
                .text_color(dim)
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg).text_color(hover_fg))
        };

        v_flex()
            .size_full()
            .bg(theme.sidebar)
            .text_color(theme.sidebar_foreground)
            .pt(px(30.))
            .child(
                h_flex()
                    .items_center()
                    .gap_0p5()
                    .px_2()
                    .py_1p5()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        icon_btn("sidebar-new-note")
                            .child(IconName::FilePlus)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_note(&actions::NewNote, window, cx);
                            })),
                    )
                    .child(
                        icon_btn("sidebar-new-folder")
                            .child(IconName::FolderPlus)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_folder(&actions::NewFolder, window, cx);
                            })),
                    )
                    .child(
                        Label::new(self.vault_name())
                            .flex_1()
                            .text_center()
                            .text_xs()
                            .text_color(dim)
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_overflow(gpui::TextOverflow::Truncate("…".into())),
                    )
                    .child(
                        icon_btn("sidebar-settings")
                            .text_sm()
                            .child(Label::new("⚙"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_settings_modal(window, cx);
                            })),
                    ),
            )
            .child(self.render_file_tree(cx))
            .into_any_element()
    }

    /// The tree itself: 23px rows (`.tree-row`), a chevron for folders and
    /// `≡` for notes, the open note in accent.
    fn render_file_tree(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let view = cx.entity();
        let theme = cx.theme().clone();
        tree(
            &self.tree_state,
            move |ix, entry, _selected, _window, cx| {
                let rel = entry.item().id.clone();
                let rel_menu = rel.clone();
                let label = entry.item().label.clone();
                let expanded = entry.is_expanded();
                let depth = entry.depth();
                let theme = theme.clone();
                view.update(cx, |this, cx| {
                    // Folder-ness comes from the vault index, not the kit's
                    // "has children" (an empty directory is still a folder).
                    let is_dir = this.tree_dirs.contains(rel.as_ref());
                    let is_current = !is_dir && this.open_path.as_deref() == Some(rel.as_ref());
                    let name_color = if is_current {
                        theme.accent
                    } else {
                        theme.foreground
                    };
                    let glyph: &'static str = if is_dir {
                        if expanded { "⌄" } else { "›" }
                    } else {
                        "≡"
                    };
                    let glyph_size = if is_dir { px(14.) } else { px(12.) };

                    // ListItem stacks its children in a block box, so the row
                    // is one flex child: [glyph][name] (`.tree-row`'s own
                    // display: flex).
                    let glyph_box = h_flex()
                        .w(px(14.))
                        .flex_shrink_0()
                        .text_size(glyph_size)
                        .text_color(theme.muted);
                    let glyph_box = if is_dir {
                        glyph_box
                    } else {
                        glyph_box.justify_center()
                    };

                    ListItem::new(ix)
                        .w_full()
                        .h(px(23.))
                        .rounded(px(6.))
                        .px_0()
                        .py_0()
                        .pl(px(10. + 14. * depth as f32))
                        .pr_2()
                        .child(
                            h_flex()
                                .w_full()
                                .items_center()
                                .gap_1()
                                .child(glyph_box.child(glyph))
                                .child(
                                    Label::new(label)
                                        .text_size(px(12.5))
                                        .text_color(name_color)
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_overflow(gpui::TextOverflow::Truncate("…".into())),
                                ),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if is_dir {
                                // A folder click only toggles (the kit's
                                // mouse-down handler); the highlight goes back
                                // to the open note (TS has no clicked-row
                                // highlight).
                                this.sync_tree_selection(cx);
                            } else {
                                this.open_note(rel.to_string(), window, cx);
                            }
                        }))
                        .on_mouse_down(
                            MouseButton::Right,
                            cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                                this.open_tree_menu(
                                    rel_menu.to_string(),
                                    is_dir,
                                    event.position,
                                    cx,
                                );
                            }),
                        )
                })
            },
        )
        .text_sm()
        .px_1()
        .py_1p5()
        .h_full()
        .into_any_element()
    }

    /// The file tree's context menu (TS `ContextMenu.tsx`): the row's entries
    /// at the click point. A click anywhere else dismisses it.
    fn render_tree_menu(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let menu = self.tree_menu.as_ref()?;
        let theme = cx.theme().clone();
        let (x, y) = (menu.x, menu.y);
        let items: Vec<gpui::AnyElement> = TreeMenuItem::for_row(menu.is_folder)
            .iter()
            .map(|item| {
                let item = *item;
                let danger = item.is_danger();
                let row = div().px_3().py_1().rounded_sm().text_sm();
                let row = if danger { row.text_color(theme.danger) } else { row };
                row.id(item.label())
                    .cursor_default()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.tree_menu_pick(item, window, cx);
                    }))
                    .child(Label::new(item.label()))
                    .into_any_element()
            })
            .collect();

        Some(
            div()
                .absolute()
                .inset_0()
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| this.close_tree_menu(cx)),
                        ),
                )
                .child(
                    div()
                        .id("tree-menu")
                        .absolute()
                        .left(px(x))
                        .top(px(y))
                        .min_w(px(140.))
                        .p_1()
                        .rounded_md()
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .occlude()
                        .children(items),
                )
                .into_any_element(),
        )
    }

    /// The rename dialog (the tree menu's 「重命名」): one field, Enter commits,
    /// Esc cancels.
    fn render_rename_prompt(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if self.rename_prompt.is_none() {
            return None;
        }
        let theme = cx.theme().clone();
        Some(
            div()
                .absolute()
                .inset_0()
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(theme.background.opacity(0.45))
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                this.rename_prompt = None;
                                this.ime_sync(cx);
                                cx.notify();
                            }),
                        ),
                )
                .child(
                    div()
                        .id("rename-prompt")
                        .absolute()
                        .inset_0()
                        .flex()
                        .justify_center()
                        .items_start()
                        .pt(px(160.))
                        .child(
                            v_flex()
                                .w(px(420.))
                                .gap_2()
                                .p_3()
                                .rounded_lg()
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.popover)
                                .occlude()
                                .child(Label::new("重命名").text_sm())
                                .child(Input::new(&self.rename_state).cleanable(true))
                                .child(settings_hint("Enter 确定 · Esc 取消", &theme))
                                .child(
                                    h_flex()
                                        .gap_2()
                                        .justify_end()
                                        .child(
                                            Button::new("rename-cancel")
                                                .outline()
                                                .label("取消")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.rename_prompt = None;
                                                    cx.notify();
                                                })),
                                        )
                                        .child(
                                            Button::new("rename-ok")
                                                .label("重命名")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.commit_rename(cx);
                                                })),
                                        ),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    /// The first-run screen (TS `Welcome.tsx`): no vault yet, so the one thing
    /// to do is pick a folder (or a recent one from ⌘⇧R).
    fn render_welcome(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.render_welcome_needed() {
            return None;
        }
        let theme = cx.theme().clone();
        Some(
            div()
                .absolute()
                .inset_0()
                .bg(theme.background)
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .child(
                    Label::new("bnote")
                        .text_size(px(34.))
                        .text_color(theme.foreground),
                )
                .child(
                    Label::new("本地优先 · 实时渲染 · Vim · LaTeX 片段")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    Button::new("welcome-open-vault")
                        .label("打开笔记文件夹")
                        .on_click(cx.listener(|this, _, window, cx| this.pick_vault(window, cx))),
                )
                .child(
                    Label::new("选择一个文件夹作为笔记仓库(vault),其中的 .md 文件会被自动索引;⌘⇧R 可切回最近用过的仓库。")
                        .text_xs()
                        .text_color(theme.muted_foreground),
                )
                .into_any_element(),
        )
    }

    /// The welcome screen's gate (TS `App.tsx`: `{!vaultPath && <Welcome />}`).
    fn render_welcome_needed(&self) -> bool {
        self.vault_root.is_none()
    }

    /// The ex command line (`:` in a modal vim mode; TS `vim.ts`'s footer
    /// input): one field bottom-center, prompt styled after the TS's.
    fn render_ex_line(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.ex_open {
            return None;
        }
        let theme = cx.theme().clone();
        Some(
            div()
                .id("ex-line")
                .absolute()
                .bottom(px(36.))
                .left(px(120.))
                .right(px(120.))
                .flex()
                .items_center()
                .gap_2()
                .rounded_lg()
                .border_1()
                .border_color(theme.border)
                .bg(theme.popover)
                .px_3()
                .py(px(6.))
                .child(Label::new("∶").text_sm().text_color(theme.muted_foreground))
                .child(Input::new(&self.ex_state).into_any_element())
                .into_any_element(),
        )
    }

    /// The editor empty state's gate (TS `EditorPane.tsx`: `!currentFile &&
    /// vaultPath`).
    fn editor_empty_needed(&self) -> bool {
        self.vault_root.is_some() && self.open_path.is_none()
    }

    /// The editor's empty state (TS `EditorPane.tsx` `.editor-empty`): a vault
    /// is open but no note is.
    fn render_editor_empty(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.editor_empty_needed() {
            return None;
        }
        let theme = cx.theme().clone();
        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .child(
                    Label::new("打开左侧笔记，或")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    Button::new("editor-empty-new-note")
                        .outline()
                        .label("新建笔记")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.new_note(&actions::NewNote, window, cx);
                        })),
                )
                .into_any_element(),
        )
    }

    fn render_palette(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let theme = cx.theme().clone();
        let kind = self.palette?;
        let weak = cx.entity().downgrade();
        let weak_files = weak.clone();

        let palette: gpui::AnyElement = match kind {
            PaletteKind::Commands => {
                let weak = weak.clone();
                let items: Vec<CommandItem> = COMMANDS
                    .iter()
                    .filter_map(|def| {
                        action_for(def.id).map(|action| {
                            CommandItem::new().label(def.label).action(action)
                        })
                    })
                    .collect();
                Command::new(&self.cmd_state)
                    .items(items)
                    .placeholder("输入命令…")
                    .on_confirm(|_ix, _window, _cx| {})
                    .on_cancel(move |window, cx| {
                        defer_workspace(&weak, window, cx, |this, window, cx| {
                            this.close_palette(window, cx);
                        });
                    })
                    .into_any_element()
            }
            PaletteKind::Files => {
                let weak_confirm = weak_files.clone();
                let weak_cancel = weak_files.clone();
                let mut names: Vec<String> = self.mru.clone();
                for f in &self.files {
                    if !names.contains(f) {
                        names.push(f.clone());
                    }
                }
                if let Some(open) = &self.open_path {
                    names.retain(|n| n != open);
                }
                let items: Vec<CommandItem> = names
                    .iter()
                    .take(200)
                    .map(|f| CommandItem::new().label(f.clone()))
                    .collect();
                let names_arc = Arc::new(names);
                Command::new(&self.files_state)
                    .items(items)
                    .placeholder("跳转到笔记…")
                    .on_confirm(move |ix, window, cx| {
                        let Some(target) = names_arc.get(ix.row).cloned() else {
                            return;
                        };
                        defer_workspace(&weak_confirm, window, cx, move |this, window, cx| {
                            this.open_note(target, window, cx);
                            this.close_palette(window, cx);
                        });
                    })
                    .on_cancel(move |window, cx| {
                        defer_workspace(&weak_cancel, window, cx, |this, window, cx| {
                            this.close_palette(window, cx);
                        });
                    })
                    .into_any_element()
            }
        };

        Some(
            div()
                .absolute()
                .inset_0()
                .bg(theme.background.opacity(0.4))
                .occlude()
                .flex()
                .justify_center()
                .items_start()
                .pt(px(80.))
                .child(div().w(px(560.)).child(palette))
                .into_any_element(),
        )
    }
}

/// A settings section heading (TS `.settings-section h3`).
fn settings_heading(title: &str, theme: &gpui_kit::component::theme::Theme) -> impl gpui::IntoElement {
    Label::new(title.to_string())
        .text_xs()
        .text_color(theme.muted_foreground)
        .pb_1()
}

/// One settings row: title and description on the left, the control on the
/// right (TS `.setting-row`).
fn settings_row(
    title: &str,
    desc: &str,
    control: gpui::AnyElement,
    theme: &gpui_kit::component::theme::Theme,
) -> impl gpui::IntoElement {
    h_flex()
        .w_full()
        .items_center()
        .gap_4()
        .child(
            v_flex()
                .flex_1()
                .gap_0p5()
                .child(Label::new(title.to_string()).text_sm())
                .child(
                    Label::new(desc.to_string())
                        .text_xs()
                        .text_color(theme.muted_foreground),
                ),
        )
        .child(control)
}

/// A settings hint paragraph (TS `.setting-hint`).
fn settings_hint(text: &str, theme: &gpui_kit::component::theme::Theme) -> impl gpui::IntoElement {
    Label::new(text.to_string())
        .text_xs()
        .text_color(theme.muted_foreground)
}

/// Whether deleting `rel` takes the open note with it — the note itself, or a
/// folder above it (TS `trashEntry`'s prefix test).
/// Run a workspace update from inside a component callback (the palettes, the
/// link panel). Those run inside the window's own update frame, and gpui takes
/// the window out of `App::windows` for the duration of that frame:
/// `WeakEntity::update_in(&mut App, …)` cannot resolve the entity's window
/// there and fails with "entity has no current window" — silently, because
/// every call site used to discard the error, which is how the quick
/// switcher's Enter and Escape came to do nothing at all.
///
/// `Context::defer_in` is the API for this shape: it records the
/// entity↔window association and runs the closure after the current effect
/// cycle, where the window is addressable again.
fn defer_workspace(
    weak: &gpui::WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
    f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) {
    let Some(workspace) = weak.upgrade() else { return };
    workspace.update(cx, |_this, cx| cx.defer_in(&*window, f));
}

fn deletion_hits_open_note(open: Option<&str>, rel: &str) -> bool {
    open.is_some_and(|p| p == rel || p.starts_with(&format!("{rel}/")))
}

/// Where the open note lives after `rel` was renamed to `new_rel`: the note
/// itself moved, or the folder holding it did (`old_rel` is `rel` or inside
/// it). TS `renameEntry`'s prefix rewrite.
fn renamed_open_note(old_rel: &str, rel: &str, new_rel: &str) -> String {
    if old_rel == rel {
        new_rel.to_string()
    } else {
        format!("{new_rel}/{}", &old_rel[rel.len() + 1..])
    }
}

/// `/\\.(md|markdown|txt)$/i` — the note extension off a typed file name.
/// Only the *trailing* extension goes (unlike `wikilink::note_stem`, a folder
/// part in the name stays).
fn strip_note_ext(name: &str) -> &str {
    let lower = name.to_ascii_lowercase();
    for ext in [".md", ".markdown", ".txt"] {
        if lower.ends_with(ext) {
            return &name[..name.len() - ext.len()];
        }
    }
    name
}

/// The two halves of a link-suggest row (TS splits on the last `/`): the note
/// name without its extension, and the folder it lives in.
fn link_row_parts(rel: &str) -> (String, String) {
    let name = wikilink::note_stem(rel).to_string();
    let dir = match rel.rfind('/') {
        Some(ix) => rel[..ix].to_string(),
        None => String::new(),
    };
    (name, dir)
}

fn abs_to_rel(abs: &str, root: &Option<PathBuf>) -> String {
    match root {
        Some(root) => abs
            .strip_prefix(&root.to_string_lossy().to_string())
            .map(|r| r.trim_start_matches('/').to_string())
            .unwrap_or_else(|| abs.to_string()),
        None => abs.to_string(),
    }
}

/// 1-based (line, column-in-chars) → byte offset, clamped to the text.
fn line_col_to_byte(text: &str, line: usize, col_chars: usize) -> usize {
    let mut cur = 1usize;
    let mut byte = 0usize;
    for b in text.bytes() {
        if cur >= line {
            break;
        }
        if b == b'\n' {
            cur += 1;
        }
        byte += 1;
    }
    let rest = &text[byte..];
    let line_len = rest.find('\n').unwrap_or(rest.len());
    let line_text = &rest[..line_len];
    byte + line_text.chars().take(col_chars).map(|c| c.len_utf8()).sum::<usize>()
}

impl gpui::Render for Workspace {

    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        // Heading auto-numbering runs here, the first place with a window, and
        // before the preview scan below so that scan shapes the numbered text
        // once instead of re-shaping it a frame later.
        if std::mem::take(&mut self.renumber_pending) {
            self.apply_pending_renumber(window, cx);
        }
        let content_changed = self.refresh_preview(window, cx);
        // LaTeX-suite bracket marks: rebuilt when the document or the caret
        // changed (the same subscription that drives the preview) or when the
        // viewport scrolled, so a frame that changes none of them does no work.
        let rows = self.editor.read(cx).visible_row_range();
        if content_changed || rows != self.snippet_marks_rows {
            self.snippet_marks_rows = rows;
            self.snippets.refresh_marks(&self.editor, window, cx);
        }
        self.refresh_study_preview(window, cx);
        let theme = cx.theme().clone();

        let mut main = v_flex()
            .size_full();

        if self.study_mode {
            main = main.child(self.render_study_layout(window, cx));
        } else {
            let editor_col = self.render_editor_column(window, cx);
            if self.sidebar_open && self.vault_root.is_some() {
                main = main.child(
                    h_resizable("main")
                        .child(
                            resizable_panel()
                                // `.sidebar { width: 220px }`
                                .size(px(220.))
                                .child(self.render_sidebar(window, cx)),
                        )
                        .child(editor_col),
                );
            } else {
                main = main.child(editor_col);
            }

            if self.agent_open {
                main = main.child(div().w(px(360.)).h_full().child(self.agent.clone()));
            }
        }

        let palette = if self.palette.is_some() { self.render_palette(cx) } else { None };
        let quick_add = self.render_quick_add(cx);
        let welcome = self.render_welcome(cx);
        let editor_empty = self.render_editor_empty(cx);
        let tree_menu = self.render_tree_menu(cx);
        let rename_prompt = self.render_rename_prompt(cx);
        let ime_picker = self.render_ime_picker(cx);
        let link_suggest = self.render_link_suggest(window, cx);
        let settings = self.render_settings(cx);

        v_flex()
            .id("workspace")
            .relative()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .on_action(cx.listener(Self::save_now))
            .on_action(cx.listener(Self::command_palette))
            .on_action(cx.listener(Self::quick_switcher))
            .on_action(cx.listener(Self::switch_recent_vault))
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::focus_sidebar))
            .on_action(cx.listener(Self::new_note))
            .on_action(cx.listener(Self::new_folder))
            .on_action(cx.listener(Self::open_vault))
            .on_action(cx.listener(Self::quick_add))
            .on_action(cx.listener(Self::open_daily))
            .on_action(cx.listener(Self::send_todo_to_daily))
            .on_action(cx.listener(Self::on_toggle_footprint_zone))
            .on_action(cx.listener(Self::on_toggle_footprint_group))
            .on_action(cx.listener(Self::on_open_footprint_source))
            .on_action(cx.listener(Self::toggle_todo))
            .on_action(cx.listener(Self::cycle_heading))
            .on_action(cx.listener(Self::heading1))
            .on_action(cx.listener(Self::heading2))
            .on_action(cx.listener(Self::heading3))
            .on_action(cx.listener(Self::heading4))
            .on_action(cx.listener(Self::heading5))
            .on_action(cx.listener(Self::heading6))
            .on_action(cx.listener(Self::toggle_bullet))
            .on_action(cx.listener(Self::toggle_numbered))
            .on_action(cx.listener(Self::toggle_bold))
            .on_action(cx.listener(Self::toggle_italic))
            .on_action(cx.listener(Self::toggle_strikethrough))
            .on_action(cx.listener(Self::insert_inline_code))
            .on_action(cx.listener(Self::insert_math_block))
            .on_action(cx.listener(Self::insert_inline_math))
            .on_action(cx.listener(Self::insert_code_block))
            .on_action(cx.listener(Self::insert_python_block))
            .on_action(cx.listener(Self::insert_callout))
            .on_action(cx.listener(Self::insert_wikilink))
            .on_action(cx.listener(Self::insert_hr))
            .on_action(cx.listener(Self::header_todos))
            .on_action(cx.listener(Self::toggle_agent_panel))
            .on_action(cx.listener(Self::toggle_vim))
            .on_action(cx.listener(Self::open_settings))
            .on_action(cx.listener(Self::run_python_note))
            .on_action(cx.listener(Self::stop_python_run))
            .on_action(cx.listener(Self::toggle_python_lsp))
            .on_action(cx.listener(Self::create_py_uv_env))
            .on_action(cx.listener(Self::toggle_study_mode))
            .on_action(cx.listener(Self::toggle_live_preview))
            .on_action(cx.listener(Self::toggle_typewriter))
            .on_action(cx.listener(Self::toggle_snippets))
            .on_action(cx.listener(Self::zoom_in))
            .on_action(cx.listener(Self::zoom_out))
            .on_action(cx.listener(Self::zoom_reset))
            .on_action(cx.listener(Self::close_window))
            .on_action(cx.listener(Self::save_note_and_close))
            .on_action(cx.listener(Self::clear_search_highlight))
            // Dragging a file onto the window opens it in the study pane (TS
            // `ContentPane`'s `onDragDropEvent`); a PDF converts first.
            .on_drop(cx.listener(|this, paths: &gpui::ExternalPaths, window, cx| {
                this.on_study_drop(paths.0.to_vec(), window, cx);
            }))
            // Esc closes the settings modal from anywhere: it takes no focus
            // of its own, so the handler sits on the root — the one element
            // every key dispatch passes through (the link panel's own capture
            // is deeper and runs after this one lets it through).
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key != "escape" {
                    return;
                }
                if this.ime_pick.is_some() {
                    this.ime_pick = None;
                    this.ime_sync(cx);
                    cx.notify();
                } else if this.ex_open {
                    this.close_ex_line(window, cx);
                } else if this.rename_prompt.is_some() {
                    this.rename_prompt = None;
                    this.focus_editor(window, cx);
                    this.ime_sync(cx);
                    cx.notify();
                } else if this.tree_menu.is_some() {
                    this.close_tree_menu(cx);
                } else if this.settings_open {
                    this.close_settings(window, cx);
                } else {
                    return;
                }
                cx.stop_propagation();
            }))
            .child(main)
            .children(welcome)
            .children(palette)
            .children(link_suggest)
            .children(settings)
            .children(quick_add)
            .children(tree_menu)
            .children(rename_prompt)
            .children(ime_picker)
            .children(self.render_ex_line(cx))
            .children(editor_empty)
            .children(self.render_toast(cx))
            .child(
                StatusBar::new()
                    // The TS bar is exactly [mode badge][行 N，列 M] … [●]
                    // [absolute path] (`.status-bar` in global.css): the badge
                    // is accent-bold (`--string` while inserting), the dirty
                    // dot accent, and the path fills the right end, ellipsised
                    // at half the bar. Messages are toasts there, not bar text.
                    .left(
                        h_flex()
                            .gap_3()
                            .child(
                                Label::new(self.vim_badge(cx))
                                    .text_xs()
                                    .font_weight(FontWeight::BOLD)
                                    .min_w(px(52.))
                                    .text_color(self.vim_badge_color(cx)),
                            )
                            .child(Label::new(self.cursor_label.clone()).text_xs()),
                    )
                    .right(
                        h_flex()
                            .gap_3()
                            .child(
                                Label::new(if self.dirty { "●" } else { "" })
                                    .text_xs()
                                    .text_color(self.preview.palette(cx).color("accent")),
                            )
                            .child(
                                Label::new(self.open_note_abs_path())
                                    .text_xs()
                                    .whitespace_nowrap()
                                    .text_overflow(gpui::TextOverflow::Truncate("…".into()))
                                    // `.file-hint { max-width: 50% }`: of the
                                    // bar, which spans the window.
                                    .max_w(window.viewport_size().width * 0.5),
                            ),
                    ),
            )
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, cx: &gpui::App) -> gpui::FocusHandle {
        self.editor.focus_handle(cx)
    }
}

/// Rebuilds the whole file tree from the flat vault index. bnote vaults are
/// ordinary folders (the reference one is ~70KB of markdown), so a full
/// rebuild per change is far below a frame budget; lazy loading returns when
/// a measured need shows up.
async fn reload_tree(
    this: WeakEntity<Workspace>,
    tree: Entity<TreeState>,
    cx: &mut gpui::AsyncApp,
) {
    let state = match this.update(cx, |this, _cx| this.state.clone()) {
        Ok(state) => state,
        Err(_) => return,
    };

    let index = cx
        .background_executor()
        .spawn(async move { bnote_core::commands::vault::list_files(&state) })
        .await;

    // TreeItem holds Rc cells, so building must stay on the main thread; the
    // flat index it consumes is tiny (one entry per note/dir).
    if let Ok(index) = index {
        let files: Vec<String> = index
            .files
            .iter()
            .filter(|f| f.ends_with(".md"))
            .cloned()
            .collect();
        // The media index is what turns a bare `![[Pasted image 1.png]]` into
        // a path; a new file may be exactly the one some note refers to, so a
        // changed index re-scans the preview.
        let assets = index.assets.clone();
        let _ = this.update(cx, |this, cx| {
            this.files = files;
            if this.preview.images().set_assets(assets) {
                this.preview_dirty = true;
                cx.notify();
            }
        });
        let _ = this.update(cx, |this, cx| {
            this.tree_dirs = index.dirs.iter().cloned().collect();
            let items = build_items(&index, &this.expanded_dirs);
            tree.update(cx, |state, cx| state.set_items(items, cx));
            // `set_items` drops the selection; the open note's row takes it
            // back (the rebuilt rows are the same paths).
            this.sync_tree_selection(cx);
        });
    }
}

/// Flattens the vault index (dirs + files, both vault-relative) into TreeItems
/// sorted dirs-first by name, matching the Tauri shell's tree order.
///
/// Directory-ness comes from `index.dirs`, never from "has children": the
/// recursion is what *creates* the children, so a `TreeItem` is still empty
/// when its own turn to nest comes — testing `is_folder()` there would end the
/// recursion at the first level and no directory would ever get any.
fn build_items(
    index: &bnote_core::commands::vault::VaultIndex,
    expanded: &std::collections::HashSet<String>,
) -> Vec<TreeItem> {
    let mut by_parent: HashMap<String, Vec<TreeItem>> = HashMap::new();
    let dirs = index
        .dirs
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();

    // Register every directory as a child of its parent so empty dirs show.
    for dir in &index.dirs {
        let (parent, name) = split_last(dir);
        by_parent.entry(parent).or_default().push(TreeItem::new(dir.clone(), name));
    }

    for file in &index.files {
        let (parent, name) = split_last(file);
        by_parent.entry(parent).or_default().push(TreeItem::new(file.clone(), name));
    }

    fn attach(
        by_parent: &mut HashMap<String, Vec<TreeItem>>,
        dirs: &std::collections::HashSet<&str>,
        expanded: &std::collections::HashSet<String>,
        parent: &str,
    ) -> Vec<TreeItem> {
        let Some(mut children) = by_parent.remove(parent) else {
            return Vec::new();
        };
        children.sort_by(|a, b| a.label.cmp(&b.label));
        for child in children.iter_mut() {
            if dirs.contains(child.id.as_ref()) {
                let id = child.id.to_string();
                let subs = attach(by_parent, dirs, expanded, &id);
                // The user's open folders come back open after a refresh
                // (the flag lives on the item, so it is set here, where the
                // fresh items are built).
                *child = child.clone().expanded(expanded.contains(&id)).children(subs);
            }
        }
        children
    }

    let mut top = attach(&mut by_parent, &dirs, expanded, "");
    top.sort_by_key(|item| {
        let is_dir = dirs.contains(item.id.as_ref());
        (!is_dir, item.label.to_lowercase())
    });
    top
}

fn split_last(rel: &str) -> (String, String) {
    match rel.rfind('/') {
        Some(i) => (rel[..i].to_string(), rel[i + 1..].to_string()),
        None => (String::new(), rel.to_string()),
    }
}

/// Snapshots the current buffer on the UI thread, then writes it on the
/// background executor guarded by the seq lock. Stale snapshots (a newer edit
/// happened while we waited) are dropped — a newer task owns the flush.
/// After the write lands, the daily-sync host derives mirror/send intents.
/// Writes the open note. `autosave` is the debounced path's generation: when it
/// no longer matches, the switch was flipped off while the timer ran and the
/// write is dropped (TS clears the pending timeout).
async fn save_snapshot(
    this: WeakEntity<Workspace>,
    seq: u64,
    autosave: Option<u64>,
    cx: &mut gpui::AsyncApp,
) {
    let (state, root, path, text, guard, daily, today) = match this.update(cx, |this, cx| {
        if autosave.is_some_and(|gen| gen != this.autosave_gen) {
            return None;
        }
        let Some(root) = this.vault_root.clone() else {
            return None;
        };
        let Some(rel) = this.open_path.clone() else {
            return None;
        };
        let daily = this.daily.clone();
        let today = this.today.clone();
        let text = this.editor.read(cx).value().to_string();
        Some((this.state.clone(), root, rel, text, this.save_guard.clone(), daily, today))
    }) {
        Ok(Some(tuple)) => tuple,
        Ok(None) => return,
        Err(_) => return,
    };

    let full = root.join(&path);
    let abs = full.to_string_lossy().to_string();

    let written = cx
        .background_executor()
        .spawn(async move {
            write_note_and_followups(
                &state,
                &guard,
                daily.as_deref(),
                &today,
                abs,
                text,
                seq,
            )
        })
        .await;

    this.update_in(cx, |this, window, cx| {
        match written {
            Some(followups) => {
                if seq == this.save_seq {
                    this.dirty = false;
                    this.status = format!("已保存 {}", path);
                }
                // Baseline the follow-up writes so the next save diffs cleanly.
                if let Some(daily) = &this.daily {
                    for w in &followups {
                        daily.record_synced(&w.path, &w.text);
                    }
                }
                // The sync may have mutated the link store (link state lives
                // outside the document), and the marks on the open file's
                // todo lines read from it.
                this.preview_dirty = true;
                // If a follow-up touched the open file, pull it in.
                let open_abs = this
                    .vault_root
                    .as_ref()
                    .zip(this.open_path.clone())
                    .map(|(r, p)| r.join(p).to_string_lossy().to_string());
                if let Some(w) = open_abs
                    .as_deref()
                    .and_then(|o| followups.iter().find(|w| w.path == o))
                {
                    let new_text = w.text.clone();
                    this.replace_buffer(&new_text, window, cx);
                    this.dirty = false;
                }
            }
            None => {
                this.report_failure("保存失败(见日志)".to_string(), cx);
            }
        }
        cx.notify();
    })
    .ok();
}

/// One note write and everything it implies: the file itself, then the daily
/// sync's follow-up writes derived from it. The seq guard drops a write an
/// older one has already superseded.
fn write_note_and_followups(
    state: &bnote_core::state::AppState,
    guard: &Mutex<u64>,
    daily: Option<&DailyHost>,
    today: &str,
    abs: String,
    text: String,
    seq: u64,
) -> Option<Vec<SyncWrite>> {
    let mut last = guard.lock().unwrap();
    if seq <= *last {
        return None;
    }
    // core's write_file keeps the ensure_within path guard.
    if bnote_core::commands::files::write_file(state, abs.clone(), text.clone()).is_err() {
        return None;
    }
    *last = seq;
    // Daily sync derives intents from this save; host does its own IO.
    match daily {
        Some(host) => Some(host.on_saved(&abs, &text, today)),
        None => Some(Vec::new()),
    }
}

/// Pure-logic pins for the renumbering gate and the demotion tests. A module
/// with *exact* imports (no `use super::*`): the parent's glob brings in the
/// kit's `test` macro, which shadows the built-in `#[test]`.
#[cfg(test)]
mod gate_tests {
    use super::{
        TreeMenuItem, cycle_demotes_cursor_line, deletion_hits_open_note,
        level_toggle_demotes_cursor_line, link_row_parts, renamed_open_note,
        should_schedule_renumber,
    };
    use gpui_kit::component::input::InputEvent;

    /// The three gates of the schedule decision: the pass must not re-apply
    /// what an undo/redo just removed and must not re-trigger on its own
    /// edit; every other change schedules it.
    #[test]
    fn the_renumber_gate_skips_replays_and_its_own_edit() {
        let user = InputEvent::Change { history: false };
        let replay = InputEvent::Change { history: true };
        assert!(should_schedule_renumber(&user, 7, None));
        assert!(should_schedule_renumber(&user, 7, Some(6)), "an older revision");
        assert!(
            !should_schedule_renumber(&user, 7, Some(7)),
            "the pass's own edit (revision it left behind)"
        );
        assert!(
            !should_schedule_renumber(&replay, 7, None),
            "a replay must not re-schedule, whatever the revision"
        );
        assert!(
            !should_schedule_renumber(&InputEvent::Focus, 7, None),
            "only document changes schedule"
        );
    }

    /// The demotion tests the toggle commands mirror from TS `builtin.ts`:
    /// `cycle` demotes from H4 on, a level toggle on the exact level.
    #[test]
    fn heading_demotion_mirrors_the_ts_tests() {
        assert_eq!(cycle_demotes_cursor_line("#### 1 标题", 0), (0, true));
        assert_eq!(cycle_demotes_cursor_line("##### 1.1 深", 0), (0, true));
        assert_eq!(cycle_demotes_cursor_line("### 1 标题", 0), (0, false));
        assert_eq!(cycle_demotes_cursor_line("正文", 0), (0, false));
        // The cursor's line, not the document's first.
        let doc = "第一行\n## 2 标题";
        assert_eq!(cycle_demotes_cursor_line(doc, 12), (10, false));

        assert_eq!(
            level_toggle_demotes_cursor_line("## 2 标题", 3, 2),
            (0, true)
        );
        assert_eq!(
            level_toggle_demotes_cursor_line("## 2 标题", 3, 1),
            (0, false)
        );
        assert_eq!(level_toggle_demotes_cursor_line("正文", 0, 2), (0, false));
    }

    /// Path prefix arithmetic of the tree menu's delete and rename (the parts
    /// a wrong answer silently corrupts: the open note's identity).
    #[test]
    fn delete_and_rename_follow_the_open_note_by_prefix() {
        assert!(deletion_hits_open_note(Some("a/b.md"), "a/b.md"));
        assert!(deletion_hits_open_note(Some("a/b/c.md"), "a/b"));
        assert!(!deletion_hits_open_note(Some("a/b2.md"), "a/b"));
        assert!(!deletion_hits_open_note(None, "a/b"));

        // The note itself moved: the whole path is replaced.
        assert_eq!(renamed_open_note("a/b.md", "a/b.md", "a/c.md"), "a/c.md");
        // Its folder moved: only the prefix is replaced.
        assert_eq!(renamed_open_note("a/b/c.md", "a/b", "x/y"), "x/y/c.md");
    }

    /// The tree menu's entries per row kind (TS `TreeItem.openMenu`): a folder
    /// creates, a file opens; rename and delete are on both, delete last.
    #[test]
    fn the_tree_menu_matches_the_row_kind() {
        let dir = TreeMenuItem::for_row(true);
        assert_eq!(
            dir,
            &[
                TreeMenuItem::NewNote,
                TreeMenuItem::NewFolder,
                TreeMenuItem::Rename,
                TreeMenuItem::Delete,
            ]
        );
        let file = TreeMenuItem::for_row(false);
        assert_eq!(
            file,
            &[TreeMenuItem::Open, TreeMenuItem::Rename, TreeMenuItem::Delete]
        );
        assert!(TreeMenuItem::Delete.is_danger());
        assert!(!TreeMenuItem::Rename.is_danger());
    }

    /// A link-suggest row splits on the last `/` into the note name (extension
    /// off) and the folder — the TS row's two spans.
    #[test]
    fn link_rows_split_the_name_from_its_folder() {
        assert_eq!(
            link_row_parts("notes/sub/a.md"),
            ("a".to_string(), "notes/sub".to_string())
        );
        assert_eq!(link_row_parts("a.markdown"), ("a".to_string(), String::new()));
        assert_eq!(link_row_parts("b"), ("b".to_string(), String::new()));
    }
}

/// Exact imports, no `use super::*`: the parent's glob re-exports the kit's
/// `test` macro, which shadows the built-in `#[test]` the kit's own
/// `#[gpui::test]` expands into (infinite recursion otherwise).
#[cfg(test)]
mod tests {
    use super::{
        AUTOSAVE_DEBOUNCE, EditorState, HotkeyFilter, InputEvent, PY_RUN_MAX_LINES,
        PY_RUN_TRIM_TO, PyRunState, PyStatus, PyStream, StudyContent, TOAST_DURATION,
        TreeMenuItem, Workspace,
        action_for, actions, apply_edits_keeping_cursor, load_config_value, line_col_to_byte,
        normalize_split, numbering, should_schedule_renumber, wikilink, COMMANDS,
    };
    use crate::commands::keybinding_for;
    use crate::harness::{inert_ime, inert_lsp};
    use gpui::px;
    use std::path::PathBuf;
    use crate::ime_host::{CurrentSource, ImeServices, Switcher};
    #[allow(unused_imports)]
    use crate::python_lsp::PyLspServices;
    use gpui_kit::base::input as bc_diag;
    use gpui::{
        AppContext as _, Context, Focusable as _, IntoElement, Render, Task, TestAppContext, Window,
        div,
    };
    use std::rc::Rc;

    use super::{ImePickField, SettingsTab};

    /// The pass end to end on the real engine: the computed edits go through
    /// `apply_edits_keeping_cursor`, the text gains its numbers, the caret
    /// keeps its place in the body, and the revision the pass reports makes
    /// its own `Change` recognisable to the gate.
    #[gpui::test]
    fn the_pass_renumbers_and_keeps_the_caret(cx: &mut TestAppContext) {
        struct Root;
        impl Render for Root {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div()
            }
        }

        cx.update(|cx| {
            gpui_kit::init(cx);
            let mut editor = None;
            cx.open_window(Default::default(), |window, cx| {
                editor = Some(cx.new(|cx| EditorState::new(window, cx).language("markdown")));
                cx.new(|_| Root)
            })
            .expect("a test window")
            .update(cx, |_, window, cx| {
                let editor = editor.clone().expect("the editor");
                editor.update(cx, |state, cx| {
                    state.set_value("## 一\n\n正文", window, cx);
                    state.set_selected_range(8..8, cx); // inside 「正文」
                });

                let text = editor.read(cx).value().to_string();
                let edits = numbering::renumber_changes(&text);
                assert_eq!(edits.len(), 1, "{edits:?}");
                let ranges: Vec<(std::ops::Range<usize>, String)> =
                    edits.into_iter().map(|e| (e.from..e.to, e.insert)).collect();
                let done_rev = apply_edits_keeping_cursor(&editor, &ranges, window, cx);
                let done_rev = done_rev.expect("the document changed");

                editor.read_with(cx, |state, _| {
                    assert_eq!(state.value(), "## 1 一\n\n正文");
                    // The pass only rewrote the marker prefix, so the caret in
                    // the body shifted by the +2 the prefix grew.
                    assert_eq!(state.cursor(), 10);
                });

                // The pass's own Change carries this revision; the gate turns
                // it away, so a renumbering pass cannot loop.
                assert!(!should_schedule_renumber(
                    &InputEvent::Change { history: false },
                    done_rev,
                    Some(done_rev)
                ));
                // A user edit after it schedules again.
                assert!(should_schedule_renumber(
                    &InputEvent::Change { history: false },
                    done_rev + 1,
                    Some(done_rev)
                ));
            })
            .unwrap();
        });
    }

    /// The link-suggest pick path through the real engine: the target text
    /// for a duplicated name is its path, the selection becomes the alias, the
    /// link replaces the selection at the caret, and the caret lands after it.
    #[gpui::test]
    fn a_picked_link_lands_with_the_selection_as_its_alias(cx: &mut TestAppContext) {
        struct Root;
        impl Render for Root {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div()
            }
        }

        cx.update(|cx| {
            gpui_kit::init(cx);
            let mut editor = None;
            cx.open_window(Default::default(), |window, cx| {
                editor = Some(cx.new(|cx| EditorState::new(window, cx).language("markdown")));
                cx.new(|_| Root)
            })
            .expect("a test window")
            .update(cx, |_, window, cx| {
                let editor = editor.clone().expect("the editor");
                let files = vec![
                    "notes/这个说法.md".to_string(),
                    "archive/这个说法.md".to_string(),
                    "别的.md".to_string(),
                ];
                // Two notes share the name: the link text must be the path.
                let target = wikilink::link_text("notes/这个说法.md", &files).expect("writable");
                assert_eq!(target, "notes/这个说法");
                // A unique name stays bare.
                assert_eq!(
                    wikilink::link_text("别的.md", &files).as_deref(),
                    Some("别的")
                );

                editor.update(cx, |state, cx| {
                    state.set_value("看看 这个说法 和 [[旧链接]]", window, cx);
                    state.set_selected_range(7..19, cx); // 「这个说法」 (4 chars × 3 bytes)
                });
                let (doc, selection) = {
                    let state = editor.read(cx);
                    (state.value().to_string(), state.selected_range())
                };
                let out = wikilink::link_insert(&doc, selection, &target);
                crate::apply_ops::apply_outcome(&editor, &out, window, cx);

                editor.read_with(cx, |state, _| {
                    assert_eq!(state.value(), "看看 [[notes/这个说法|这个说法]] 和 [[旧链接]]");
                    // The caret sits right after the written link.
                    assert_eq!(state.cursor(), "看看 [[notes/这个说法|这个说法]]".len());
                });
            })
            .unwrap();
        });
    }

    /// The link-suggest wiring on a real workspace: ⌘K opens the panel over an
    /// open note (and a second ⌘K puts it away), the pick writes the picked
    /// note as a link at the caret, and a document revision that changed while
    /// the panel was open makes the pick a no-op.
    #[gpui::test]
    fn the_link_panel_opens_closes_and_writes_the_picked_note(cx: &mut TestAppContext) {
        cx.update(|cx| gpui_kit::init(cx));
        let (state, rx) = bnote_core::state::AppState::new(std::env::temp_dir());
        let mut bridges = None;
        cx.update(|cx| {
            bridges = Some((
                crate::editor::snippets_host::SnippetBridge::init(cx),
                crate::editor::vim::integration::VimBridge::init(cx),
            ));
        });
        let (snippet_bridge, vim_bridge) = bridges.expect("the bridges");
        let (workspace, cx) = cx.add_window_view(move |window, cx| {
            let ws = Workspace::new(
                state.clone(),
                rx.resubscribe(),
                None,
                vim_bridge,
                snippet_bridge,
                inert_ime(),
                inert_lsp(),
                window,
                cx,
            );
            // Actions dispatch along the focus path; the editor is the view's
            // focus handle (the deferred focus in `new` has not run yet).
            let focus = ws.editor.focus_handle(cx);
            window.focus(&focus, cx);
            ws
        });

        workspace.update_in(cx, |ws, window, cx| {
            // A stand-in vault: the pick path never touches the disk.
            ws.vault_root = Some(std::path::PathBuf::from("/vault"));
            ws.open_path = Some("a.md".to_string());
            ws.files = vec!["a.md".to_string(), "b.md".to_string()];
            ws.editor.update(cx, |st, cx| {
                st.set_value("正文", window, cx);
                st.set_selected_range(6..6, cx);
            });
        });

        cx.run_until_parked();
        cx.dispatch_action(actions::InsertWikilink);
        workspace.read_with(cx, |ws, _| assert!(ws.link_suggest, "⌘K opens the panel"));

        cx.dispatch_action(actions::InsertWikilink);
        workspace.read_with(cx, |ws, _| assert!(!ws.link_suggest, "⌘K again puts it away"));

        cx.dispatch_action(actions::InsertWikilink);
        workspace.update_in(cx, |ws, window, cx| {
            assert!(ws.link_suggest);
            ws.insert_wikilink_pick("a.md", window, cx);
            assert!(!ws.link_suggest, "the pick closes the panel");
            assert_eq!(ws.editor.read(cx).value(), "正文[[a]]");
            assert_eq!(ws.editor.read(cx).cursor(), 6 + 5);
        });

        // The caret line now holds a link: ⌘K follows it instead of opening
        // the panel — and a self-link is a silent no-op.
        cx.dispatch_action(actions::InsertWikilink);
        workspace.read_with(cx, |ws, _| {
            assert!(!ws.link_suggest);
            assert_eq!(ws.open_path.as_deref(), Some("a.md"));
        });

        // On a fresh line the panel opens again; the document revision it
        // pinned is the self-check, so a revision that moved underneath it
        // (an external reload) refuses the write instead of writing blind.
        workspace.update_in(cx, |ws, window, cx| {
            ws.editor.update(cx, |st, cx| {
                st.set_value("正文[[a]]\n", window, cx);
                st.set_selected_range(12..12, cx); // the fresh empty line
            });
        });
        cx.dispatch_action(actions::InsertWikilink);
        workspace.update_in(cx, |ws, window, cx| {
            assert!(ws.link_suggest);
            ws.link_pick_rev = Some(ws.editor.read(cx).document_revision() + 1);
            ws.insert_wikilink_pick("b.md", window, cx);
            assert_eq!(ws.editor.read(cx).value(), "正文[[a]]\n");
            assert!(!ws.link_suggest);
        });
    }

    /// `set clipboard=unnamed`: a yank mirrors out to the system clipboard and
    /// a paste reads what another app put there.
    #[gpui::test]
    fn the_vimrc_clipboard_flag_wires_the_system_clipboard(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        workspace.update_in(cx, |ws, window, cx| {
            ws.set_vim_setting(true, cx);
            ws.vim_bridge.set_vimrc(Some("set clipboard=unnamed\n"), None);
            ws.editor.update(cx, |st, cx| {
                st.set_value("第一行\n第二行\n", window, cx);
                st.set_selected_range(0..0, cx);
            });
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let window = cx.update(|window, _| window.window_handle());
        let chord = |cx: &mut gpui::VisualTestContext, text: &str| {
            let ks = gpui::Keystroke::parse(text).expect("a keystroke");
            cx.dispatch_keystroke(window, ks);
        };

        // `yy` yanks the line into the unnamed register — and, with the flag
        // set, onto the system clipboard.
        chord(cx, "y");
        chord(cx, "y");
        cx.run_until_parked();
        let clip = cx.read_from_clipboard().and_then(|item| item.text());
        assert_eq!(clip.as_deref(), Some("第一行\n"), "the yank reached the clipboard");

        // A paste takes whatever the clipboard holds now (another app's copy).
        cx.write_to_clipboard(gpui::ClipboardItem::new_string("外来\n".to_string()));
        chord(cx, "p");
        cx.run_until_parked();
        workspace.read_with(cx, |ws, cx| {
            let text = ws.editor.read(cx).value().to_string();
            assert!(text.contains("外来"), "the paste read the system clipboard: {text:?}");
        });

        // With the flag off the two stay separate.
        workspace.update_in(cx, |ws, window, cx| {
            ws.vim_bridge.set_vimrc(Some(""), None);
            ws.editor.update(cx, |st, cx| {
                st.set_value("甲\n乙\n", window, cx);
                st.set_selected_range(0..0, cx);
            });
        });
        cx.write_to_clipboard(gpui::ClipboardItem::new_string("外部\n".to_string()));
        chord(cx, "y");
        chord(cx, "y");
        cx.run_until_parked();
        let clip = cx.read_from_clipboard().and_then(|item| item.text());
        assert_eq!(clip.as_deref(), Some("外部\n"), "the yank stayed internal");
    }

    /// Typing a snippet trigger expands it through the real keystroke path:
    /// the snippet bridge is registered as an interceptor, and a dropped
    /// subscription there would leave the whole LaTeX-suite feature dead
    /// (the same bug class the vim bridge had).
    #[gpui::test]
    fn typed_snippet_triggers_expand_through_the_keystroke_path(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        workspace.update_in(cx, |ws, window, cx| {
            ws.editor.update(cx, |st, cx| {
                st.set_value("$$", window, cx);
                // Between the two `$`: inside inline math, where `pa` expands.
                st.set_selected_range(1..1, cx);
            });
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let window = cx.update(|window, _| window.window_handle());
        for c in "pa".chars() {
            let key = c.to_string();
            cx.dispatch_keystroke(
                window,
                gpui::Keystroke {
                    modifiers: Default::default(),
                    key: key.clone(),
                    key_char: Some(key),
                },
            );
        }
        cx.run_until_parked();
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(
                ws.editor.read(cx).value(),
                "$\\partial$",
                "`pa` expanded to \\partial (the typed prefix was replaced)"
            );
        });
    }

    /// The vimrc round trip through the real keystroke path: `imap jj <Esc>`
    /// leaves insert, `noremap r $` moves to the line end, a held prefix that
    /// cannot complete is flushed by the timeout, command mappings run their
    /// action, and an unknown command id is reported instead of vanishing.
    #[gpui::test]
    fn vimrc_mappings_run_through_the_keystroke_path(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        workspace.update_in(cx, |ws, window, cx| {
            ws.set_vim_setting(true, cx);
            ws.editor.update(cx, |st, cx| {
                st.set_value("第一行\n第二行\n第三行\n", window, cx);
                st.set_selected_range(0..0, cx);
            });
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let window = cx.update(|window, _| window.window_handle());
        // Printable keys must carry `key_char` — the vim adapter reads them
        // from there, and the platform only sets it for real typing.
        let press = |cx: &mut gpui::VisualTestContext, text: &str| {
            for c in text.chars() {
                let key = c.to_string();
                cx.dispatch_keystroke(
                    window,
                    gpui::Keystroke {
                        modifiers: Default::default(),
                        key: key.clone(),
                        key_char: Some(key),
                    },
                );
            }
        };
        let chord = |cx: &mut gpui::VisualTestContext, text: &str| {
            let ks = gpui::Keystroke::parse(text).expect("a keystroke");
            cx.dispatch_keystroke(window, ks);
        };
        let mode = |cx: &mut gpui::VisualTestContext| {
            workspace.read_with(cx, |ws, _| ws.vim_bridge.mode_of(&ws.editor))
        };

        // A vimrc with the shapes the owner's own file uses.
        workspace.read_with(cx, |ws, _| {
            let report = ws.vim_bridge.set_vimrc(
                Some(
                    "imap jj <Esc>\n\
                     noremap r $\n\
                     noremap q 0\n\
                     nnoremap J <C-d>\n\
                     nmap <C-s> :w<CR>\n\
                     nmap <C-e> :Bnote nav.toggle-sidebar<CR>\n\
                     nmap <C-g> :Nope<CR>\n",
                ),
                None,
            );
            assert!(report.errors.is_empty(), "{:?}", report.errors);
            // `noremap` covers normal + visual, so it counts twice.
            assert_eq!(report.mappings, 9, "one per mode the command covers");
        });

        eprintln!(
            "[debug] attached mode = {:?}, focused = {}",
            workspace.read_with(cx, |ws, _| ws.vim_bridge.mode_of(&ws.editor)),
            cx.update(|window, cx| workspace.read(cx).editor.read(cx).focus_handle(cx).is_focused(window))
        );
        // `i` enters insert; `jj` leaves it without typing anything.
        press(cx, "i");
        assert_eq!(mode(cx), Some(crate::editor::vim::core::Mode::Insert));
        press(cx, "jj");
        assert_eq!(mode(cx), Some(crate::editor::vim::core::Mode::Normal));
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(ws.editor.read(cx).value(), "第一行\n第二行\n第三行\n");
        });

        // A lone `j` in insert mode is held, then flushed by the timeout
        // (parking advances the clock to it): the character lands and the
        // mode stays insert.
        press(cx, "i");
        press(cx, "j");
        cx.executor().advance_clock(std::time::Duration::from_millis(1200));
        cx.run_until_parked();
        assert_eq!(mode(cx), Some(crate::editor::vim::core::Mode::Insert));
        workspace.read_with(cx, |ws, cx| {
            assert!(
                ws.editor.read(cx).value().contains('j'),
                "the timeout replayed the held key: {}",
                ws.editor.read(cx).value()
            );
        });
        chord(cx, "escape");

        // `noremap r $`: `r` is a complete mapping, so it fires at once and
        // the cursor lands at the line end.
        workspace.update_in(cx, |ws, _, cx| {
            ws.editor.update(cx, |st, cx| st.set_selected_range(0..0, cx));
        });
        press(cx, "r");
        workspace.read_with(cx, |ws, cx| {
            let cursor = ws.editor.read(cx).cursor();
            let text = ws.editor.read(cx).value().to_string();
            assert!(
                text[cursor..].starts_with("行\n"),
                "the cursor sits on the line's last char: {:?}",
                &text[cursor..]
            );
        });

        // A normal-mode `x` is not a prefix of anything: it deletes a char.
        press(cx, "x");
        workspace.read_with(cx, |ws, cx| {
            assert!(
                !ws.editor.read(cx).value().contains("第一行"),
                "x reached the engine: {}",
                ws.editor.read(cx).value()
            );
        });

        // The command mappings: `:w` saves, `:Bnote …` toggles the sidebar,
        // an unknown id lands in the status line.
        workspace.update_in(cx, |ws, _, _| {
            ws.open_path = Some("note.md".to_string());
            ws.dirty = true;
        });
        chord(cx, "ctrl-s");
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert!(!ws.dirty, "⌃S ran workspace.save-note: {}", ws.status);
        });
        let sidebar_before = workspace.read_with(cx, |ws, _| ws.sidebar_open);
        chord(cx, "ctrl-e");
        workspace.read_with(cx, |ws, _| {
            assert_ne!(ws.sidebar_open, sidebar_before, "⌃E ran the mapped command");
        });
        chord(cx, "ctrl-g");
        workspace.read_with(cx, |ws, _| assert_eq!(ws.status, "vimrc: 未知命令 Nope"));

        // And the mappings can be cleared again (an empty vimrc).
        workspace.read_with(cx, |ws, _| {
            let report = ws.vim_bridge.set_vimrc(Some(""), None);
            assert_eq!(report.mappings, 0);
            assert!(!ws.vim_bridge.has_mappings());
        });
    }

    /// The hotkeys tab's model: assigning a binding writes `keybindings.json`
    /// (the TS shell's file) and rebuilds the gpui keymap; a conflict sweeps
    /// the other command; reset and unbind go back to the defaults.
    #[gpui::test]
    fn the_hotkeys_tab_rewrites_the_file_and_the_keymap(cx: &mut TestAppContext) {
        fn keys_of(cx: &mut gpui::VisualTestContext, action: &dyn gpui::Action) -> Vec<String> {
            let keymap = cx.update(|_, cx| cx.key_bindings());
            let keymap = keymap.borrow();
            keymap
                .bindings_for_action(action)
                .map(|binding| {
                    binding
                        .keystrokes()
                        .iter()
                        .map(|k| k.unparse())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect()
        }
        fn stored(file: &std::path::Path) -> serde_json::Value {
            serde_json::from_str(&std::fs::read_to_string(file).expect("the file exists"))
                .expect("and holds JSON")
        }

        let (workspace, cx) = python_panel_fixture(cx);
        let file = workspace.read_with(cx, |ws, _| ws.state.data_dir().join("keybindings.json"));

        // The registry defaults are in the keymap while no override exists.
        assert_eq!(keys_of(cx, &actions::ToggleBold), ["cmd-b"]);
        assert!(!file.exists(), "nothing is written until something changes");

        // ⌘B → ⌃B: the file and the keymap both move.
        workspace.update_in(cx, |ws, _, cx| {
            ws.set_hotkey_binding("edit.toggle-bold", vec!["ctrl-b".to_string()], cx);
        });
        assert_eq!(stored(&file)["edit.toggle-bold"], serde_json::json!("ctrl-b"));
        assert_eq!(keys_of(cx, &actions::ToggleBold), ["ctrl-b"], "the keymap took it");
        assert_eq!(keys_of(cx, &actions::ToggleItalic), ["cmd-shift-i"], "neighbours are untouched");

        // A conflict sweeps the other command (TS sets it to `null`).
        workspace.update_in(cx, |ws, _, cx| {
            ws.set_hotkey_binding("nav.quick-switcher", vec!["cmd-t".to_string()], cx);
        });
        assert_eq!(stored(&file)["nav.quick-switcher"], serde_json::json!("cmd-t"));
        assert_eq!(stored(&file)["nav.header-todos"], serde_json::Value::Null);
        assert!(keys_of(cx, &actions::HeaderTodos).is_empty(), "the loser is unbound");

        // Unbind, then reset: the registry default comes back.
        workspace.update_in(cx, |ws, _, cx| {
            ws.set_hotkey_binding("edit.toggle-bold", Vec::new(), cx);
        });
        assert_eq!(stored(&file)["edit.toggle-bold"], serde_json::Value::Null);
        assert!(keys_of(cx, &actions::ToggleBold).is_empty());
        workspace.update_in(cx, |ws, _, cx| ws.reset_hotkey("edit.toggle-bold", cx));
        assert_eq!(keys_of(cx, &actions::ToggleBold), ["cmd-b"]);

        // Reset all writes the empty object the TS shell writes.
        workspace.update_in(cx, |ws, _, cx| ws.reset_all_hotkeys(cx));
        assert_eq!(stored(&file), serde_json::json!({}));
        assert_eq!(keys_of(cx, &actions::QuickSwitcher), ["cmd-o"], "everything is back");
        assert_eq!(keys_of(cx, &actions::HeaderTodos), ["cmd-t"]);
    }

    /// The capture loop: a real keystroke becomes the binding, Esc cancels, a
    /// lone modifier keeps waiting, and the keymap follows.
    #[gpui::test]
    fn a_captured_keystroke_becomes_the_binding(cx: &mut TestAppContext) {
        fn keys_of(cx: &mut gpui::VisualTestContext, action: &dyn gpui::Action) -> Vec<String> {
            let keymap = cx.update(|_, cx| cx.key_bindings());
            let keymap = keymap.borrow();
            keymap
                .bindings_for_action(action)
                .map(|binding| {
                    binding
                        .keystrokes()
                        .iter()
                        .map(|k| k.unparse())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect()
        }
        let stroke = |s: &str| gpui::Keystroke::parse(s).expect("a keystroke");

        let (workspace, cx) = python_panel_fixture(cx);
        // Esc cancels: nothing is written, the default stays.
        workspace.update_in(cx, |ws, window, cx| {
            ws.capture_hotkey("edit.toggle-italic", window, cx);
            assert!(ws.hotkey_capturing.is_some(), "the row is capturing");
            assert!(
                crate::keybindings::HotkeyCaptureActive::active(cx),
                "the vim and snippet bridges stand down while capturing"
            );
            ws.on_hotkey_keystroke(&stroke("escape"), cx);
            assert!(ws.hotkey_capturing.is_none());
            assert!(!crate::keybindings::HotkeyCaptureActive::active(cx));
            assert!(ws.key_overrides.is_empty());
        });
        assert_eq!(keys_of(cx, &actions::ToggleItalic), ["cmd-shift-i"]);

        // A lone modifier keeps the capture open.
        workspace.update_in(cx, |ws, window, cx| {
            ws.capture_hotkey("edit.toggle-italic", window, cx);
            ws.on_hotkey_keystroke(&stroke("shift"), cx);
            assert_eq!(ws.hotkey_capturing.as_deref(), Some("edit.toggle-italic"));
        });

        // A real chord lands — the TS `eventToKey` spelling, normalized.
        workspace.update_in(cx, |ws, _, cx| {
            ws.on_hotkey_keystroke(&stroke("ctrl-shift-j"), cx);
            assert!(ws.hotkey_capturing.is_none(), "the capture ended with the binding");
        });
        assert_eq!(keys_of(cx, &actions::ToggleItalic), ["ctrl-shift-j"]);
        assert_eq!(
            workspace.read_with(cx, |ws, _| ws.key_overrides["edit.toggle-italic"].clone()),
            ["ctrl-shift-j"]
        );
        let active = cx.update(|_, cx| crate::keybindings::HotkeyCaptureActive::active(cx));
        assert!(!active, "the gate opens again when the capture lands");
    }

    /// The hotkeys tab lays out and draws — the list, the chips, the filter
    /// row and the capturing row — through the real modal.
    #[gpui::test]
    fn the_hotkeys_tab_draws(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        cx.dispatch_action(actions::OpenSettings);
        workspace.update_in(cx, |ws, window, cx| {
            ws.set_settings_tab(SettingsTab::Hotkeys, cx);
            ws.hotkey_query
                .clone()
                .update(cx, |st, cx| st.set_value("标题", window, cx));
            ws.hotkey_filter = HotkeyFilter::Assigned;
            ws.capture_hotkey("edit.toggle-heading", window, cx);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |ws, _| {
            assert_eq!(
                ws.hotkey_capturing.as_deref(),
                Some("edit.toggle-heading"),
                "the frame kept the capture"
            );
        });
        workspace.update_in(cx, |ws, _, cx| ws.cancel_hotkey_capture(cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }

    /// The settings modal's wiring: ⌘, opens and closes it, each toggle applies
    /// live — auto-numbering renumbers the open note at once — and every value
    /// lands under the Tauri shell's `settings.*` keys.
    #[gpui::test]
    fn the_settings_modal_applies_and_persists_its_toggles(cx: &mut TestAppContext) {
        cx.update(|cx| gpui_kit::init(cx));
        // A private data dir: the persistence assertions read this file back.
        let data_dir =
            std::env::temp_dir().join(format!("bnote-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).expect("the test data dir");
        let (state, rx) = bnote_core::state::AppState::new(data_dir.clone());
        let mut bridges = None;
        cx.update(|cx| {
            bridges = Some((
                crate::editor::snippets_host::SnippetBridge::init(cx),
                crate::editor::vim::integration::VimBridge::init(cx),
            ));
        });
        let (snippet_bridge, vim_bridge) = bridges.expect("the bridges");
        let (workspace, cx) = cx.add_window_view(move |window, cx| {
            let ws = Workspace::new(
                state.clone(),
                rx.resubscribe(),
                None,
                vim_bridge,
                snippet_bridge,
                inert_ime(),
                inert_lsp(),
                window,
                cx,
            );
            let focus = ws.editor.focus_handle(cx);
            window.focus(&focus, cx);
            ws
        });

        let settings_of = |state: &std::sync::Arc<bnote_core::state::AppState>| -> serde_json::Value {
            bnote_core::commands::config::load_app_config(state)
                .ok()
                .and_then(|cfg| cfg.get("settings").cloned())
                .unwrap_or(serde_json::Value::Null)
        };

        cx.run_until_parked();
        cx.dispatch_action(actions::OpenSettings);
        workspace.read_with(cx, |ws, _| assert!(ws.settings_open, "⌘, opens the settings"));

        // 「开启时立即重排」: the open note gains its numbers on the next frame,
        // which the pending-pass mechanism runs from `render`.
        workspace.update_in(cx, |ws, window, cx| {
            ws.editor.update(cx, |st, cx| {
                st.set_value("## 一\n\n正文\n\n### 二\n", window, cx);
                st.set_selected_range(0..0, cx);
            });
            assert!(!ws.auto_number);
            ws.set_auto_number(true, cx);
            assert!(ws.renumber_pending, "turning it on schedules the pass");
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(
                ws.editor.read(cx).value(),
                "## 1 一\n\n正文\n\n### 1.1 二\n"
            );
        });

        // Each switch reaches its engine seam and its config key.
        workspace.update_in(cx, |ws, window, cx| {
            ws.set_typewriter(true, cx);
            ws.set_math_preview(false, cx);
            ws.set_snippets_enabled(false, cx);
            let _ = window;
        });
        workspace.read_with(cx, |ws, cx| {
            assert!(ws.editor.read(cx).centering_cursor(), "the engine took typewriter");
            assert!(!ws.math_preview);
            assert!(!ws.snippets_enabled);
        });
        let settings = workspace.read_with(cx, |ws, _| settings_of(&ws.state));
        assert_eq!(settings["autoNumberHeadings"], serde_json::json!(true));
        assert_eq!(settings["typewriter"], serde_json::json!(true));
        assert_eq!(settings["mathPreview"], serde_json::json!(false));
        assert_eq!(settings["snippets"], serde_json::json!(false));

        // Vim and the code-block language take the same path.
        workspace.update_in(cx, |ws, _window, cx| {
            ws.set_vim_setting(true, cx);
        });
        workspace.read_with(cx, |ws, _| assert!(ws.vim_enabled));
        let settings = workspace.read_with(cx, |ws, _| settings_of(&ws.state));
        assert_eq!(settings["vim"], serde_json::json!(true));

        // Change the language field the way typing does.
        workspace.update_in(cx, |ws, window, cx| {
            ws.lang_state
                .clone()
                .update(cx, |st, cx| st.set_value("python", window, cx));
            cx.notify();
        });
        // The subscription runs on the Change event of a user edit; the
        // programmatic write is silent, so drive the seam the way it does.
        workspace.update_in(cx, |ws, _window, cx| {
            ws.code_block_lang = "python".to_string();
            ws.persist_setting("codeBlockLang", serde_json::json!("python"), cx);
        });
        let settings = workspace.read_with(cx, |ws, _| settings_of(&ws.state));
        assert_eq!(settings["codeBlockLang"], serde_json::json!("python"));

        // ⌘, again closes it.
        cx.dispatch_action(actions::OpenSettings);
        workspace.read_with(cx, |ws, _| assert!(!ws.settings_open));
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// `settings.livePreview`: off means pure source — the render pass clears
    /// the decorations instead of scanning, and turning it back on rebuilds
    /// them. Measured against a paragraph line: while the heading's `# ` is
    /// hidden, its text starts at the same x as the paragraph's; in source
    /// mode the marker takes its real width and shifts the text right.
    #[gpui::test]
    fn the_live_preview_switch_owns_the_decorations(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        let doc = "# 标题\n\n正文\n\n尾\n";
        // 「标题」 right after the `# ` marker, and the paragraph「正文」 on
        // line 3 — a line no decoration ever touches, so it is the baseline.
        let heading_text = 2..8;
        let body_text = 10..16;
        let show = |cx: &mut gpui::VisualTestContext| {
            cx.update(|window, cx| window.draw(cx).clear(cx));
            workspace.read_with(cx, |ws, cx| {
                let editor = ws.editor.read(cx);
                let heading = editor
                    .range_to_bounds(&heading_text)
                    .expect("the heading is on screen");
                let body = editor
                    .range_to_bounds(&body_text)
                    .expect("the paragraph is on screen");
                (heading.origin.x, body.origin.x)
            })
        };
        workspace.update_in(cx, |ws, window, cx| {
            ws.editor.update(cx, |st, cx| {
                st.set_value(doc, window, cx);
                st.set_selected_range(doc.len()..doc.len(), cx);
            });
            ws.preview_dirty = true;
        });
        let (heading_x, body_x) = show(cx);
        assert_eq!(heading_x, body_x, "live preview on hid the `# ` marker");
        workspace.read_with(cx, |ws, cx| {
            assert!(
                !ws.preview_styles.get_ranges(cx).is_empty(),
                "the scan emitted the heading's text style"
            );
        });

        // Off: the frame drops both halves of the snapshot (no scan runs).
        workspace.update_in(cx, |ws, _, cx| ws.set_live_preview(false, cx));
        let (source_heading_x, source_body_x) = show(cx);
        assert!(
            source_heading_x > source_body_x,
            "source mode shows the marker: {source_heading_x} > {source_body_x}"
        );
        workspace.read_with(cx, |ws, cx| {
            assert!(ws.preview_styles.get_ranges(cx).is_empty(), "styles cleared");
        });
        // The marker is exactly two characters (`# `), so this is one
        // character cell of the editor's font.
        let char_w = (source_heading_x - source_body_x) / 2.0;

        // On again: one frame rebuilds the whole thing.
        workspace.update_in(cx, |ws, _, cx| ws.set_live_preview(true, cx));
        let (heading_x, body_x) = show(cx);
        assert_eq!(heading_x, body_x, "the marker is hidden again");

        // A document swapped in under source mode inherits nothing: the old
        // note's hidden byte ranges must not land on the new text. The new
        // marker is `## ` — three characters — where the old one was two, so
        // a stale snapshot would show up as the wrong shift.
        workspace.update_in(cx, |ws, _, cx| ws.set_live_preview(false, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let next = "## 换一篇\n\n正文\n\n尾\n";
        workspace.update_in(cx, |ws, window, cx| {
            ws.editor.update(cx, |st, cx| {
                st.set_value(next, window, cx);
                st.set_selected_range(next.len()..next.len(), cx);
            });
            ws.preview_dirty = true;
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |ws, cx| {
            let editor = ws.editor.read(cx);
            // 「换一篇」 and the paragraph「正文」 of the new document.
            let heading_x = editor
                .range_to_bounds(&(3..12))
                .expect("the new heading is on screen")
                .origin
                .x;
            let body_x = editor
                .range_to_bounds(&(14..20))
                .expect("the new paragraph is on screen")
                .origin
                .x;
            let delta = heading_x - body_x;
            assert!(
                (delta - 3.0 * char_w).abs() < char_w / 2.0,
                "the new note shows its own `## ` marker, not the old hiding: \
                 {delta} instead of {}",
                3.0 * char_w
            );
        });
    }

    /// `settings.autoSave`: the 0.8 s debounced write follows the switch —
    /// off means an edit only marks the note dirty; ⌘S writes regardless.
    #[gpui::test]
    fn the_autosave_switch_gates_only_the_debounced_write(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        let file = workspace.update_in(cx, |ws, window, cx| {
            let root = ws.vault_root.clone().expect("the fixture's vault");
            let path = root.join("note.md");
            std::fs::write(&path, "").expect("the note");
            ws.open_path = Some("note.md".to_string());
            ws.editor.update(cx, |st, cx| st.set_value("原始\n", window, cx));
            path
        });
        let body = || std::fs::read_to_string(&file).expect("the note bytes");

        // On (the default): the debounce timer fires once the clock passes it.
        workspace.update_in(cx, |ws, window, cx| {
            ws.editor.update(cx, |st, cx| st.insert("第一笔", window, cx));
        });
        workspace.read_with(cx, |ws, _| {
            assert!(ws.dirty, "the edit reached the change subscription");
        });
        cx.executor().advance_clock(AUTOSAVE_DEBOUNCE * 2);
        cx.run_until_parked();
        assert_eq!(body(), "第一笔原始\n", "the debounced write landed");
        workspace.read_with(cx, |ws, _| assert!(!ws.dirty, "and cleared the flag"));

        // Off: the same edit (the caret sits after the last insert) marks the
        // note dirty and schedules nothing.
        workspace.update_in(cx, |ws, window, cx| {
            ws.set_auto_save(false, cx);
            ws.editor.update(cx, |st, cx| st.insert("第二笔", window, cx));
        });
        cx.executor().advance_clock(AUTOSAVE_DEBOUNCE * 2);
        cx.run_until_parked();
        assert_eq!(body(), "第一笔原始\n", "no write while the switch is off");
        workspace.read_with(cx, |ws, _| assert!(ws.dirty, "the edit still marks dirty"));

        // A timer already scheduled when the switch flips off is dropped (TS
        // clears the pending timeout): the write waits for ⌘S.
        workspace.update_in(cx, |ws, window, cx| {
            ws.set_auto_save(true, cx);
            ws.editor.update(cx, |st, cx| st.insert("第三笔", window, cx));
            ws.set_auto_save(false, cx);
        });
        cx.executor().advance_clock(AUTOSAVE_DEBOUNCE * 2);
        cx.run_until_parked();
        assert_eq!(body(), "第一笔原始\n", "the pending autosave was invalidated");

        // Quitting writes the dirty buffer synchronously, switch or not (TS
        // `EditorPane`'s unmount flush).
        workspace.update(cx, |ws, cx| ws.flush_note_save_blocking(cx));
        assert_eq!(body(), "第一笔第二笔第三笔原始\n", "the quit flush wrote it");

        // ⌘S is unconditional too.
        cx.dispatch_action(actions::Save);
        cx.run_until_parked();
        assert_eq!(body(), "第一笔第二笔第三笔原始\n", "⌘S rewrites the same bytes");
        workspace.read_with(cx, |ws, _| assert!(!ws.dirty));
    }

    /// The run panel's state machine, `src/python/run.ts`'s semantics: a new
    /// run opens fresh, output chunks append in arrival order, the chunk cap
    /// drops the head (TS `MAX_LINES`/`TRIM_TO`), and the header's status text
    /// follows the exit.
    #[test]
    fn the_run_panel_state_follows_the_ts_store() {
        let mut run = PyRunState::default();
        assert!(!run.open, "a fresh state shows no panel");

        run.begin(Some(7), Some("/v/n.md".to_string()), "python3 x.py".to_string());
        assert!(run.open && run.running);
        assert_eq!(run.run_id, Some(7));

        // A second run resets everything the first one left behind.
        run.append(PyStream::Stdout, "old\n".to_string());
        run.finish(Some(1), 10, false, false);
        run.begin(Some(8), None, "python3 y.py".to_string());
        assert!(run.lines.is_empty() && run.exit_code.is_none() && run.duration_ms.is_none());

        for i in 0..PY_RUN_MAX_LINES + 1 {
            let trimmed = run.append(PyStream::Stdout, format!("{i}\n"));
            assert_eq!(trimmed, i == PY_RUN_MAX_LINES, "the cap trims exactly once");
        }
        assert_eq!(run.lines.len(), PY_RUN_TRIM_TO);
        assert_eq!(run.lines[0].text, format!("{}\n", PY_RUN_MAX_LINES + 1 - PY_RUN_TRIM_TO));

        // The status text/colour of every exit kind (TS's status span).
        run.finish(Some(0), 1234, false, false);
        assert_eq!(run.status(), ("成功".to_string(), PyStatus::Ok));
        run.finish(Some(2), 5, false, false);
        assert_eq!(run.status(), ("退出码 2".to_string(), PyStatus::Bad));
        run.finish(None, 5, true, false);
        assert_eq!(run.status(), ("已取消".to_string(), PyStatus::Bad));
        run.finish(None, 5, false, true);
        assert_eq!(run.status(), ("超时已终止".to_string(), PyStatus::Bad));
        run.running = true;
        assert_eq!(run.status(), ("运行中".to_string(), PyStatus::Running));
    }

    /// The event path: `python-run-output` / `python-run-exit` fill the panel
    /// through the same handler the poll loop calls, the body text and its
    /// highlight ranges stay aligned chunk by chunk, and a stale run's events
    /// are dropped (the run-id self-check).
    #[gpui::test]
    fn python_run_events_fill_the_panel_and_stale_ids_are_dropped(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);

        let output = |run_id: u64, stream: &str, text: &str| {
            bnote_core::AppEvent::new(
                "python-run-output",
                serde_json::json!({
                    "runId": run_id,
                    "mdPath": "/v/note.md",
                    "stream": stream,
                    "text": text,
                }),
            )
        };

        // Nothing running yet: an event is inert.
        workspace.update_in(cx, |ws, _, cx| {
            ws.handle_event(output(7, "stdout", "early\n"), cx)
        });
        workspace.read_with(cx, |ws, _| assert!(ws.python_run.lines.is_empty()));

        workspace.update_in(cx, |ws, _, cx| {
            ws.python_run.begin(Some(7), Some("/v/note.md".to_string()), "python3 x.py".to_string());
            ws.handle_event(output(7, "stdout", "hello\n"), cx);
            ws.handle_event(output(7, "stderr", "boom\n"), cx);
            // A different run's chunk never lands here.
            ws.handle_event(output(9, "stdout", "stale\n"), cx);
        });
        workspace.read_with(cx, |ws, _| {
            let lines: Vec<(&PyStream, &str)> = ws
                .python_run
                .lines
                .iter()
                .map(|l| (&l.stream, l.text.as_str()))
                .collect();
            assert_eq!(
                lines,
                [(&PyStream::Stdout, "hello\n"), (&PyStream::Stderr, "boom\n")],
                "matching chunks append in arrival order; the stale one is dropped"
            );
            assert_eq!(ws.py_body, "hello\nboom\n");
            let ranges: Vec<std::ops::Range<usize>> =
                ws.py_body_highlights.iter().map(|(r, _)| r.clone()).collect();
            assert_eq!(ranges, [0..6, 6..11], "one highlight range per chunk");
            assert!(ws.python_run.running);
        });

        // The exit finishes the run; a second one for a stale id changes nothing.
        workspace.update_in(cx, |ws, _, cx| {
            ws.handle_event(
                bnote_core::AppEvent::new(
                    "python-run-exit",
                    serde_json::json!({
                        "runId": 7,
                        "mdPath": "/v/note.md",
                        "exitCode": 0,
                        "durationMs": 1234,
                        "cancelled": false,
                        "timedOut": false,
                    }),
                ),
                cx,
            );
            ws.handle_event(
                bnote_core::AppEvent::new(
                    "python-run-exit",
                    serde_json::json!({
                        "runId": 9,
                        "mdPath": "/v/note.md",
                        "exitCode": 1,
                        "durationMs": 99,
                        "cancelled": false,
                        "timedOut": false,
                    }),
                ),
                cx,
            );
        });
        workspace.read_with(cx, |ws, _| {
            assert!(!ws.python_run.running);
            assert_eq!(ws.python_run.exit_code, Some(0));
            assert_eq!(ws.python_run.duration_ms, Some(1234));
            assert_eq!(ws.python_run.status(), ("成功".to_string(), PyStatus::Ok));
        });

        // The panel renders for real (the header, the highlighted body and the
        // scroll area): a frame here catches StyledText/scrollbar misuse.
        cx.update(|window, cx| window.draw(cx).clear(cx));

        // 清空 empties the body and the ranges together (the cached pair).
        workspace.update_in(cx, |ws, _, cx| {
            ws.python_run.lines.clear();
            ws.py_body.clear();
            ws.py_body_highlights.clear();
            cx.notify();
        });
        workspace.read_with(cx, |ws, _| {
            assert!(ws.py_body.is_empty() && ws.py_body_highlights.is_empty());
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }

    /// ⌘↩ on a note without a python fence runs nothing and says so; the ⌘↩
    /// keybinding itself is the registry's.
    #[gpui::test]
    fn running_a_note_without_fences_reports_and_wires_the_key(cx: &mut TestAppContext) {
        let action = action_for("python.run-note").expect("the registry id maps to the action");
        assert!(
            action.partial_eq(&actions::PythonRunNote),
            "python.run-note is the run action"
        );
        assert!(
            action_for("python.run-stop").is_some_and(|a| a.partial_eq(&actions::PythonRunStop)),
            "python.run-stop is the stop action"
        );
        assert!(
            keybinding_for("python.run-note", "cmd-enter").is_some(),
            "⌘↩ binds to the run action"
        );
        assert!(
            COMMANDS.iter().any(|def| def.id == "python.run-note" && def.key == Some("cmd-enter")),
            "and the palette row carries the default"
        );
        assert!(
            COMMANDS.iter().any(|def| def.id == "python.run-stop" && def.key.is_none()),
            "stop is palette-only, like the TS registry"
        );

        let (workspace, cx) = python_panel_fixture(cx);
        workspace.update_in(cx, |ws, window, cx| {
            ws.open_path = Some("note.md".to_string());
            ws.editor.update(cx, |st, cx| st.set_value("没有围栏的正文\n", window, cx));
            ws.run_python_note(&actions::PythonRunNote, window, cx);
        });
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.status, "这篇笔记没有 python 代码块(```python 围栏)");
            assert!(!ws.python_run.open, "no panel without a run");
        });

        // No note open either: its own message.
        workspace.update_in(cx, |ws, window, cx| {
            ws.open_path = None;
            ws.run_python_note(&actions::PythonRunNote, window, cx);
        });
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.status, "没有打开的笔记");
        });
    }

    /// A workspace with a vault-less state and inert seams, for the panel
    /// tests (the run itself is the core's; these cover the shell wiring).
    ///
    /// Each call gets its own data dir and vault: the tests run in parallel
    /// threads, so a shared pair would let one test's wipe or write land
    /// inside another's (the vault is reloaded from disk by construction).
    fn python_panel_fixture(
        cx: &mut TestAppContext,
    ) -> (gpui::Entity<Workspace>, &mut gpui::VisualTestContext) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static FIXTURE_SEQ: AtomicUsize = AtomicUsize::new(0);
        cx.update(|cx| gpui_kit::init(cx));
        let tag = format!(
            "{}-{}",
            std::process::id(),
            FIXTURE_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let data_dir = std::env::temp_dir().join(format!("bnote-py-panel-{tag}"));
        let vault = std::env::temp_dir().join(format!("bnote-py-vault-{tag}"));
        let _ = std::fs::remove_dir_all(&data_dir);
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&data_dir).expect("the data dir");
        std::fs::create_dir_all(&vault).expect("the vault dir");
        let (state, rx) = bnote_core::state::AppState::new(data_dir);
        let mut bridges = None;
        cx.update(|cx| {
            bridges = Some((
                crate::editor::snippets_host::SnippetBridge::init(cx),
                crate::editor::vim::integration::VimBridge::init(cx),
            ));
        });
        let (snippet_bridge, vim_bridge) = bridges.expect("the bridges");
        let (workspace, cx) = cx.add_window_view(move |window, cx| {
            let ws = Workspace::new(
                state.clone(),
                rx.resubscribe(),
                Some(vault),
                vim_bridge,
                snippet_bridge,
                inert_ime(),
                inert_lsp(),
                window,
                cx,
            );
            let focus = ws.editor.focus_handle(cx);
            window.focus(&focus, cx);
            ws
        });
        cx.run_until_parked();
        (workspace, cx)
    }

    /// TS `StudyLayout.normalizeSplit`: a hand-edited config cannot squeeze a
    /// pane out of existence.
    #[test]
    fn the_study_split_clamps_like_the_ts() {
        assert_eq!(normalize_split([0.24, 0.44]), [0.24, 0.44]);
        assert_eq!(normalize_split([-1.0, 2.0]), [0.05, 0.90]);
        let tight = normalize_split([0.90, 0.90]);
        assert_eq!(tight[0], 0.90);
        assert!(
            (tight[1] - 0.05).abs() < 1e-5,
            "the content pane keeps room beside a 90% agent pane: {tight:?}"
        );
        assert_eq!(normalize_split([0.0, 0.0]), [0.05, 0.05]);
    }

    /// ⌘⇧S keeps the note (the notes pane is the same editor), shows the empty
    /// study pane, and the split persists through the panes' resize state.
    #[gpui::test]
    fn the_study_mode_toggles_keeps_the_note_and_persists_the_split(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        let doc = "# 笔记\n\n正文\n";
        let abs = workspace.update_in(cx, |ws, window, cx| {
            // A real note on disk, so ⌘⇧S has something to keep.
            let root = ws.vault_root.clone().expect("the fixture's vault");
            std::fs::write(root.join("note.md"), doc).expect("the note");
            ws.open_path = Some("note.md".to_string());
            ws.editor.update(cx, |st, cx| st.set_value(doc, window, cx));
            ws.py_lsp_set_path(cx);
            ws.open_note_abs().expect("the note's path")
        });
        let _ = abs;

        assert!(COMMANDS.iter().any(|def| {
            def.id == "view.toggle-study-mode" && def.key == Some("cmd-shift-s")
        }));
        assert!(action_for("view.toggle-study-mode")
            .is_some_and(|a| a.partial_eq(&actions::ToggleStudyMode)));

        cx.dispatch_action(actions::ToggleStudyMode);
        workspace.read_with(cx, |ws, cx| {
            assert!(ws.study_mode, "⌘⇧S enters study mode");
            assert_eq!(
                ws.editor.read(cx).value(),
                doc,
                "the notes pane is the same editor: the note survives"
            );
            assert!(ws.study_content.is_none(), "the middle pane starts empty");
            assert!(ws.study_session_for.is_none(), "no study content for the session yet");
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));

        // The panes' drag release (the kit emits Resized) persists fractions.
        workspace.update_in(cx, |ws, window, cx| {
            ws.study_resize.update(cx, |state, cx| {
                state.resize_panel(0, px(400.), window, cx);
            });
        });
        cx.run_until_parked();
        let persisted = workspace.read_with(cx, |ws, _| {
            let cfg = load_config_value(&ws.state);
            cfg.get("settings")
                .and_then(|s| s.get("studySplit"))
                .cloned()
                .expect("studySplit persisted")
        });
        let arr = persisted.as_array().expect("an array");
        assert_eq!(arr.len(), 2);
        assert!(
            workspace.read_with(cx, |ws, _| ws.study_split[0]) > 0.05,
            "the drag moved the first pane: {:?}",
            arr
        );

        cx.dispatch_action(actions::ToggleStudyMode);
        workspace.read_with(cx, |ws, cx| {
            assert!(!ws.study_mode);
            assert_eq!(ws.editor.read(cx).value(), doc, "and back out again");
        });
    }

    /// The middle pane loads a study note from the vault (the shape a
    /// converted PDF takes: a markdown file with figures beside it) and hands
    /// it to the agent session.
    #[gpui::test]
    fn the_study_pane_loads_a_note_and_grounds_the_agent(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        let study_rel = "pdfs/paper.md";
        let body = "# Paper\n\n![fig](assets/paper/f1.png)\n\n$$x^2$$\n";
        let abs = workspace.update_in(cx, |ws, _, _| {
            let root = ws.vault_root.clone().expect("the fixture's vault");
            std::fs::create_dir_all(root.join("pdfs")).expect("the pdfs folder");
            std::fs::write(root.join(study_rel), body).expect("the study note");
            root.join(study_rel).to_string_lossy().to_string()
        });

        // Study mode on, so the middle pane is really laid out (its editor
        // gets bounds and visible rows).
        cx.dispatch_action(actions::ToggleStudyMode);
        cx.update(|window, cx| window.draw(cx).clear(cx));

        workspace.update_in(cx, |ws, _, cx| ws.load_study_markdown(abs, "Paper".to_string(), cx));
        cx.run_until_parked();
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(
                ws.study_editor.read(cx).value(),
                body,
                "the middle pane shows the study note"
            );
            match &ws.study_content {
                Some(StudyContent::Markdown { path, title }) => {
                    assert!(path.ends_with("pdfs/paper.md"));
                    assert_eq!(title, "Paper");
                }
                other => panic!("expected markdown content, got {other:?}"),
            }
            assert!(
                ws.study_session_for
                    .as_deref()
                    .is_some_and(|key| key.starts_with("md:")),
                "the agent session is grounded in the note: {:?}",
                ws.study_session_for
            );
        });

        // The pane renders (the editor + the toolbar) without panicking, and
        // the frame scans it: the dirty flag is consumed and the visible rows
        // are recorded.
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |ws, _| {
            assert!(!ws.study_dirty, "the frame's scan consumed the flag");
            assert!(ws.study_rows.is_some(), "and it ran for the new document");
        });

        // ✕ closes the content and un-grounds the session.
        workspace.update_in(cx, |ws, window, cx| ws.close_study_content(window, cx));
        workspace.read_with(cx, |ws, cx| {
            assert!(ws.study_content.is_none());
            assert_eq!(ws.study_editor.read(cx).value(), "");
            assert!(ws.study_session_for.is_none());
        });
    }

    /// A dropped markdown opens in the pane (and turns study mode on); a
    /// dropped file of neither kind is reported.
    #[gpui::test]
    fn a_dropped_file_opens_in_the_study_pane(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        let body = "# Dropped\n\n正文\n";
        let md = workspace.update_in(cx, |ws, _, _| {
            let root = ws.vault_root.clone().expect("the fixture's vault");
            std::fs::write(root.join("dropped.md"), body).expect("the dropped note");
            root.join("dropped.md")
        });

        workspace.update_in(cx, |ws, window, cx| {
            ws.on_study_drop(vec![md], window, cx)
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, cx| {
            assert!(ws.study_mode, "a drop enters study mode");
            assert_eq!(ws.study_editor.read(cx).value(), body);
            match &ws.study_content {
                Some(StudyContent::Markdown { title, .. }) => assert_eq!(title, "dropped"),
                other => panic!("expected markdown content, got {other:?}"),
            }
        });

        workspace.update_in(cx, |ws, window, cx| {
            ws.on_study_drop(vec![PathBuf::from("/tmp/photo.png")], window, cx)
        });
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.status, "请拖入 PDF 或 Markdown 文件");
        });
    }

    /// The ty diagnostics event lands on the editor's own diagnostic set (the
    /// kit paints the squiggle and the popover from it), and a different
    /// note's event is dropped.
    #[gpui::test]
    fn python_lsp_diagnostics_reach_the_editor(cx: &mut TestAppContext) {
        let (workspace, cx) = python_panel_fixture(cx);
        let doc = "# 标题\n```python\nx: int = \"s\"\n```\n";
        let abs = workspace.update_in(cx, |ws, window, cx| {
            ws.open_path = Some("note.md".to_string());
            ws.editor.update(cx, |st, cx| st.set_value(doc, window, cx));
            ws.py_lsp_set_path(cx);
            ws.open_note_abs().expect("the note's path")
        });

        let event = |path: &str| {
            bnote_core::AppEvent::new(
                "python-lsp-diagnostics",
                serde_json::json!({
                    "mdPath": path,
                    "diagnostics": [{
                        "range": {
                            "start": { "line": 2, "character": 0 },
                            "end": { "line": 2, "character": 6 },
                        },
                        "severity": 1,
                        "message": "boom",
                    }],
                }),
            )
        };

        // Another note's diagnostics never land here.
        workspace.update_in(cx, |ws, _, cx| {
            ws.handle_event(event("/elsewhere/other.md"), cx)
        });
        workspace.read_with(cx, |ws, cx| {
            let set = ws.editor.read(cx).diagnostics().expect("a code editor");
            assert_eq!(set.len(), 0, "another note's event is dropped");
        });

        workspace.update_in(cx, |ws, _, cx| ws.handle_event(event(&abs), cx));
        workspace.read_with(cx, |ws, cx| {
            let state = ws.editor.read(cx);
            let set = state.diagnostics().expect("a code editor");
            assert_eq!(set.len(), 1);
            // `x: int` sits at bytes 19..25 of the document (line 2, cols 0..6).
            let entry = set.for_offset(20).expect("the diagnostic sits on the code line");
            assert_eq!(entry.range, 19..25, "the `x: int` span maps back to the document");
            assert_eq!(entry.diagnostic.message.as_ref(), "boom");
            assert_eq!(entry.diagnostic.severity, bc_diag::DiagnosticSeverity::Error);
            assert_eq!(entry.diagnostic.source.as_deref(), Some("ty"));
        });

        // A second event replaces the set (reset + push, no accumulation).
        workspace.update_in(cx, |ws, _, cx| {
            ws.handle_event(
                bnote_core::AppEvent::new(
                    "python-lsp-diagnostics",
                    serde_json::json!({ "mdPath": abs, "diagnostics": [] }),
                ),
                cx,
            )
        });
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(ws.editor.read(cx).diagnostics().expect("a code editor").len(), 0);
        });
    }

    /// The source list behind the IME tab is a platform call (a TIS
    /// enumeration). Opening the settings modal must not fire it — only showing
    /// the IME tab does, and only once per session (the unfiltered version of
    /// this test cost every workspace test seconds: the core entry parks on its
    /// main-queue hop in a test process, see `ImeServices`).
    #[gpui::test]
    fn the_ime_sources_load_with_the_ime_tab_not_with_the_modal(cx: &mut TestAppContext) {
        cx.update(|cx| gpui_kit::init(cx));
        let data_dir = std::env::temp_dir().join(format!("bnote-ime-tab-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).expect("the test data dir");
        let (state, rx) = bnote_core::state::AppState::new(data_dir.clone());

        let calls = Rc::new(std::cell::Cell::new(0usize));
        let counted = calls.clone();
        let switch: Switcher = Rc::new(|_, _, _| Task::ready(()));
        let current: CurrentSource = Rc::new(|_| Task::ready(None));
        let list: crate::ime_host::SourceList = Rc::new(move |_| {
            counted.set(counted.get() + 1);
            Task::ready(vec![bnote_core::commands::ime::InputSourceInfo {
                id: "input.abc".to_string(),
                name: "ABC".to_string(),
                is_cjk: false,
            }])
        });
        let services = ImeServices { switch, current, list };

        let mut bridges = None;
        cx.update(|cx| {
            bridges = Some((
                crate::editor::snippets_host::SnippetBridge::init(cx),
                crate::editor::vim::integration::VimBridge::init(cx),
            ));
        });
        let (snippet_bridge, vim_bridge) = bridges.expect("the bridges");
        let (workspace, cx) = cx.add_window_view(move |window, cx| {
            Workspace::new(
                state.clone(),
                rx.resubscribe(),
                None,
                vim_bridge,
                snippet_bridge,
                services,
                inert_lsp(),
                window,
                cx,
            )
        });
        cx.run_until_parked();
        // The feature is on by default, so construction prewarms once (TS
        // `imeWarmUp`) — that call is what the *first switch* would otherwise pay.
        let warm = calls.get();
        assert_eq!(warm, 1, "startup prewarms the enumeration once");

        cx.dispatch_action(actions::OpenSettings);
        cx.run_until_parked();
        assert_eq!(calls.get(), warm, "the modal alone enumerates nothing");

        workspace.update_in(cx, |ws, window, cx| {
            let _ = window;
            ws.set_settings_tab(SettingsTab::Ime, cx);
        });
        cx.run_until_parked();
        assert_eq!(calls.get(), warm + 1, "the IME tab pulls the list in");
        assert_eq!(
            workspace.read_with(cx, |ws, _| ws.ime_sources.len()),
            1,
            "and the landed list is kept"
        );

        // Coming back to the tab and opening a picker reuse the session's list.
        workspace.update_in(cx, |ws, _, cx| {
            ws.set_settings_tab(SettingsTab::General, cx);
            ws.set_settings_tab(SettingsTab::Ime, cx);
            ws.open_ime_picker(ImePickField::Insert, cx);
        });
        cx.run_until_parked();
        assert_eq!(calls.get(), warm + 1, "one fetch per session");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Quick add end to end on a real vault: ⌘⇧A lists `settings.quickAdd`,
    /// the pick hands over to naming, and Enter creates the note in the
    /// command's folder — the folder chain included — then opens it.
    #[gpui::test]
    fn quick_add_creates_the_named_note_in_the_commands_folder(cx: &mut TestAppContext) {
        cx.update(|cx| gpui_kit::init(cx));
        let tag = std::process::id();
        let root = std::env::temp_dir().join(format!("bnote-quickadd-vault-{tag}"));
        let data_dir = std::env::temp_dir().join(format!("bnote-quickadd-data-{tag}"));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&root).expect("the vault");
        std::fs::create_dir_all(&data_dir).expect("the data dir");
        // The command list comes from config.json — the settings tab's writer.
        std::fs::write(
            data_dir.join("config.json"),
            serde_json::json!({
                "settings": { "quickAdd": [{ "name": "add bnote file", "folder": "bnote/收集箱" }] }
            })
            .to_string(),
        )
        .expect("the config");
        let canonical = std::fs::canonicalize(&root).expect("canonical vault");

        let (state, rx) = bnote_core::state::AppState::new(data_dir.clone());
        let mut bridges = None;
        cx.update(|cx| {
            bridges = Some((
                crate::editor::snippets_host::SnippetBridge::init(cx),
                crate::editor::vim::integration::VimBridge::init(cx),
            ));
        });
        let (snippet_bridge, vim_bridge) = bridges.expect("the bridges");
        let vault = root.clone();
        let (workspace, cx) = cx.add_window_view(move |window, cx| {
            let ws = Workspace::new(
                state.clone(),
                rx.resubscribe(),
                Some(vault),
                vim_bridge,
                snippet_bridge,
                inert_ime(),
                inert_lsp(),
                window,
                cx,
            );
            let focus = ws.editor.focus_handle(cx);
            window.focus(&focus, cx);
            ws
        });
        // The vault restore (and its tree load) run off the UI thread.
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.vault_root.as_deref(), Some(canonical.as_path()));
        });

        cx.dispatch_action(actions::QuickAdd);
        workspace.read_with(cx, |ws, _| {
            assert!(ws.qa_open && !ws.qa_naming, "⌘⇧A opens the pick stage");
            assert_eq!(ws.qa_commands.len(), 1, "the list came from config.json");
        });
        cx.dispatch_action(actions::QuickAdd);
        workspace.read_with(cx, |ws, _| assert!(!ws.qa_open, "⌘⇧A again puts it away"));

        // The create flow runs through the same handlers the action calls:
        // after the async work below, this harness stops routing dispatched
        // actions (the app's own keystrokes do not go through that path).
        workspace.update_in(cx, |ws, window, cx| {
            ws.quick_add(&actions::QuickAdd, window, cx);
            assert!(ws.qa_open);
            ws.qa_pick(0, window, cx);
            assert!(ws.qa_naming, "the pick hands over to naming");
            ws.qa_name_state
                .clone()
                .update(cx, |st, cx| st.set_value("想法.md", window, cx));
            ws.qa_create(cx);
            assert!(!ws.qa_open, "creating closes the modal");
        });
        cx.run_until_parked();

        // The folder chain is created and the file — extension stripped, then
        // re-added — lands inside it.
        let created = canonical.join("bnote/收集箱/想法.md");
        assert!(created.is_file(), "missing {created:?}");
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.open_path.as_deref(), Some("bnote/收集箱/想法.md"));
        });

        // The pick stage's rows are the settings modal's writer: removing the
        // command writes the shortened list back.
        workspace.update_in(cx, |ws, window, cx| {
            ws.open_settings_modal(window, cx);
            assert_eq!(ws.qa_rows.len(), 1, "the saved command became a row");
            let id = ws.qa_rows[0].id;
            ws.qa_remove_row(id, cx);
            assert!(ws.qa_rows.is_empty());
        });
        let cfg = workspace.read_with(cx, |ws, _| {
            bnote_core::commands::config::load_app_config(&ws.state)
        })
        .expect("the config reads");
        assert_eq!(cfg["settings"]["quickAdd"], serde_json::json!([]));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// The welcome / empty-state gates and the native folder picker: no vault
    /// shows the welcome screen (and no sidebar), picking a folder switches to
    /// it, and with a vault but no note the editor's empty state shows.
    #[gpui::test]
    fn the_welcome_state_gates_on_the_vault_and_the_picker_switches(cx: &mut TestAppContext) {
        cx.update(|cx| gpui_kit::init(cx));
        let tag = std::process::id();
        let vault = std::env::temp_dir().join(format!("bnote-welcome-vault-{tag}"));
        let data_dir = std::env::temp_dir().join(format!("bnote-welcome-data-{tag}"));
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&vault).expect("the vault");
        std::fs::create_dir_all(&data_dir).expect("the data dir");
        let canonical = std::fs::canonicalize(&vault).expect("canonical vault");

        let (state, rx) = bnote_core::state::AppState::new(data_dir.clone());
        let mut bridges = None;
        cx.update(|cx| {
            bridges = Some((
                crate::editor::snippets_host::SnippetBridge::init(cx),
                crate::editor::vim::integration::VimBridge::init(cx),
            ));
        });
        let (snippet_bridge, vim_bridge) = bridges.expect("the bridges");
        let (workspace, cx) = cx.add_window_view(move |window, cx| {
            // No `last_vault`: the first-run state.
            let ws = Workspace::new(
                state.clone(),
                rx.resubscribe(),
                None,
                vim_bridge,
                snippet_bridge,
                inert_ime(),
                inert_lsp(),
                window,
                cx,
            );
            let focus = ws.editor.focus_handle(cx);
            window.focus(&focus, cx);
            ws
        });

        workspace.read_with(cx, |ws, _| {
            assert!(ws.vault_root.is_none());
            assert!(ws.render_welcome_needed(), "no vault: the welcome shows");
            assert!(!ws.editor_empty_needed(), "no vault: not the empty state");
        });

        // The welcome button's picker hands the chosen folder to `switch_vault`
        // (the same path ⌘⇧R's entries take). The folder dialog itself is
        // platform behavior — the test platform's prompt answer is not
        // reachable from a visual context — so the switch is driven directly.
        workspace.update_in(cx, |ws, _window, cx| {
            ws.switch_vault(vault.to_string_lossy().to_string(), cx);
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.vault_root.as_deref(), Some(canonical.as_path()));
            assert!(!ws.render_welcome_needed(), "a vault: no welcome");
            assert!(ws.editor_empty_needed(), "a vault, no note: the empty state");
        });

        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// The tree menu's rename end to end on a real vault: the dialog opens with
    /// the current name, commit renames on disk (keeping the extension a bare
    /// name would drop) and the open note follows to its new path.
    #[gpui::test]
    fn the_tree_menu_renames_on_disk_and_follows_the_open_note(cx: &mut TestAppContext) {
        cx.update(|cx| gpui_kit::init(cx));
        let tag = std::process::id();
        let vault = std::env::temp_dir().join(format!("bnote-rename-vault-{tag}"));
        let data_dir = std::env::temp_dir().join(format!("bnote-rename-data-{tag}"));
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&vault).expect("the vault");
        std::fs::create_dir_all(&data_dir).expect("the data dir");
        std::fs::write(vault.join("想法.md"), "正文").expect("the note");
        let canonical = std::fs::canonicalize(&vault).expect("canonical vault");

        let (state, rx) = bnote_core::state::AppState::new(data_dir.clone());
        let mut bridges = None;
        cx.update(|cx| {
            bridges = Some((
                crate::editor::snippets_host::SnippetBridge::init(cx),
                crate::editor::vim::integration::VimBridge::init(cx),
            ));
        });
        let (snippet_bridge, vim_bridge) = bridges.expect("the bridges");
        let vault_for_ws = vault.clone();
        let (workspace, cx) = cx.add_window_view(move |window, cx| {
            let ws = Workspace::new(
                state.clone(),
                rx.resubscribe(),
                Some(vault_for_ws),
                vim_bridge,
                snippet_bridge,
                inert_ime(),
                inert_lsp(),
                window,
                cx,
            );
            let focus = ws.editor.focus_handle(cx);
            window.focus(&focus, cx);
            ws
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.vault_root.as_deref(), Some(canonical.as_path()));
        });

        workspace.update_in(cx, |ws, window, cx| {
            ws.open_note("想法.md".to_string(), window, cx);
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(ws.open_path.as_deref(), Some("想法.md"));
            assert_eq!(ws.editor.read(cx).value(), "正文");
        });

        // 「重命名」 opens the dialog with the current name; committing a bare
        // name keeps the .md extension (TS `renameEntry`).
        workspace.update_in(cx, |ws, window, cx| {
            ws.open_tree_menu("想法.md".to_string(), false, gpui::Point::default(), cx);
            assert!(ws.tree_menu.is_some());
            ws.tree_menu_pick(TreeMenuItem::Rename, window, cx);
            assert!(ws.rename_prompt.is_some());
            assert_eq!(ws.rename_state.read(cx).value(), "想法.md");
            assert_eq!(ws.rename_state.read(cx).value(), "想法.md");
            ws.rename_state
                .clone()
                .update(cx, |st, cx| st.set_value("灵感", window, cx));
            ws.commit_rename(cx);
            assert!(ws.rename_prompt.is_none());
        });
        cx.run_until_parked();

        assert!(!canonical.join("想法.md").exists(), "the old name is gone");
        assert!(canonical.join("灵感.md").is_file(), "the new name is on disk");
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.open_path.as_deref(), Some("灵感.md"), "the open note followed");
        });

        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // ---- batch: shell feel (watcher echo, ⌘⇧O toggle, ⌘⇧R, toast) ------

    /// TS `App.tsx`'s self-write echo: a watcher event carrying the open
    /// note's *identical* bytes must not reinstall the text — the caret
    /// stays put and live vim/snippet sessions survive. Changed bytes still
    /// reload.
    #[gpui::test]
    fn the_watcher_echo_of_our_own_write_is_ignored(cx: &mut TestAppContext) {
        let (workspace, fixture, cx) = crate::harness::note_fixture(cx, true);
        workspace.update_in(cx, |ws, window, cx| {
            ws.debug_set_doc("# 标题\n\n正文待编辑\n", window, cx);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        // A live vim session through the real keystroke path.
        let w = crate::harness::window(cx);
        crate::harness::press(cx, w, "i");
        workspace.read_with(cx, |ws, _| {
            assert_eq!(
                ws.vim_bridge.mode_of(&ws.editor),
                Some(crate::editor::vim::core::Mode::Insert),
                "the fixture starts the session"
            );
        });

        // The same bytes on disk (what an autosave round-trip produces).
        fixture.write("note.md", "# 标题\n\n正文待编辑\n");
        let rel = "note.md".to_string();
        workspace.update(cx, |ws, cx| {
            ws.reload_open_if_externally_changed(&[rel.clone()], cx);
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert_eq!(
                ws.vim_bridge.mode_of(&ws.editor),
                Some(crate::editor::vim::core::Mode::Insert),
                "the identical echo keeps the live session"
            );
        });

        // Different bytes on disk: a real external edit reloads (leaving
        // insert through the reinstall, which resets vim).
        fixture.write("note.md", "# 标题\n\n外部改动\n");
        workspace.update(cx, |ws, cx| {
            ws.reload_open_if_externally_changed(&[rel], cx);
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(
                ws.editor.read(cx).value(),
                "# 标题\n\n外部改动\n",
                "a real external change lands"
            );
        });
    }

    /// Bulk text replacement is the editor's silent door (`set_value` emits
    /// no `InputEvent::Change`, see gpui-kit `state.rs`), so preview
    /// invalidation cannot ride the event channel for it — opening a note
    /// must still land its live preview with no keystroke or cursor move in
    /// between. The regression this pins: before `replace_buffer`
    /// consolidated the replacement sites, the frame after `install_text`
    /// kept the loading state's empty snapshot until the first edit.
    #[gpui::test]
    fn a_bulk_load_refreshes_the_preview_without_an_edit(cx: &mut TestAppContext) {
        use gpui_kit::component::input::PreviewSpan;
        let (workspace, _fixture, cx) = crate::harness::note_fixture(cx, false);
        let text = "# 标题\n\n一段 **加粗文字** 与 *斜体*。\n";
        workspace.update_in(cx, |ws, window, cx| {
            ws.install_text("note.md".to_string(), text.to_string(), window, cx);
            // What the frame after the load runs — nothing else happened.
            ws.refresh_preview(window, cx);
            let spans = ws
                .harness_editor()
                .read(cx)
                .preview_decorations()
                .spans
                .clone();
            assert_eq!(
                spans,
                vec![
                    PreviewSpan::hidden(17..19),
                    PreviewSpan::hidden(31..33),
                    PreviewSpan::hidden(38..39),
                    PreviewSpan::hidden(45..46),
                ],
                "the load's own frame hides line 3's markers; the caret at 0 keeps `#`"
            );
        });
    }

    /// TS `openDailyNote`'s toggle: ⌘⇧O from a note remembers the source,
    /// ⌘⇧O inside the daily jumps back, one more ⌘⇧O reports nothing to
    /// jump to.
    #[gpui::test]
    fn the_daily_toggle_round_trips_through_the_back_slot(cx: &mut TestAppContext) {
        let (workspace, _fixture, cx) = crate::harness::note_fixture(cx, true);
        // note.md is open (the fixture), so the first ⌘⇧O remembers it.
        workspace.update_in(cx, |ws, window, cx| {
            ws.open_daily(&actions::OpenDaily, window, cx);
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert_eq!(
                ws.daily_back_from.as_deref(),
                Some("note.md"),
                "the source note is remembered"
            );
            assert!(
                ws.open_path
                    .as_deref()
                    .is_some_and(|p| p.starts_with("Daily/")),
                "today's daily is open: {:?}",
                ws.open_path
            );
        });

        // Inside the daily: the jump back.
        workspace.update_in(cx, |ws, window, cx| {
            ws.open_daily(&actions::OpenDaily, window, cx);
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.open_path.as_deref(), Some("note.md"), "jumped back");
            assert!(ws.daily_back_from.is_none(), "the slot is consumed");
        });

        // Inside a daily with an empty slot (e.g. the source was deleted):
        // the report, not a silent no-op.
        workspace.update_in(cx, |ws, window, cx| {
            ws.open_daily(&actions::OpenDaily, window, cx);
        });
        cx.run_until_parked();
        workspace.update_in(cx, |ws, window, cx| {
            ws.daily_back_from = None;
            ws.open_daily(&actions::OpenDaily, window, cx);
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert!(
                ws.open_path
                    .as_deref()
                    .is_some_and(|p| p.starts_with("Daily/")),
                "still inside the daily"
            );
            assert_eq!(ws.status, "没有可跳回的文件");
            assert!(ws.toast.is_some(), "the missing back slot toasts");
        });
    }


    /// The daily-link marks reach the engine's lines table through a real
    /// snapshot: a todo whose link targets **today's** daily gets a filled pip
    /// on the source side, and a pip plus the source label on the daily side;
    /// an unlinked todo stays clean. The predicates are core's
    /// (`daily::marks`); this pins the shell wiring — store read, path
    /// conventions (absolute links vs the shell's canonical root), and the
    /// push into the host.
    #[gpui::test]
    fn the_daily_link_marks_reach_the_engine_lines_table(cx: &mut TestAppContext) {
        let today = super::today_string();
        let (workspace, fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            // The shell canonicalizes the vault on open (`set_vault`), and
            // links store absolute paths: write them against the same root.
            let root = std::fs::canonicalize(&fixture.vault)
                .expect("a canonical vault")
                .to_string_lossy()
                .to_string();
            let links = serde_json::json!({
                "version": 1,
                "links": [{
                    "id": "l1",
                    "kind": "copied",
                    "day": today,
                    "srcPath": format!("{root}/Job/job todo.md"),
                    "dailyPath": format!("{root}/Daily/{today}.md"),
                    "text": "cs336",
                    "srcLine": 1,
                    "dailyLine": 3,
                }],
            });
            fixture.write(".bnote/daily-links.json", &links.to_string());
            fixture.write("Job/job todo.md", "- [ ] cs336\n- [ ] 没人链接的\n");
            fixture.write(&format!("Daily/{today}.md"), &format!("# {today}\n\n- [ ] cs336\n"));
            vec!["Job/job todo.md".to_string()]
        });
        cx.run_until_parked();

        // Source side: the linked todo line carries the solid pip, the
        // unlinked one stays clean, and no label is drawn.
        workspace.update_in(cx, |ws, window, cx| {
            ws.refresh_preview(window, cx);
            let lines = ws.harness_editor().read(cx).preview_decorations().lines.clone();
            let pip_line = |line: u64| {
                lines.iter().find(|style| style.line == line).and_then(|style| style.pip)
            };
            let pip = pip_line(0).expect("the linked todo is marked");
            assert!(pip.stroke <= px(0.), "the synced pip is solid");
            assert!(pip_line(1).is_none(), "the unlinked todo stays clean");
            assert!(
                lines.iter().all(|style| style.trailing.is_none()),
                "the source side carries no label"
            );
        });

        // Daily side: the synced entry is marked and labeled with the source.
        workspace.update_in(cx, |ws, window, cx| {
            let text = format!("# {today}\n\n- [ ] cs336\n");
            ws.load_note_text(&format!("Daily/{today}.md"), &text, window, cx);
            ws.refresh_preview(window, cx);
            let lines = ws.harness_editor().read(cx).preview_decorations().lines.clone();
            let style = lines
                .iter()
                .find(|style| style.line == 2)
                .expect("the synced entry's line is marked");
            assert!(style.pip.is_some(), "the daily side shows the pip");
            let label = style.trailing.as_ref().expect("and the source label");
            assert_eq!(label.text.as_ref(), "⇄ job todo");
        });

        let _ = std::fs::remove_dir_all(&fixture.vault);
        let _ = std::fs::remove_dir_all(&fixture.data_dir);
    }

    /// The footprint ring sits on the first line of every block today's
    /// footprint recorded from the open file — a *ring*, so it reads as its
    /// own family next to the solid daily-sync pip.
    #[gpui::test]
    fn the_footprint_ring_marks_recorded_block_starts(cx: &mut TestAppContext) {
        let (workspace, fixture, cx) = crate::harness::note_fixture(cx, false);
        let root = std::fs::canonicalize(&fixture.vault)
            .expect("a canonical vault")
            .to_string_lossy()
            .to_string();
        workspace.update_in(cx, |ws, window, cx| {
            let host = ws.footprint.clone().expect("the footprint host");
            let mut index = std::collections::BTreeMap::new();
            index.insert(
                format!("{root}/note.md"),
                vec![bnote_core::footprint::model::FootprintBlock {
                    text: "第二行".into(),
                    start: 2,
                    end: 2,
                }],
            );
            host.install_index_for_test(index);
            ws.load_note_text("note.md", "第一行\n第二行\n第三行\n", window, cx);
            ws.refresh_preview(window, cx);
            let lines = ws.harness_editor().read(cx).preview_decorations().lines.clone();
            let style = lines
                .iter()
                .find(|style| style.line == 1)
                .expect("the recorded block's first line is marked");
            let pip = style.pip.expect("a pip");
            assert!(pip.stroke > px(0.), "the footprint pip is a ring");
            assert!(
                lines
                    .iter()
                    .filter(|style| style.pip.is_some())
                    .count()
                    == 1,
                "only the block's first line is marked"
            );
        });
        let _ = std::fs::remove_dir_all(&fixture.vault);
        let _ = std::fs::remove_dir_all(&fixture.data_dir);
    }

    /// The zone only exists for a daily with footprints; its interactions
    /// route through the real dispatch path (the actions travel from the
    /// clicked element up to the workspace's handlers): folding the zone and
    /// a group shrink the block, and a block click opens the source file at
    /// the block's first line.
    #[gpui::test]
    fn the_footprint_zone_folds_and_opens_the_source(cx: &mut TestAppContext) {
        use crate::footprint_zone::{
            OpenFootprintSource, ToggleFootprintGroup, ToggleFootprintZone,
        };
        use bnote_core::footprint::model::FootprintBlock;

        let today = super::today_string();
        let (workspace, fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write("Job/job todo.md", "- [ ] cs336\n- [ ] bm25\n");
            fixture.write(&format!("Daily/{today}.md"), &format!("# {today}\n"));
            vec![format!("Daily/{today}.md")]
        });
        cx.run_until_parked();
        let root = std::fs::canonicalize(&fixture.vault)
            .expect("canonical")
            .to_string_lossy()
            .to_string();

        let mut index = std::collections::BTreeMap::new();
        index.insert(
            format!("{root}/Job/job todo.md"),
            vec![FootprintBlock { text: "- [ ] cs336\n- [ ] bm25".into(), start: 1, end: 2 }],
        );
        workspace.update_in(cx, |ws, window, cx| {
            ws.debug_install_footprints(
                index
                    .into_iter()
                    .map(|(abs, blocks)| {
                        (abs.strip_prefix(&format!("{root}/")).unwrap_or(&abs).to_string(), blocks)
                    })
                    .collect(),
                cx,
            );
            ws.refresh_preview(window, cx);
            assert!(ws.preview.zone_is_some(), "the daily carries the zone");
        });
        crate::harness::draw(cx);
        let column = workspace.update_in(cx, |ws, _window, cx| ws.editor_width(cx)).max(px(80.));
        let zone_height = workspace.update_in(cx, |ws, window, cx| {
            ws.refresh_preview(window, cx);
            ws.preview.zone_height_for_test(column, window, cx)
        });
        assert!(zone_height > px(0.), "the zone reserves space: {zone_height:?}");

        // Collapse the zone: the block shrinks (head only).
        cx.dispatch_action(ToggleFootprintZone);
        cx.run_until_parked();
        let collapsed = workspace.update_in(cx, |ws, window, cx| {
            ws.refresh_preview(window, cx);
            ws.preview.zone_height_for_test(column, window, cx)
        });
        assert!(collapsed < zone_height, "collapsing shrinks the block");

        // Expand again, then collapse the only group: smaller than open,
        // larger than fully collapsed.
        cx.dispatch_action(ToggleFootprintZone);
        cx.run_until_parked();
        cx.dispatch_action(ToggleFootprintGroup { path: format!("{root}/Job/job todo.md") });
        cx.run_until_parked();
        let group_collapsed = workspace.update_in(cx, |ws, window, cx| {
            ws.refresh_preview(window, cx);
            ws.preview.zone_height_for_test(column, window, cx)
        });
        assert!(group_collapsed < zone_height && group_collapsed > collapsed);

        // A block click opens the source at the block's line.
        cx.dispatch_action(OpenFootprintSource {
            path: format!("{root}/Job/job todo.md"),
            line: 2,
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(ws.open_path.as_deref(), Some("Job/job todo.md"));
            assert_eq!(
                ws.editor.read(cx).selected_range().start,
                line_col_to_byte("- [ ] cs336\n- [ ] bm25\n", 2, 0),
                "the caret lands on the block's first line"
            );
        });
        let _ = std::fs::remove_dir_all(&fixture.vault);
        let _ = std::fs::remove_dir_all(&fixture.data_dir);
    }

    /// ⌘⇧R switches to the most recent other vault directly (TS
    /// `switchRecentVault`) and flushes the dirty note into the old vault
    /// before leaving.
    #[gpui::test]
    fn switch_recent_vault_jumps_straight_to_the_mru_vault(cx: &mut TestAppContext) {
        let (workspace, fixture, cx) = crate::harness::note_fixture(cx, true);
        let other = tempfile::TempDir::with_prefix("bnote-h-other-").expect("another vault");
        std::fs::write(other.path().join("other.md"), "另一仓的笔记\n").expect("the note");

        // The config lists both vaults (the shell writes the same shape on
        // every switch); `recent_vaults` filters the current one out.
        let recent = vec![
            fixture.vault.to_string_lossy().to_string(),
            other.path().to_string_lossy().to_string(),
        ];
        let state = workspace.read_with(cx, |ws, _| ws.state.clone());
        bnote_core::commands::config::save_app_config(
            &state,
            serde_json::json!({ "recentVaults": recent }),
        )
        .expect("the config");

        // A dirty buffer that must land on disk before the switch.
        workspace.update_in(cx, |ws, window, cx| {
            ws.debug_set_doc("未保存的改动\n", window, cx);
            ws.dirty = true;
        });
        workspace.update_in(cx, |ws, window, cx| {
            ws.switch_recent_vault(&actions::SwitchRecentVault, window, cx);
        });
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            // The shell holds the canonicalized root (/var's /private/var
            // spelling); identity, not the string, is what to assert.
            let got = ws.vault_root.clone().expect("the switched vault");
            let want = std::fs::canonicalize(other.path()).unwrap_or_else(|_| other.path().to_path_buf());
            assert_eq!(
                std::fs::canonicalize(&got).unwrap_or(got),
                want,
                "⌘⇧R switched to the MRU other vault"
            );
        });
        assert_eq!(
            fixture.read("note.md"),
            "未保存的改动\n",
            "the dirty buffer was flushed into the old vault"
        );
        // `other` stays alive on purpose: the workspace still points at it.
        std::mem::forget(other);
    }

    /// The toast: one message at a time, gone after 2.6 s, and a newer one
    /// invalidates the older timer.
    #[gpui::test]
    fn the_toast_shows_replaces_and_times_out(cx: &mut TestAppContext) {
        let (workspace, _fixture, cx) = crate::harness::note_fixture(cx, false);
        workspace.update(cx, |ws, cx| {
            ws.show_toast("第一条", cx);
        });
        workspace.update(cx, |ws, cx| {
            ws.show_toast("第二条", cx);
        });
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.toast.as_deref(), Some("第二条"), "the newer toast wins");
        });
        cx.executor().advance_clock(TOAST_DURATION);
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert!(ws.toast.is_none(), "the toast cleared after the duration");
        });
    }

    // ---- batch: vim parity (ex line, gv, zz) ------------------------------

    /// `:` opens the ex line through the real keystroke path, `w<Enter>` runs
    /// the save, and the alias comes from the same table the vimrc uses.
    #[gpui::test]
    fn the_ex_line_saves_through_the_real_keys(cx: &mut TestAppContext) {
        let (workspace, fixture, cx) = crate::harness::note_fixture(cx, true);
        workspace.update_in(cx, |ws, window, cx| {
            ws.debug_set_doc("ex 要保存的内容\n", window, cx);
            ws.dirty = true;
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let w = crate::harness::window(cx);

        crate::harness::press(cx, w, ":");
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| assert!(ws.ex_open, "`:` opens the ex line"));
        crate::harness::press(cx, w, "w");
        crate::harness::chord(cx, w, "enter");
        cx.run_until_parked();

        workspace.read_with(cx, |ws, _| {
            assert!(!ws.ex_open, "Enter closes the line");
        });
        assert_eq!(
            fixture.read("note.md"),
            "ex 要保存的内容\n",
            ":w wrote the note through the shared alias table"
        );

        // An unknown command is reported, not swallowed.
        crate::harness::press(cx, w, ":");
        cx.run_until_parked();
        crate::harness::press(cx, w, "nope");
        crate::harness::chord(cx, w, "enter");
        cx.run_until_parked();
        workspace.read_with(cx, |ws, _| {
            assert_eq!(ws.status, "未知命令 :nope");
        });
    }

    /// `V`, `<Esc>`, `gv` re-selects the line through the real keys; `zz`
    /// scrolls without moving the caret. The name mirrors the keys (the vim
    /// suite's convention, `editor/vim/tests.rs`).
    #[gpui::test]
    #[allow(non_snake_case)]
    fn gV_and_zZ_run_through_the_real_keys(cx: &mut TestAppContext) {
        let (workspace, _fixture, cx) = crate::harness::note_fixture(cx, true);
        workspace.update_in(cx, |ws, window, cx| {
            ws.debug_set_doc("aaa\nbbb\nccc\n", window, cx);
            ws.debug_set_cursor(4, cx); // on `bbb`
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let w = crate::harness::window(cx);

        crate::harness::press(cx, w, "V");
        crate::harness::chord(cx, w, "escape");
        crate::harness::press(cx, w, "gv");
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(
                ws.vim_bridge.mode_of(&ws.editor),
                Some(crate::editor::vim::core::Mode::VisualLine),
                "gv restored linewise visual"
            );
            let sel = ws.editor.read(cx).selected_range();
            assert_eq!(sel, 4..7, "the bbb line is selected again");
        });

        crate::harness::chord(cx, w, "escape");
        crate::harness::press(cx, w, "zz");
        workspace.read_with(cx, |ws, cx| {
            assert_eq!(
                ws.editor.read(cx).cursor(),
                4,
                "zz scrolled without moving the caret"
            );
        });
    }

    /// A left click on a folder row expands it and reveals its children; a
    /// second click collapses it again, and a vault refresh in between keeps
    /// the folder open (the expanded set is the shell's, not the scan's). A
    /// folder click never opens the directory as a note.
    #[gpui::test]
    fn clicking_a_folder_row_toggles_its_children(cx: &mut TestAppContext) {
        let (workspace, fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write("Folder/inner.md", "");
            fixture.write("Note.md", "");
            Vec::new()
        });
        let tree = workspace.read_with(cx, |ws, _| ws.tree_state.clone());
        crate::harness::draw(cx);

        let visible = |tree: &gpui::Entity<gpui_kit::component::tree::TreeState>,
                       cx: &gpui::VisualTestContext| {
            tree.read_with(cx, |t, _| {
                std::iter::from_fn({
                    let mut ix = 0;
                    move || {
                        let entry = t.entry(ix).map(|e| e.item().id.to_string());
                        ix += 1;
                        entry
                    }
                })
                .collect::<Vec<_>>()
            })
        };
        let rows = visible(&tree, cx);
        assert!(rows.contains(&"Folder".to_string()), "rows: {rows:?}");
        assert!(
            !rows.contains(&"Folder/inner.md".to_string()),
            "children start hidden: {rows:?}"
        );

        // The row is observed through the kit's test-support registry (its
        // aria label), and the click goes through native mouse dispatch at the
        // row's painted center — the same hit test a real click takes.
        let click_row = |cx: &mut gpui::VisualTestContext, label: &str| {
            crate::harness::draw(cx);
            let point = cx.update(|window, _| {
                gpui_kit::base::test_support::snapshots(window)
                    .into_iter()
                    .find(|snap| snap.label() == Some(label))
                    .unwrap_or_else(|| panic!("{label} has a painted row"))
                    .bounds()
                    .center()
            });
            cx.simulate_click(point, gpui::Modifiers::none());
            cx.run_until_parked();
        };

        click_row(cx, "Folder");
        crate::harness::draw(cx);
        let rows = visible(&tree, cx);
        assert!(
            rows.contains(&"Folder/inner.md".to_string()),
            "clicking the folder row reveals its children: {rows:?}"
        );
        workspace.read_with(cx, |ws, _| {
            assert!(
                ws.open_path.is_none(),
                "a folder click toggles, it does not open the directory as a note"
            );
        });

        // The vault watcher rebuilds the items on every change; the rows the
        // user opened must come back open.
        fixture.write("Another.md", "");
        workspace.update(cx, |ws, cx| ws.refresh_tree(cx));
        cx.run_until_parked();
        crate::harness::draw(cx);
        let rows = visible(&tree, cx);
        assert!(
            rows.contains(&"Folder/inner.md".to_string()),
            "a refresh keeps the folder open: {rows:?}"
        );
        assert!(
            rows.contains(&"Another.md".to_string()),
            "and shows the new file: {rows:?}"
        );

        click_row(cx, "Folder");
        crate::harness::draw(cx);
        let rows = visible(&tree, cx);
        assert!(
            !rows.contains(&"Folder/inner.md".to_string()),
            "clicking again collapses it: {rows:?}"
        );
    }
    /// `settings.latex` is read from the shared `config.json`, so a toggle the
    /// user set in the Tauri shell applies here: with `matrixShortcuts` off,
    /// Shift+Tab inside a matrix must not insert the column separator.
    #[gpui::test]
    fn the_latex_settings_block_reaches_the_snippet_host(cx: &mut TestAppContext) {
        /// Load a matrix and put the caret on its `x`; Shift+Tab then asks the
        /// snippet engine for the column separator.
        fn step_into_a_matrix(
            cx: &mut gpui::VisualTestContext,
            ws: &gpui::Entity<Workspace>,
        ) -> String {
            const DOC: &str = "$$\n\\begin{align}\nx\n\\end{align}\n$$\n";
            let at = DOC.find("x\n").expect("the matrix body");
            ws.update_in(cx, |ws, window, cx| {
                ws.replace_buffer(DOC, window, cx);
                ws.editor.update(cx, |ed, cx| ed.set_selected_range(at..at, cx));
            });
            crate::harness::draw(cx);
            let w = crate::harness::window(cx);
            crate::harness::chord(cx, w, "shift-tab");
            crate::harness::doc(ws, cx)
        }

        let (workspace, _fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write_config(serde_json::json!({
                "settings": { "latex": { "matrixShortcuts": false } }
            }));
            fixture.write("Note.md", "");
            Vec::new()
        });
        let off = step_into_a_matrix(cx, &workspace);
        assert!(
            !off.contains(" & "),
            "no matrix shortcut with the setting off: {off:?}"
        );

        // The same fixture with the default (on) does insert it — the setting
        // is what makes the difference, not an unrelated regression.
        let (workspace, _fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write("Note.md", "");
            Vec::new()
        });
        let on = step_into_a_matrix(cx, &workspace);
        assert!(
            on.contains(" & "),
            "the default inserts the column separator: {on:?}"
        );
    }

    /// Enter continues the list item under the caret through the real
    /// keystroke path (TS `ops.ts::enterContinueListItem`, a `Prec.highest`
    /// entry on Enter): the marker repeats with a fresh checkbox for todos and
    /// the next number for ordered lists, an empty nested item walks back one
    /// level, an empty top-level item leaves the list, and a fenced code block
    /// stays literal.
    #[gpui::test]
    fn enter_continues_list_items(cx: &mut TestAppContext) {
        let (workspace, _fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write(
                "Note.md",
                "- 项目一\n- [ ] 待办\n1. 一\n   - 嵌套\n- 空项\n\n```\ncode\n```\n",
            );
            vec!["Note.md".to_string()]
        });
        let w = crate::harness::window(cx);
        crate::harness::draw(cx);
        // Enter at the end of the line that contains `needle` (the caret is
        // where a user's would be when they press it).
        let enter_on = |cx: &mut gpui::VisualTestContext, needle: &str| {
            workspace.update_in(cx, |ws, _window, cx| {
                let text = ws.editor.read(cx).text().to_string();
                let start = text.find(needle).expect("the line is in the document");
                let end = text[start..].find('\n').map(|i| start + i).unwrap_or(text.len());
                ws.editor.update(cx, |ed, cx| ed.set_selected_range(end..end, cx));
            });
            crate::harness::chord(cx, w, "enter");
        };
        let text = |cx: &gpui::VisualTestContext| crate::harness::doc(&workspace, cx);

        // A bullet continues as a bullet.
        enter_on(cx, "- 项目一");
        assert_eq!(
            text(cx),
            "- 项目一\n- \n- [ ] 待办\n1. 一\n   - 嵌套\n- 空项\n\n```\ncode\n```\n"
        );

        // A todo continues with a fresh unchecked box.
        enter_on(cx, "- [ ] 待办");
        assert!(
            text(cx).contains("- [ ] 待办\n- [ ] \n1. 一"),
            "the todo continues unchecked: {:?}",
            text(cx)
        );

        // An ordered item continues with the next number.
        enter_on(cx, "1. 一");
        assert!(
            text(cx).contains("1. 一\n2. \n"),
            "ordered items number up: {:?}",
            text(cx)
        );

        // A nested item continues at its own level…
        enter_on(cx, "   - 嵌套");
        assert!(
            text(cx).contains("   - 嵌套\n   - \n"),
            "a nested item stays nested: {:?}",
            text(cx)
        );

        // …and an empty nested item walks back out one level.
        enter_on(cx, "   - \n");
        assert!(
            text(cx).contains("- \n- 空项"),
            "an empty nested item drops one level: {:?}",
            text(cx)
        );

        // A fenced code block stays literal: Enter is a plain newline.
        enter_on(cx, "code");
        assert!(
            text(cx).contains("```\ncode\n\n```"),
            "a code line is not a list: {:?}",
            text(cx)
        );
    }

    /// The list continuation stands down inside a `$$…$$` block: a `- ` line
    /// there is LaTeX (the snippet bridge owns Enter in formulas).
    #[gpui::test]
    fn enter_inside_a_formula_does_not_continue_a_list(cx: &mut TestAppContext) {
        let (workspace, _fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write("Note.md", "$$
- a
$$
");
            vec!["Note.md".to_string()]
        });
        let w = crate::harness::window(cx);
        crate::harness::draw(cx);
        workspace.update_in(cx, |ws, _window, cx| {
            let text = ws.editor.read(cx).text().to_string();
            let byte = line_col_to_byte(&text, 2, 4);
            ws.editor.update(cx, |ed, cx| ed.set_selected_range(byte..byte, cx));
        });
        crate::harness::chord(cx, w, "enter");
        assert!(
            !crate::harness::doc(&workspace, cx).contains("- a
- "),
            "no list continuation inside the block: {:?}",
            crate::harness::doc(&workspace, cx)
        );
    }

    /// Switching notes inside the auto-save debounce (or with auto-save off)
    /// must not drop the edits: `open_note` writes the dirty buffer out before
    /// the swap, which is what TS `openNote`'s awaited `saveNote()` does.
    #[gpui::test]
    fn switching_notes_writes_the_unsaved_content(cx: &mut TestAppContext) {
        let (workspace, fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write("A.md", "a");
            fixture.write("B.md", "b");
            vec!["A.md".to_string()]
        });
        crate::harness::draw(cx);
        let w = crate::harness::window(cx);

        // Type into A (dirty), then switch before the debounce fires.
        crate::harness::press(cx, w, "XY");
        assert_eq!(crate::harness::doc(&workspace, cx), "XYa");
        workspace.update_in(cx, |ws, window, cx| ws.open_note("B.md".to_string(), window, cx));
        cx.run_until_parked();

        assert_eq!(
            fixture.read("A.md"),
            "XYa",
            "the edit of the note being left is on disk"
        );
        assert_eq!(
            crate::harness::open_path(&workspace, cx).as_deref(),
            Some("B.md")
        );
    }

    /// Cursor memory is keyed by the **absolute** path — the shape the Tauri
    /// shell writes, so both shells share one memory per note. A relative key
    /// would silently give each shell its own.
    #[gpui::test]
    fn cursor_memory_is_keyed_by_the_absolute_path(cx: &mut TestAppContext) {
        let (workspace, fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write("Note.md", "一二三四五六七八九十");
            vec!["Note.md".to_string()]
        });
        crate::harness::draw(cx);

        // Move the caret (the observer queues the debounced save), then flush
        // it the way the quit path does — synchronously, so the file is
        // readable right here.
        workspace.update_in(cx, |ws, _window, cx| {
            ws.editor.update(cx, |ed, cx| ed.set_selected_range(6..6, cx));
        });
        // The caret observer that queues the save runs in the effect flush at
        // the end of that update.
        cx.run_until_parked();
        workspace.update_in(cx, |ws, _window, _cx| ws.flush_cursor_save_blocking());
        cx.run_until_parked();

        // The shell canonicalizes the vault root (`/var` → `/private/var` on
        // macOS), and the key follows the path it opened the note with.
        let abs = fixture
            .vault
            .canonicalize()
            .unwrap_or_else(|_| fixture.vault.clone())
            .join("Note.md")
            .to_string_lossy()
            .to_string();
        let raw = std::fs::read_to_string(fixture.data_dir.join("config.json")).unwrap_or_default();
        let config: serde_json::Value = serde_json::from_str(&raw).expect("config json");
        assert_eq!(
            config
                .get("cursorPositions")
                .and_then(|c| c.get(&abs))
                .and_then(|entry| entry.get("pos"))
                .and_then(|pos| pos.as_u64()),
            Some(6),
            "the absolute key holds the position: {raw}"
        );
        assert!(
            config
                .get("cursorPositions")
                .and_then(|c| c.get("Note.md"))
                .is_none(),
            "no relative twin is written: {raw}"
        );
    }

    /// The IME gate follows vim's mode through the real keystroke path: closed
    /// in normal/visual (a CJK input source must not eat the keys), open in
    /// insert/replace, and open again once vim is switched off. This is the
    /// host-side half of the platform seam; the platform's own routing is
    /// gpui's (`ElementInputHandler::prefers_ime_for_printable_keys`).
    #[gpui::test]
    fn the_ime_gate_follows_the_vim_mode(cx: &mut TestAppContext) {
        let (workspace, _fixture, cx) = crate::harness::note_fixture(cx, false);
        let w = crate::harness::window(cx);
        crate::harness::draw(cx);
        assert!(
            crate::harness::ime_gate(&workspace, cx),
            "vim off: the editor accepts text input"
        );

        workspace.update_in(cx, |ws, _window, cx| ws.harness_set_vim(true, cx));
        cx.run_until_parked();
        assert!(
            !crate::harness::ime_gate(&workspace, cx),
            "vim on starts in normal mode: the IME gate is closed"
        );

        crate::harness::press(cx, w, "i");
        assert_eq!(crate::harness::mode(&workspace, cx), Some(crate::editor::vim::core::Mode::Insert));
        assert!(
            crate::harness::ime_gate(&workspace, cx),
            "insert mode takes text input again"
        );

        crate::harness::chord(cx, w, "escape");
        assert_eq!(crate::harness::mode(&workspace, cx), Some(crate::editor::vim::core::Mode::Normal));
        assert!(
            !crate::harness::ime_gate(&workspace, cx),
            "leaving insert closes the gate again"
        );

        workspace.update_in(cx, |ws, _window, cx| ws.harness_set_vim(false, cx));
        cx.run_until_parked();
        assert!(
            crate::harness::ime_gate(&workspace, cx),
            "vim off hands text input back to the platform"
        );
    }

    /// The quick switcher: ⌘O opens it, Enter opens the highlighted row's note,
    /// and Escape clears the query first and closes on the next press. A real
    /// regression net for the real-window report "跳转到文件无法生效,弹窗也不能关闭".
    #[gpui::test]
    fn the_quick_switcher_opens_a_row_and_escape_closes(cx: &mut TestAppContext) {
        let (workspace, _fixture, cx) = crate::harness::workspace_fixture_with(cx, |fixture| {
            fixture.write("Note.md", "hi");
            Vec::new()
        });
        let w = crate::harness::window(cx);
        crate::harness::draw(cx);

        crate::harness::chord(cx, w, "cmd-o");
        crate::harness::draw(cx);
        assert!(workspace.read_with(cx, |ws, _| ws.harness_palette_open()), "⌘O opens the switcher");

        crate::harness::press(cx, w, "Note");
        assert_eq!(
            workspace.read_with(cx, |ws, cx| ws.harness_palette_query(cx)),
            "Note",
            "the query field takes typed text"
        );

        crate::harness::chord(cx, w, "enter");
        cx.run_until_parked();
        assert_eq!(
            crate::harness::open_path(&workspace, cx).as_deref(),
            Some("Note.md"),
            "Enter opens the highlighted note"
        );
        assert!(
            !workspace.read_with(cx, |ws, _| ws.harness_palette_open()),
            "Enter closes the switcher"
        );

        // Escape: first press clears a non-empty query, the second closes.
        crate::harness::chord(cx, w, "cmd-o");
        crate::harness::draw(cx);
        crate::harness::press(cx, w, "N");
        crate::harness::chord(cx, w, "escape");
        cx.run_until_parked();
        assert!(workspace.read_with(cx, |ws, _| ws.harness_palette_open()), "Esc #1 keeps the palette");
        assert_eq!(
            workspace.read_with(cx, |ws, cx| ws.harness_palette_query(cx)),
            "",
            "Esc #1 clears the query"
        );
        crate::harness::chord(cx, w, "escape");
        cx.run_until_parked();
        assert!(
            !workspace.read_with(cx, |ws, _| ws.harness_palette_open()),
            "Esc #2 closes the switcher"
        );
    }

}

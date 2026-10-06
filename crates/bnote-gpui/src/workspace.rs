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

use bnote_core::markdown::numbering;
use bnote_core::markdown::ops as ops;
use bnote_core::markdown::wikilink;
use bnote_core::state::AppState;
use ::gpui::{
    AppContext as _, Context, Entity, Focusable, Subscription, WeakEntity, Window, div, px, relative,
};
use gpui_kit::component::button::ButtonVariants as _;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{
    ActiveTheme, IconName,
    button::Button,
    command::{Command, CommandItem, CommandState},
    h_flex, v_flex,
    input::{Editor, EditorState, Input, InputEvent, InputState, TextDecorationCollection},
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
use crate::commands::{COMMANDS, actions};
use crate::daily_host::{DailyHost, SyncWrite};
use crate::editor::images as editor_images;
use crate::editor::preview::{PreviewFont, PreviewHost};
use crate::editor::snippets_host::SnippetBridge;
use crate::editor::vim::core::Mode as VimMode;
use crate::footprint_host::FootprintHost;

/// How long typing pauses before the buffer flushes to disk (mirrors the
/// Tauri shell's stop-typing autosave).
const AUTOSAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(800);

/// How long the caret must rest before its position is persisted (the TS
/// `cursorMemory.ts` debounce).
const CURSOR_SAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(300);

/// How often the shell polls the backend event bus for vault/agent events.
const EVENT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(300);

/// Every Nth event-loop iteration pumps the footprint core (~1.2s at 300ms).
const FOOTPRINT_TICK_EVERY: u32 = 4;

/// `settings.fontSize` default (TS `DEFAULT_SETTINGS.fontSize`).
const FONT_SIZE_DEFAULT: f32 = 16.;

/// The link-suggest panel's fixed width (TS `.link-suggest`, 380px).
const LINK_PANEL_W: f32 = 380.;
/// The panel's worst-case height, the bound used when it has to flip above
/// the caret (TS measures the panel; 252px results cap plus the search field).
const LINK_PANEL_H: f32 = 300.;

#[derive(Clone, Copy, PartialEq)]
enum PaletteKind {
    Commands,
    Files,
    Vaults,
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
    Vim,
    Snippets,
    QuickAdd,
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
    /// Serializes disk writes and keeps the last written seq (see module docs).
    save_guard: Arc<Mutex<u64>>,
    status: String,
    cursor_label: String,

    // Feature hosts (present once a vault is open).
    daily: Option<Arc<DailyHost>>,
    footprint: Option<Arc<FootprintHost>>,

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
    /// ⌘T round-trip memory (path → return position).
    header_returns: ops::HeaderTodoReturnMap,
    /// App-wide vim bridge (created in main; shared with the interceptor).
    vim_bridge: VimBridge,
    vim_enabled: bool,
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
    /// The settings modal (⌘,): TS `SettingsModal.tsx`'s tabs this shell
    /// consumes — general / editor / vim / snippets. Hotkeys, IME, quick-add
    /// and the agent tab arrive with their own ports.
    settings_open: bool,
    settings_tab: SettingsTab,
    /// `settings.*` of `config.json` as the modal's working state; every
    /// change is applied live and written back under the same keys the Tauri
    /// shell uses.
    math_preview: bool,
    typewriter: bool,
    code_block_lang: String,
    theme_mode: ThemeMode,
    font_size: f32,
    snippets_enabled: bool,
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
    pub fn new(
        state: Arc<AppState>,
        mut event_rx: broadcast::Receiver<bnote_core::AppEvent>,
        last_vault: Option<PathBuf>,
        vim_bridge: VimBridge,
        snippets: SnippetBridge,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language("markdown")
                .line_number(true)
                .soft_wrap(true)
                .placeholder("打开左侧文件开始笔记")
        });
        // Snippets run with vim on or off; the bridge reads the mode from the
        // vim bridge, which stays the single mode authority.
        snippets.attach(editor.clone(), vim_bridge.clone(), cx);

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
        let font_slider = cx.new(|_| {
            SliderState::new()
                .min(12.)
                .max(28.)
                .step(1.)
                .default_value(font_size)
        });
        font_slider.update(cx, |st, cx| st.set_value(font_size, window, cx));

        let qa_state = cx.new(|cx| CommandState::new(window, cx));
        let qa_name_state = cx.new(|cx| InputState::new(window, cx));

        let theme = cx.theme();
        let preview = Rc::new(PreviewHost::new(PreviewFont {
            family: theme.mono_font_family.clone(),
            size: theme.mono_font_size,
        }));
        // The live-rendered copy of a display formula while editing it.
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
            cx.subscribe(&editor, |this, _editor, event: &InputEvent, cx| {
                this.preview_dirty = true;
                this.on_edited(cx);
                this.schedule_renumber(event, cx);
            }),
            cx.observe(&editor, |this, editor, cx| {
                let selection = editor.read(cx).selected_range();
                if this.preview_selection.as_ref() != Some(&selection) {
                    this.preview_selection = Some(selection);
                    this.preview_dirty = true;
                    // Cursor memory rides the same signal: the caret moved.
                    this.schedule_cursor_save(cx);
                    cx.notify();
                }
            }),
            // Losing the window persists the caret before the user walks away
            // with the app in the background (TS flushes on window blur too).
            cx.observe_window_activation(window, |this, window, cx| {
                if !window.is_window_active() {
                    this.flush_cursor_save_now(cx);
                }
            }),
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
            save_guard: Arc::new(Mutex::new(0)),
            status: "未打开仓库".to_string(),
            cursor_label: String::new(),
            daily: None,
            footprint: None,
            sidebar_open: true,
            agent,
            agent_open: false,
            palette: None,
            cmd_state,
            files_state,
            files: Vec::new(),
            mru: Vec::new(),
            header_returns: ops::HeaderTodoReturnMap::new(),
            vim_bridge,
            vim_enabled: false,
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
            settings_open: false,
            settings_tab: SettingsTab::General,
            math_preview,
            typewriter,
            code_block_lang,
            theme_mode,
            font_size,
            snippets_enabled,
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

        // Restore the vim setting (same config.json key the Tauri shell uses).
        let vim_enabled = setting("vim").unwrap_or(false);
        if vim_enabled {
            workspace.vim_enabled = true;
            workspace.set_vim_enabled(true, cx);
            workspace.status = "vim 模式开启(普通模式)".to_string();
        }

        // The caret position of the closing window is written synchronously —
        // the debounced write would be racing the process teardown.
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_window, cx| {
            weak.update(cx, |workspace, _cx| workspace.flush_cursor_save_blocking())
                .ok();
            true
        });

        // Focus the editor so global actions bubble through this view.
        let focus_handle = workspace.editor.focus_handle(cx);
        window.defer(cx, move |window, cx| {
            focus_handle.focus(window, cx);
        });

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
                if let Some(fp) = &self.footprint {
                    fp.note_dirty(&paths);
                }
                self.invalidate_images(&paths, cx);
                self.reload_open_if_externally_changed(&paths, cx);
                let tree = self.tree_state.clone();
                cx.spawn(async move |this, cx| reload_tree(this, tree, cx).await)
                    .detach();
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
                        this.status = format!("打开仓库失败:{}", e);
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
        self.daily = Some(Arc::new(DailyHost::new(self.state.clone(), &root)));
        let fp = Arc::new(FootprintHost::new(&root));
        self.footprint = Some(fp.clone());
        let today = self.today.clone();
        cx.spawn(async move |_this, cx| {
            cx.background_executor().spawn(async move { fp.init(&today) }).await;
        })
        .detach();
        cx.notify();
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
                        this.status = format!("读取仓库片段失败:{e}");
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

    fn on_edited(&mut self, cx: &mut Context<Self>) {
        self.dirty = true;
        self.save_seq += 1;
        self.update_cursor_label(cx);
        let seq = self.save_seq;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(AUTOSAVE_DEBOUNCE).await;
            save_snapshot(this, seq, cx).await;
        })
        .detach();
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
        let Some(path) = self.open_path.clone() else {
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

    /// TS `restoreSavedCursor` — put the caret back where the user left this
    /// note, scroll included. No-op for a note never visited. The scroll
    /// offset is deferred by the engine to the next layout, which is exactly
    /// when the freshly installed text has a scroll range.
    fn restore_cursor_memory(&mut self, rel_path: &str, cx: &mut Context<Self>) {
        let Ok(config) = bnote_core::commands::config::load_app_config(&self.state) else {
            return;
        };
        let Some((pos, scroll)) = bnote_core::commands::config::cursor_position(&config, rel_path)
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
        self.cursor_label = format!("{}:{}", line, col);
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
        cx.spawn(async move |this, cx| save_snapshot(this, seq, cx).await).detach();
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
                move |ix, _window, cx| {
                    let Some(rel) = rels.get(ix.row).cloned() else {
                        return;
                    };
                    let _ = weak.update_in(cx, |this, window, cx| {
                        this.insert_wikilink_pick(&rel, window, cx);
                    });
                }
            })
            .on_cancel({
                let weak = weak.clone();
                move |_window, cx| {
                    let _ = weak.update_in(cx, |this, window, cx| {
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

    /// ⌘⇧O: open (or create with rollover) today's daily note.
    fn open_daily(&mut self, _: &actions::OpenDaily, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.has_doc() {
            self.status = "先打开一个仓库".to_string();
            cx.notify();
            return;
        }
        if self.open_path.as_deref().is_some_and(|p| bnote_core::daily::model::is_daily_path(p))
        {
            self.status = "已在今日日记".to_string();
            cx.notify();
            return;
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
                    this.status = format!("打开日记失败:{}", e);
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
                    this.status = format!("新建失败:{}", e);
                }
            })
            .ok();
        })
        .detach();
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
            self.vim_bridge.detach(&editor);
            editor.update(cx, |state, cx| state.set_readonly(false, cx));
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
        let cfg = load_config_value(&self.state);
        let commands = bnote_core::commands::config::quick_add_commands(&cfg);
        self.qa_rows.clear();
        for cmd in commands {
            let (name, folder) = (cmd.name.clone(), cmd.folder.clone());
            self.qa_add_row(&name, &folder, window, cx);
        }
        cx.notify();
    }

    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.settings_open {
            return;
        }
        self.settings_open = false;
        self.focus_editor(window, cx);
        cx.notify();
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
        cx.notify();
    }

    /// The pick stage: remember the command, switch the field to naming.
    fn qa_pick(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cmd) = self.qa_commands.get(ix).cloned() else { return };
        self.qa_naming = true;
        self.qa_picked = Some(cmd.clone());
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
                        this.status = format!("快速添加失败:{e}");
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
                .on_confirm(move |ix, _window, cx| {
                    let _ = weak_confirm.update_in(cx, |this, window, cx| {
                        this.qa_pick(ix.row, window, cx);
                    });
                })
                .on_cancel(move |_window, cx| {
                    let _ = weak_cancel.update_in(cx, |this, window, cx| {
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
                    (SettingsTab::Vim, "Vim"),
                    (SettingsTab::Snippets, "公式片段"),
                    (SettingsTab::QuickAdd, "快速添加"),
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
                            this.settings_tab = tab;
                            cx.notify();
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
                                Button::new("settings-open-vault")
                                    .outline()
                                    .label("其他仓库(⌘⇧R)")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_vault_palette(window, cx);
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
        let state = self.files_state.clone();
        state.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }

    fn switch_recent_vault(
        &mut self,
        _: &actions::SwitchRecentVault,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_vault_palette(window, cx);
    }

    /// The vault list palette — reached by ⌘⇧R and from the settings modal's
    /// "other vault" button (one path, so both stay in sync).
    fn open_vault_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings_open = false;
        self.palette = Some(PaletteKind::Vaults);
        let state = self.files_state.clone();
        state.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }

    fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        let focus = self.editor.focus_handle(cx);
        focus.focus(window, cx);
        cx.notify();
    }

    fn recent_vaults(&self) -> Vec<String> {
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
                self.vault_root
                    .as_ref()
                    .map(|root| PathBuf::from(p) != *root)
                    .unwrap_or(true)
            })
            .collect()
    }

    fn switch_vault(&mut self, path: String, cx: &mut Context<Self>) {
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
                        this.status = format!("读取失败:{}", e);
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
        self.editor.update(cx, |ed, cx| {
            ed.set_value(text.clone(), window, cx);
        });
        self.dirty = false;
        self.open_path = Some(rel_path.clone());
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
        self.update_cursor_label(cx);
    }

    fn has_doc(&self) -> bool {
        self.open_path.is_some() && self.vault_root.is_some()
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

    /// Drops cached images the vault watcher reports as changed (a re-exported
    /// preview, an edited attachment). The next scan loads them again; until
    /// then the source text stays visible, so nothing flickers to a stale
    /// bitmap.
    fn invalidate_images(&mut self, paths: &[String], cx: &mut Context<Self>) {
        let Some(root) = self.vault_root.clone() else {
            return;
        };
        let store = self.preview.images();
        let mut hit = false;
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
        }
        if hit {
            self.preview_dirty = true;
            cx.notify();
        }
    }

    // ---- rendering --------------------------------------------------------

    /// Status-bar vim badge ("" when vim is off).
    fn vim_label(&self, _cx: &Context<Self>) -> String {
        if !self.vim_enabled {
            return String::new();
        }
        match self.vim_bridge.mode_of(&self.editor) {
            Some(VimMode::Normal) => "-- 普通 --".to_string(),
            Some(VimMode::Insert) => "-- 插入 --".to_string(),
            Some(VimMode::Replace) => "-- 替换 --".to_string(),
            Some(VimMode::Visual) => "-- 可视 --".to_string(),
            Some(VimMode::VisualLine) => "-- 可视行 --".to_string(),
            Some(VimMode::VisualBlock) => "-- 可视块 --".to_string(),
            None => String::new(),
        }
        .to_string()
    }

    fn render_file_tree(&self, _window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let view = cx.entity();
        tree(
            &self.tree_state,
            move |ix, entry, _selected, _window, cx| {
                let is_folder = entry.is_folder();
                let expanded = entry.is_expanded();
                let rel = entry.item().id.clone();
                let label = entry.item().label.clone();
                view.update(cx, |_, cx| {
                    let icon = if !is_folder {
                        IconName::File
                    } else if expanded {
                        IconName::FolderOpen
                    } else {
                        IconName::Folder
                    };

                    ListItem::new(ix)
                        .w_full()
                        .rounded(cx.theme().radius)
                        .py_0p5()
                        .px_2()
                        .pl(px(16.) * entry.depth() + px(8.))
                        .child(h_flex().gap_2().child(icon).child(label))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if !is_folder {
                                this.open_note(rel.to_string(), window, cx);
                            }
                        }))
                })
            },
        )
        .text_sm()
        .p_1()
        .bg(cx.theme().sidebar)
        .text_color(cx.theme().sidebar_foreground)
        .h_full()
        .into_any_element()
    }

    fn render_palette(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let theme = cx.theme().clone();
        let kind = self.palette?;
        let weak = cx.entity().downgrade();
        let weak_files = weak.clone();
        let weak_vaults = weak.clone();

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
                    .on_cancel(move |_window, cx| {
                        let _ = weak.update_in(cx, |this, window, cx| {
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
                    .on_confirm(move |ix, _window, cx| {
                        let Some(target) = names_arc.get(ix.row).cloned() else { return };
                        let _ = weak_confirm.update_in(cx, |this, window, cx| {
                            this.open_note(target, window, cx);
                            this.close_palette(window, cx);
                        });
                    })
                    .on_cancel(move |_window, cx| {
                        let _ = weak_cancel.update_in(cx, |this, window, cx| {
                            this.close_palette(window, cx);
                        });
                    })
                    .into_any_element()
            }
            PaletteKind::Vaults => {
                let weak_confirm = weak_vaults.clone();
                let weak_cancel = weak_vaults.clone();
                let vaults = self.recent_vaults();
                let items: Vec<CommandItem> = vaults
                    .iter()
                    .map(|v| CommandItem::new().label(v.clone()))
                    .collect();
                let vaults_arc = Arc::new(vaults);
                Command::new(&self.files_state)
                    .items(items)
                    .placeholder("切换到最近打开的仓库…")
                    .on_confirm(move |ix, _window, cx| {
                        let Some(target) = vaults_arc.get(ix.row).cloned() else { return };
                        let _ = weak_confirm.update_in(cx, |this, _window, cx| {
                            this.switch_vault(target, cx);
                        });
                    })
                    .on_cancel(move |_window, cx| {
                        let _ = weak_cancel.update_in(cx, |this, window, cx| {
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

pub(crate) fn action_for(id: &str) -> Option<Box<dyn gpui::Action>> {
    use crate::commands::actions as a;
    Some(match id {
        "save-note" => Box::new(a::Save),
        "command-palette" => Box::new(a::CommandPalette),
        "quick-switcher" => Box::new(a::QuickSwitcher),
        "switch-recent-vault" => Box::new(a::SwitchRecentVault),
        "toggle-sidebar" => Box::new(a::ToggleSidebar),
        "focus-sidebar" => Box::new(a::FocusSidebar),
        "new-note" => Box::new(a::NewNote),
        "quick-add" => Box::new(a::QuickAdd),
        "open-daily" => Box::new(a::OpenDaily),
        "todo-to-daily" => Box::new(a::SendTodoToDaily),
        "toggle-todo" => Box::new(a::ToggleTodo),
        "toggle-heading" => Box::new(a::CycleHeading),
        "edit.heading-1" => Box::new(a::Heading1),
        "edit.heading-2" => Box::new(a::Heading2),
        "edit.heading-3" => Box::new(a::Heading3),
        "edit.heading-4" => Box::new(a::Heading4),
        "toggle-bullet-list" => Box::new(a::ToggleBulletList),
        "toggle-numbered-list" => Box::new(a::ToggleNumberedList),
        "toggle-bold" => Box::new(a::ToggleBold),
        "toggle-italic" => Box::new(a::ToggleItalic),
        "toggle-strikethrough" => Box::new(a::ToggleStrikethrough),
        "insert-inline-code" => Box::new(a::InsertInlineCode),
        "insert-code-block" => Box::new(a::InsertCodeBlock),
        "insert-math-block" => Box::new(a::InsertMathBlock),
        "insert-inline-math" => Box::new(a::InsertInlineMath),
        "insert-callout" => Box::new(a::InsertCallout),
        "insert-wikilink" => Box::new(a::InsertWikilink),
        "insert-horizontal-rule" => Box::new(a::InsertHorizontalRule),
        "header-todos" => Box::new(a::HeaderTodos),
        "toggle-agent-panel" => Box::new(a::ToggleAgentPanel),
        "toggle-vim" => Box::new(a::ToggleVim),
        "open-settings" => Box::new(a::OpenSettings),
        _ => return None,
    })
}

/// Default keybinding for a registry command (KeyBinding needs the concrete
/// action type, so this mirrors [`action_for`]'s table).
pub(crate) fn keybinding_for(id: &str, key: &str) -> Option<gpui::KeyBinding> {
    use crate::commands::actions as a;
    Some(match id {
        "save-note" => gpui::KeyBinding::new(key, a::Save, None),
        "command-palette" => gpui::KeyBinding::new(key, a::CommandPalette, None),
        "quick-switcher" => gpui::KeyBinding::new(key, a::QuickSwitcher, None),
        "switch-recent-vault" => gpui::KeyBinding::new(key, a::SwitchRecentVault, None),
        "toggle-sidebar" => gpui::KeyBinding::new(key, a::ToggleSidebar, None),
        "focus-sidebar" => gpui::KeyBinding::new(key, a::FocusSidebar, None),
        "new-note" => gpui::KeyBinding::new(key, a::NewNote, None),
        "quick-add" => gpui::KeyBinding::new(key, a::QuickAdd, None),
        "open-daily" => gpui::KeyBinding::new(key, a::OpenDaily, None),
        "todo-to-daily" => gpui::KeyBinding::new(key, a::SendTodoToDaily, None),
        "toggle-todo" => gpui::KeyBinding::new(key, a::ToggleTodo, None),
        "toggle-heading" => gpui::KeyBinding::new(key, a::CycleHeading, None),
        "edit.heading-1" => gpui::KeyBinding::new(key, a::Heading1, None),
        "edit.heading-2" => gpui::KeyBinding::new(key, a::Heading2, None),
        "edit.heading-3" => gpui::KeyBinding::new(key, a::Heading3, None),
        "edit.heading-4" => gpui::KeyBinding::new(key, a::Heading4, None),
        "toggle-bullet-list" => gpui::KeyBinding::new(key, a::ToggleBulletList, None),
        "toggle-numbered-list" => gpui::KeyBinding::new(key, a::ToggleNumberedList, None),
        "toggle-bold" => gpui::KeyBinding::new(key, a::ToggleBold, None),
        "toggle-italic" => gpui::KeyBinding::new(key, a::ToggleItalic, None),
        "toggle-strikethrough" => gpui::KeyBinding::new(key, a::ToggleStrikethrough, None),
        "insert-inline-code" => gpui::KeyBinding::new(key, a::InsertInlineCode, None),
        "insert-code-block" => gpui::KeyBinding::new(key, a::InsertCodeBlock, None),
        "insert-math-block" => gpui::KeyBinding::new(key, a::InsertMathBlock, None),
        "insert-inline-math" => gpui::KeyBinding::new(key, a::InsertInlineMath, None),
        "insert-callout" => gpui::KeyBinding::new(key, a::InsertCallout, None),
        "insert-wikilink" => gpui::KeyBinding::new(key, a::InsertWikilink, None),
        "insert-horizontal-rule" => gpui::KeyBinding::new(key, a::InsertHorizontalRule, None),
        "header-todos" => gpui::KeyBinding::new(key, a::HeaderTodos, None),
        "toggle-agent-panel" => gpui::KeyBinding::new(key, a::ToggleAgentPanel, None),
        "toggle-vim" => gpui::KeyBinding::new(key, a::ToggleVim, None),
        "open-settings" => gpui::KeyBinding::new(key, a::OpenSettings, None),
        _ => return None,
    })
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
        // An image span's width is fixed when the span is emitted, so a change
        // in the editor's width (window resize, panel toggle) makes every
        // image span stale. `input_bounds` is last frame's measurement, so the
        // rescan settles one frame later.
        if self.preview.needs_rescan(self.editor_width(cx)) {
            self.preview_dirty = true;
        }
        // The scan only emits for the visible window (plus a margin), so
        // scrolling out of the covered range must rebuild it — one frame after
        // the scroll, like the resize above. Within the margin this fires
        // nothing, keeping whole-document scans off the scroll path.
        let visible = self.editor.read(cx).visible_byte_range();
        if self.preview.needs_rescan_for(visible.as_ref()) {
            self.preview_dirty = true;
        }
        let content_changed = self.preview_dirty;
        if self.preview_dirty {
            self.preview_dirty = false;
            let selection = self.editor.read(cx).selected_range();
            self.preview_selection = Some(selection.clone());
            let text = self.editor.read(cx).text().to_string();
            let column = self.preview.text_column(self.editor_width(cx), &text, window);
            let decorations = self.preview.decorations(
                &text,
                &[selection],
                column,
                visible.as_ref(),
                window,
                cx,
            );
            self.preview_styles.set(decorations.styles, cx);
            self.editor.update(cx, |state, cx| {
                state.set_preview_decorations(decorations.decorations, cx)
            });
            // The scan just queued a load for every image whose size it does
            // not know yet; run them off the UI thread.
            self.spawn_image_loads(cx);
        }
        // LaTeX-suite bracket marks: rebuilt when the document or the caret
        // changed (the same subscription that drives the preview) or when the
        // viewport scrolled, so a frame that changes none of them does no work.
        let rows = self.editor.read(cx).visible_row_range();
        if content_changed || rows != self.snippet_marks_rows {
            self.snippet_marks_rows = rows;
            self.snippets.refresh_marks(&self.editor, window, cx);
        }
        let theme = cx.theme().clone();
        let footprint_count = self
            .footprint
            .as_ref()
            .map(|fp| fp.today_entries().len())
            .unwrap_or(0);

        let editor = Editor::new(&self.editor)
            .bordered(false)
            .p_0()
            .h(relative(1.))
            .font_family(theme.mono_font_family.clone())
            .text_size(theme.mono_font_size)
            .flex_1();

        let mut main = v_flex()
            .size_full();

        if self.sidebar_open {
            main = main.child(
                h_resizable("main")
                    .child(
                        resizable_panel()
                            .size(px(240.))
                            .child(self.render_file_tree(window, cx)),
                    )
                    .child(editor.into_any_element()),
            );
        } else {
            main = main.child(editor.into_any_element());
        }

        if self.agent_open {
            main = main.child(div().w(px(360.)).h_full().child(self.agent.clone()));
        }

        let palette = if self.palette.is_some() { self.render_palette(cx) } else { None };
        let quick_add = self.render_quick_add(cx);
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
            .on_action(cx.listener(Self::quick_add))
            .on_action(cx.listener(Self::open_daily))
            .on_action(cx.listener(Self::send_todo_to_daily))
            .on_action(cx.listener(Self::toggle_todo))
            .on_action(cx.listener(Self::cycle_heading))
            .on_action(cx.listener(Self::heading1))
            .on_action(cx.listener(Self::heading2))
            .on_action(cx.listener(Self::heading3))
            .on_action(cx.listener(Self::heading4))
            .on_action(cx.listener(Self::toggle_bullet))
            .on_action(cx.listener(Self::toggle_numbered))
            .on_action(cx.listener(Self::toggle_bold))
            .on_action(cx.listener(Self::toggle_italic))
            .on_action(cx.listener(Self::toggle_strikethrough))
            .on_action(cx.listener(Self::insert_inline_code))
            .on_action(cx.listener(Self::insert_math_block))
            .on_action(cx.listener(Self::insert_inline_math))
            .on_action(cx.listener(Self::insert_code_block))
            .on_action(cx.listener(Self::insert_callout))
            .on_action(cx.listener(Self::insert_wikilink))
            .on_action(cx.listener(Self::insert_hr))
            .on_action(cx.listener(Self::header_todos))
            .on_action(cx.listener(Self::toggle_agent_panel))
            .on_action(cx.listener(Self::toggle_vim))
            .on_action(cx.listener(Self::open_settings))
            // Esc closes the settings modal from anywhere: it takes no focus
            // of its own, so the handler sits on the root — the one element
            // every key dispatch passes through (the link panel's own capture
            // is deeper and runs after this one lets it through).
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if this.settings_open && event.keystroke.key == "escape" {
                    this.close_settings(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(main)
            .children(palette)
            .children(link_suggest)
            .children(settings)
            .children(quick_add)
            .child(
                StatusBar::new()
                    .left(Label::new(self.status.clone()))
                    .right(
                        h_flex()
                            .gap_2()
                            .child(
                                Label::new(if footprint_count > 0 {
                                    format!("今日足迹 {} 块", footprint_count)
                                } else {
                                    String::new()
                                })
                                .text_xs()
                                .text_color(theme.muted_foreground),
                            )
                            .child(
                                Label::new(self.vim_label(cx))
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            )
                            .child(
                                Label::new(self.cursor_label.clone())
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            )
                            .child(
                                Label::new(if self.dirty {
                                    "● 未保存".to_string()
                                } else {
                                    String::new()
                                }),
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
        let _ = tree.update(cx, |state, cx| {
            let items = build_items(&index);
            state.set_items(items, cx);
        });
    }
}

/// Flattens the vault index (dirs + files, both vault-relative) into TreeItems
/// sorted dirs-first by name, matching the Tauri shell's tree order.
fn build_items(index: &bnote_core::commands::vault::VaultIndex) -> Vec<TreeItem> {
    let mut by_parent: HashMap<String, Vec<TreeItem>> = HashMap::new();

    // Register every directory as a child of its parent so empty dirs show.
    for dir in &index.dirs {
        let (parent, name) = split_last(dir);
        by_parent.entry(parent).or_default().push(TreeItem::new(dir.clone(), name));
    }

    for file in &index.files {
        let (parent, name) = split_last(file);
        by_parent.entry(parent).or_default().push(TreeItem::new(file.clone(), name));
    }

    fn attach(by_parent: &mut HashMap<String, Vec<TreeItem>>, parent: &str) -> Vec<TreeItem> {
        let Some(mut children) = by_parent.remove(parent) else {
            return Vec::new();
        };
        children.sort_by(|a, b| a.label.cmp(&b.label));
        for child in children.iter_mut() {
            if child.is_folder() {
                let id = child.id.to_string();
                let subs = attach(by_parent, &id);
                if !subs.is_empty() {
                    *child = child.clone().children(subs);
                }
            }
        }
        children
    }

    let mut top = attach(&mut by_parent, "");
    top.sort_by_key(|item| (!item.is_folder(), item.label.to_lowercase()));
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
async fn save_snapshot(this: WeakEntity<Workspace>, seq: u64, cx: &mut gpui::AsyncApp) {
    let (state, root, path, text, guard, daily, today) = match this.update(cx, |this, cx| {
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
            let mut last = guard.lock().unwrap();
            if seq <= *last {
                return None;
            }
            // core's write_file keeps the ensure_within path guard.
            let result =
                bnote_core::commands::files::write_file(&state, abs.clone(), text.clone());
            if result.is_err() {
                return None;
            }
            *last = seq;
            // Daily sync derives intents from this save; host does its own IO.
            let followups: Vec<SyncWrite> = match &daily {
                Some(host) => host.on_saved(&abs, &text, &today),
                None => Vec::new(),
            };
            Some(followups)
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
                    this.editor.update(cx, |ed, cx| {
                        ed.set_value(new_text, window, cx);
                    });
                    this.dirty = false;
                }
            }
            None => {
                this.status = "保存失败(见日志)".to_string();
            }
        }
        cx.notify();
    })
    .ok();
}

/// Pure-logic pins for the renumbering gate and the demotion tests. A module
/// with *exact* imports (no `use super::*`): the parent's glob brings in the
/// kit's `test` macro, which shadows the built-in `#[test]`.
#[cfg(test)]
mod gate_tests {
    use super::{
        cycle_demotes_cursor_line, level_toggle_demotes_cursor_line, link_row_parts,
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
        EditorState, InputEvent, Workspace, actions, apply_edits_keeping_cursor, numbering,
        should_schedule_renumber, wikilink,
    };
    use gpui::{
        AppContext as _, Context, Focusable as _, IntoElement, Render, TestAppContext, Window, div,
    };

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
}

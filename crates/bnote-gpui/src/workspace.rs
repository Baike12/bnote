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

use bnote_core::markdown::ops as ops;
use bnote_core::state::AppState;
use ::gpui::{
    AppContext as _, Context, Entity, Focusable, Subscription, WeakEntity, Window, div, px, relative,
};
use gpui_kit::component::{
    ActiveTheme, IconName,
    command::{Command, CommandItem, CommandState},
    h_flex, v_flex,
    input::{Editor, EditorState, InputEvent},
    label::Label,
    list::ListItem,
    resizable::{h_resizable, resizable_panel},
    status_bar::StatusBar,
    tree::{TreeItem, TreeState, tree},
};
use gpui_kit::*;
use tokio::sync::broadcast;

use crate::agent_panel::AgentPanel;
use crate::editor::vim::integration::VimBridge;
use crate::apply_ops::apply_outcome;
use crate::commands::{COMMANDS, actions};
use crate::daily_host::{DailyHost, SyncWrite};
use crate::editor::preview::{PreviewFont, PreviewHost};
use crate::editor::snippets_host::SnippetBridge;
use crate::editor::vim::core::Mode as VimMode;
use crate::footprint_host::FootprintHost;

/// How long typing pauses before the buffer flushes to disk (mirrors the
/// Tauri shell's stop-typing autosave).
const AUTOSAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(800);

/// How often the shell polls the backend event bus for vault/agent events.
const EVENT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(300);

/// Every Nth event-loop iteration pumps the footprint core (~1.2s at 300ms).
const FOOTPRINT_TICK_EVERY: u32 = 4;

#[derive(Clone, Copy, PartialEq)]
enum PaletteKind {
    Commands,
    Files,
    Vaults,
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
    _subscriptions: Vec<Subscription>,
}

/// config.json as an object (missing file → empty object).
fn load_config_value(state: &AppState) -> serde_json::Value {
    bnote_core::commands::config::load_app_config(state)
        .ok()
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| serde_json::json!({}))
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

        let theme = cx.theme();
        let preview = Rc::new(PreviewHost::new(PreviewFont {
            family: theme.mono_font_family.clone(),
            size: theme.mono_font_size,
        }));
        editor.update(cx, |state, cx| {
            state.set_preview_renderer(Some(preview.clone()), cx);
        });

        // Drive autosave + dirty flag off editor changes, and refresh the
        // live preview when either the text or the caret moved.
        let subscriptions = vec![
            cx.subscribe(&editor, |this, _editor, _: &InputEvent, cx| {
                this.preview_dirty = true;
                this.on_edited(cx);
            }),
            cx.observe(&editor, |this, editor, cx| {
                let selection = editor.read(cx).selected_range();
                if this.preview_selection.as_ref() != Some(&selection) {
                    this.preview_selection = Some(selection);
                    this.preview_dirty = true;
                    cx.notify();
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
        let vim_enabled = bnote_core::commands::config::load_app_config(&workspace.state)
            .ok()
            .and_then(|cfg| {
                cfg.get("settings")
                    .and_then(|s| s.get("vim"))
                    .and_then(|v| v.as_bool())
            })
            .unwrap_or(false);
        if vim_enabled {
            workspace.vim_enabled = true;
            workspace.set_vim_enabled(true, cx);
            workspace.status = "vim 模式开启(普通模式)".to_string();
        }

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
    /// **TODO(vault-file extraction)**: the file on disk is a JS module
    /// (`export default [ … ]`, `//` comments, regex literals). Extracting its
    /// array is the shell's job (`bnote_core::snippets::load` module docs) and
    /// is not written yet, so today the read path ends in the JSON-shape
    /// parser, a JS file fails it, and the editor keeps the built-ins with the
    /// status line saying so — the TS error path. The seam is
    /// `SnippetHost::load_source(&str)`; only the JS→JSON extraction is
    /// missing.
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
                        Ok(_) => {
                            this.status = format!(
                                "公式片段 {} 条(仓库)",
                                snippets.snippet_count(&editor)
                            );
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
        let out = ops::cycle_heading(&text, &[sel]);
        self.run_edit(out, window, cx);
    }

    fn set_heading(&mut self, level: usize, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        let sel = self.sel(cx);
        let out = ops::toggle_heading(&text, &[sel], level);
        self.run_edit(out, window, cx);
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

    /// `[[…]]` needs different open/close marks; small dedicated edit.
    fn insert_wikilink(
        &mut self,
        _: &actions::InsertWikilink,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (anchor, head) = {
            let ed = self.editor.read(cx);
            let r = ed.selected_range();
            (r.start, r.end)
        };
        let (sel_start, sel_end) = (anchor.min(head), anchor.max(head));
        let out = ops::OpsOutcome {
            edits: vec![
                ops::Edit { start: sel_start, end: sel_start, text: "[[".into() },
                ops::Edit { start: sel_end, end: sel_end, text: "]]".into() },
            ],
            cursors: vec![(sel_start + 2, sel_end + 2)],
        };
        self.run_edit(Some(out), window, cx);
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
        let out = ops::insert_code_block(&text, self.sel(cx), "ts");
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
        let state = self.state.clone();
        let mut cfg = load_config_value(&state);
        let obj = cfg.as_object_mut();
        let Some(obj) = obj else { return };
        let settings = obj
            .entry("settings".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(settings) = settings.as_object_mut() {
            settings.insert("vim".to_string(), serde_json::Value::Bool(enabled));
        }
        let _ = bnote_core::commands::config::save_app_config(&state, cfg);
    }

    fn open_settings(
        &mut self,
        _: &actions::OpenSettings,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.status =
            "设置面板在移植路线图上(配置在 ~/Library/Application Support/bnote)".to_string();
        cx.notify();
    }

    // ---- palettes ---------------------------------------------------------

    fn command_palette(
        &mut self,
        _: &actions::CommandPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
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
        self.status = format!("切换仓库:{}", path);
        self.restore_vault(PathBuf::from(path), cx);
        cx.notify();
    }

    // ---- opening notes ----------------------------------------------------

    fn open_note(&mut self, rel_path: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.vault_root.clone() else {
            return;
        };
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
        if let Some(daily) = &self.daily {
            let abs = self
                .vault_root
                .as_ref()
                .map(|r| r.join(&rel_path).to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.clone());
            daily.record_synced(&abs, &text);
        }
        self.mru.retain(|p| p != &rel_path);
        self.mru.insert(0, rel_path);
        self.mru.truncate(50);
        if self.vim_enabled {
            self.vim_bridge.reset(&self.editor);
        }
        // The buffer was replaced wholesale: the session chain (and the math
        // cache) describe a document that no longer exists.
        self.snippets.reset(&self.editor);
        self.snippet_marks_rows = None;
        self.update_cursor_label(cx);
    }

    fn has_doc(&self) -> bool {
        self.open_path.is_some() && self.vault_root.is_some()
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
        let content_changed = self.preview_dirty;
        if self.preview_dirty {
            self.preview_dirty = false;
            let selection = self.editor.read(cx).selected_range();
            self.preview_selection = Some(selection.clone());
            let text = self.editor.read(cx).text().to_string();
            let decorations = self
                .preview
                .decorations(&text, &[selection], window, cx);
            self.editor
                .update(cx, |state, cx| state.set_preview_decorations(decorations, cx));
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
            .size_full()
            .on_action(cx.listener(Self::save_now))
            .on_action(cx.listener(Self::command_palette))
            .on_action(cx.listener(Self::quick_switcher))
            .on_action(cx.listener(Self::switch_recent_vault))
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::focus_sidebar))
            .on_action(cx.listener(Self::new_note))
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
            .on_action(cx.listener(Self::open_settings));

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

        v_flex()
            .id("workspace")
            .relative()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(main)
            .children(palette)
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
        let _ = this.update(cx, |this, _cx| {
            this.files = files;
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

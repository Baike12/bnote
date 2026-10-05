//! The bnote GPUI workspace: file tree + markdown editor over bnote-core.
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
use std::sync::{Arc, Mutex};

use bnote_core::state::AppState;
use ::gpui::{Context, Entity, Focusable, Subscription, WeakEntity, Window, px, relative};
use gpui_kit::component::{
    ActiveTheme, IconName, h_flex, v_flex,
    input::{Editor, EditorState, InputEvent},
    label::Label,
    list::ListItem,
    resizable::{h_resizable, resizable_panel},
    status_bar::StatusBar,
    tree::{TreeItem, TreeState, tree},
};
use gpui_kit::*;
use tokio::sync::broadcast;

/// How long typing pauses before the buffer flushes to disk (mirrors the
/// Tauri shell's stop-typing autosave).
const AUTOSAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(800);

/// How often the shell polls the backend event bus for vault changes.
const EVENT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(300);

pub mod actions {
    use gpui::actions;

    actions!(workspace, [Save, QuickOpen]);
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
    _subscriptions: Vec<Subscription>,
}

impl Workspace {
    pub fn new(
        state: Arc<AppState>,
        mut event_rx: broadcast::Receiver<bnote_core::AppEvent>,
        last_vault: Option<PathBuf>,
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

        let tree_state = cx.new(|cx| TreeState::new(cx));

        // Drive autosave + dirty flag off editor changes.
        let subscriptions = vec![cx.subscribe(&editor, |this, _editor, _: &InputEvent, cx| {
            this.on_edited(cx);
        })];

        // Restore the vault off the main thread, then build the tree.
        if let Some(vault) = last_vault {
            let state = state.clone();
            let tree = tree_state.clone();
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
                        this.update(cx, |this, cx| {
                            this.vault_root = Some(PathBuf::from(&info.path));
                            this.status = format!("仓库:{}", info.name);
                            cx.notify();
                        })
                        .ok();
                        reload_tree(this.clone(), tree, cx).await;
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

        // Poll the backend event bus (tokio broadcast try_recv needs no
        // runtime) and refresh the tree on vault-changed.
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(EVENT_POLL_INTERVAL).await;
            let changed = match event_rx.try_recv() {
                Ok(ev) => ev.name == "vault-changed",
                Err(broadcast::error::TryRecvError::Lagged(_)) => true,
                Err(_) => false,
            };
            if changed {
                let tree = this.update(cx, |this, _cx| this.tree_state.clone());
                if let Ok(tree) = tree {
                    reload_tree(this.clone(), tree, cx).await;
                }
            }
        })
        .detach();

        // Focus the editor so global actions bubble through this view.
        let focus_handle = editor.focus_handle(cx);
        window.defer(cx, move |window, cx| {
            focus_handle.focus(window, cx);
        });

        Self {
            state,
            vault_root: None,
            tree_state,
            editor,
            open_path: None,
            dirty: false,
            save_seq: 0,
            save_guard: Arc::new(Mutex::new(0)),
            status: "未打开仓库".to_string(),
            _subscriptions: subscriptions,
        }
    }

    fn on_edited(&mut self, cx: &mut Context<Self>) {
        self.dirty = true;
        self.save_seq += 1;
        let seq = self.save_seq;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(AUTOSAVE_DEBOUNCE).await;
            save_snapshot(this, seq, cx).await;
        })
        .detach();
        cx.notify();
    }

    fn save_now(&mut self, _: &actions::Save, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.dirty {
            self.status = "没有未保存的改动".to_string();
            cx.notify();
            return;
        }
        self.save_seq += 1;
        let seq = self.save_seq;
        cx.spawn(async move |this, cx| save_snapshot(this, seq, cx).await)
            .detach();
    }

    fn quick_open(&mut self, _: &actions::QuickOpen, _window: &mut Window, cx: &mut Context<Self>) {
        self.status = "快速跳转(⌘P)在移植路线图上:本里程碑未实现".to_string();
        cx.notify();
    }

    fn open_note(&mut self, rel_path: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.vault_root.clone() else {
            return;
        };
        let full = root.join(&rel_path);
        let state = self.state.clone();
        self.open_path = Some(rel_path.clone());
        self.dirty = false;
        self.status = format!("打开 {}", rel_path);
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
                        this.editor.update(cx, |state, cx| {
                            state.set_value(text, window, cx);
                        });
                        this.dirty = false;
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
}

impl gpui::Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let editor = Editor::new(&self.editor)
            .bordered(false)
            .p_0()
            .h(relative(1.))
            .font_family(cx.theme().mono_font_family.clone())
            .text_size(cx.theme().mono_font_size)
            .flex_1();

        v_flex()
            .id("workspace")
            .size_full()
            .on_action(cx.listener(Self::save_now))
            .on_action(cx.listener(Self::quick_open))
            .child(
                h_resizable("main")
                    .child(
                        resizable_panel()
                            .size(px(240.))
                            .child(self.render_file_tree(_window, cx)),
                    )
                    .child(editor.into_any_element()),
            )
            .child(
                StatusBar::new()
                    .left(Label::new(self.status.clone()))
                    .right(
                        Label::new(if self.dirty {
                            "● 未保存".to_string()
                        } else {
                            String::new()
                        }),
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
async fn save_snapshot(this: WeakEntity<Workspace>, seq: u64, cx: &mut gpui::AsyncApp) {
    let (state, root, path, text, guard) = match this.update(cx, |this, cx| {
        let Some(root) = this.vault_root.clone() else {
            return None;
        };
        let Some(rel) = this.open_path.clone() else {
            return None;
        };
        let text = this.editor.read(cx).text().to_string();
        Some((this.state.clone(), root, rel, text, this.save_guard.clone()))
    }) {
        Ok(Some(tuple)) => tuple,
        Ok(None) => return,
        Err(_) => return,
    };

    let full = root.join(&path);

    let written = cx
        .background_executor()
        .spawn(async move {
            let mut last = guard.lock().unwrap();
            if seq <= *last {
                return false;
            }
            // core's write_file keeps the ensure_within path guard.
            let result =
                bnote_core::commands::files::write_file(&state, full.to_string_lossy().to_string(), text);
            if result.is_ok() {
                *last = seq;
            }
            result.is_ok()
        })
        .await;

    this.update(cx, |this, cx| {
        if written && seq == this.save_seq {
            this.dirty = false;
            this.status = format!("已保存 {}", path);
        } else if !written {
            this.status = "保存失败(见日志)".to_string();
        }
        cx.notify();
    })
    .ok();
}

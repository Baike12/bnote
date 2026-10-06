//! The python type-check follow (ty): port of `src/python/lsp.ts`.
//!
//! Shape, mirroring the TS module:
//!
//! - every edit (after the workspace's 500 ms quiet period) pushes the
//!   *virtual file* (all python fences, line-aligned — `bnote_core::python::extract`)
//!   to ty; the text only goes out when it changed, so prose typing never
//!   pokes the server;
//! - ty's diagnostics land on the editor through the kit's own
//!   `DiagnosticSet` (wavy underline + popover), mapped fence-aware and with
//!   LSP's UTF-16 columns converted to the editor's scalar columns;
//! - completion and hover answer through the editor's LSP provider hooks with
//!   the TS sources' gates (fences only, word / dot or an explicit request,
//!   the failure backoff);
//! - a project whose `lsp` is `"off"` (or a failing server) is left alone —
//!   the note joins the off list and only the toggle clears it; failures back
//!   off for 30 s instead of erroring every tick.
//!
//! [`PyLspServices`] is the seam (see `ime_host`): `main` injects the core
//! commands, tests inject doubles — a test must never spawn `ty`.

use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bnote_core::python::extract::{self, LineIndex, PythonExtract};
use bnote_core::state::AppState;
use gpui::{App, Context, SharedString, Task, WeakEntity};
use gpui_kit::base::input::{
    CompletionProvider, Diagnostic, DiagnosticSeverity, HoverProvider, Position, Rope,
};
use lsp_types::{CompletionContext, CompletionResponse, Hover};

/// TS `SYNC_DEBOUNCE_MS`: the workspace's quiet period before a sync tick.
pub const SYNC_DEBOUNCE: Duration = Duration::from_millis(500);
/// TS `SYNC_FAILURE_BACKOFF_MS`.
pub const SYNC_FAILURE_BACKOFF: Duration = Duration::from_secs(30);

/// The core commands the follow needs, injected at the composition root.
#[derive(Clone)]
pub struct PyLspServices {
    /// `python_lsp_sync` → `enabled` (false = the project's LSP is off).
    pub sync: Rc<dyn Fn(&Arc<AppState>, String, String, &mut App) -> Task<Result<bool, String>>>,
    /// `python_lsp_request` (the core whitelists completion / hover).
    #[allow(clippy::type_complexity)]
    pub request: Rc<
        dyn Fn(
            &Arc<AppState>,
            String,
            String,
            serde_json::Value,
            &mut App,
        ) -> Task<Result<serde_json::Value, String>>,
    >,
    /// `python_lsp_close`.
    pub close: Rc<dyn Fn(&Arc<AppState>, String, &mut App) -> Task<()>>,
    /// `python_get_info` (the toggle reads the project's current mode).
    pub info:
        Rc<dyn Fn(&Arc<AppState>, String, &mut App) -> Task<Result<serde_json::Value, String>>>,
    /// `python_set_project_config` with only the `lsp` field.
    pub set_lsp:
        Rc<dyn Fn(&Arc<AppState>, String, Option<String>, &mut App) -> Task<Result<(), String>>>,
    /// `python_uv_create`.
    #[allow(clippy::type_complexity)]
    pub uv_create: Rc<
        dyn Fn(
            &Arc<AppState>,
            String,
            &mut App,
        ) -> Task<Result<bnote_core::python::uvenv::UvOutcome, String>>,
    >,
}

impl PyLspServices {
    /// The real thing: every call is the core command on the background
    /// executor (the core entry blocks on its own tokio runtime).
    pub fn platform() -> Self {
        Self {
            sync: Rc::new(|state: &Arc<AppState>, md_path, text, cx| {
                let state = state.clone();
                cx.background_executor().spawn(async move {
                    bnote_core::commands::python::python_lsp_sync(&state, md_path, text)
                        .map(|r| r.enabled)
                })
            }),
            request: Rc::new(|state: &Arc<AppState>, md_path, method, params, cx| {
                let state = state.clone();
                cx.background_executor().spawn(async move {
                    bnote_core::commands::python::python_lsp_request(&state, md_path, method, params)
                })
            }),
            close: Rc::new(|state: &Arc<AppState>, md_path, cx| {
                let state = state.clone();
                cx.background_executor().spawn(async move {
                    let _ = bnote_core::commands::python::python_lsp_close(&state, md_path);
                })
            }),
            info: Rc::new(|state: &Arc<AppState>, md_path, cx| {
                let state = state.clone();
                cx.background_executor().spawn(async move {
                    bnote_core::commands::python::python_get_info(&state, md_path)
                        .and_then(|info| serde_json::to_value(info).map_err(|e| e.to_string()))
                })
            }),
            set_lsp: Rc::new(|state: &Arc<AppState>, md_path, lsp, cx| {
                let state = state.clone();
                cx.background_executor().spawn(async move {
                    bnote_core::commands::python::python_set_project_config(
                        &state, md_path, lsp, None, None,
                    )
                    .map(|_| ())
                })
            }),
            uv_create: Rc::new(|state: &Arc<AppState>, md_path, cx| {
                let state = state.clone();
                cx.background_executor().spawn(async move {
                    bnote_core::commands::python::python_uv_create(&state, md_path)
                })
            }),
        }
    }
}

/// The follow's state (TS keeps the same facts in its maps plus module-level
/// timers; the debounce itself lives in the workspace, which owns the editor).
pub struct PyLspHost {
    state: Arc<AppState>,
    services: PyLspServices,
    /// The open note; a switch resets everything below.
    path: Option<String>,
    /// The virtual text last sent (dedup: unchanged text is never resent).
    last_sent: Option<String>,
    /// A push is in flight for this text (the TS pre-记账 dedup).
    in_flight: Option<String>,
    /// The note's project has no live server (off, or the sync failed).
    off: bool,
    /// Failure backoff deadline (TS 30 s).
    backoff_until: Option<Instant>,
    /// ty's latest raw diagnostics for the open note.
    raw: Vec<serde_json::Value>,
    /// The last extract (text + virtual file + line index), shared by the sync
    /// tick and the interaction requests: one scan per document version, like
    /// the TS `extractCache`.
    cache: Option<(String, PythonExtract, LineIndex)>,
}

impl PyLspHost {
    pub fn new(state: Arc<AppState>, services: PyLspServices) -> Self {
        Self {
            state,
            services,
            path: None,
            last_sent: None,
            in_flight: None,
            off: false,
            backoff_until: None,
            raw: Vec::new(),
            cache: None,
        }
    }

    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    pub fn services(&self) -> &PyLspServices {
        &self.services
    }

    pub fn app_state(&self) -> &Arc<AppState> {
        &self.state
    }

    /// Whether ty has published anything for the open note (the tests' window
    /// into the state machine).
    #[cfg(test)]
    pub fn has_raw(&self) -> bool {
        !self.raw.is_empty()
    }

    /// TS `syncFromView`'s file-switch arm: a different note resets the sync
    /// bookkeeping (its diagnostics arrive per note, keyed by path).
    pub fn set_path(&mut self, path: Option<String>, cx: &mut Context<Self>) {
        if self.path == path {
            return;
        }
        self.path = path;
        self.last_sent = None;
        self.in_flight = None;
        self.off = false;
        self.raw.clear();
        self.cache = None;
        cx.notify();
    }

    /// The extract for `text`, reused while the text is unchanged (the TS
    /// `cachedExtract`).
    fn ensure_extract(&mut self, text: &str) {
        let hit = matches!(&self.cache, Some((cached, _, _)) if cached == text);
        if !hit {
            let eff = extract::extract_python(text);
            self.cache = Some((text.to_string(), eff, LineIndex::new(text)));
        }
    }

    /// One debounce tick (the workspace's quiet-period timer): decide whether
    /// ty needs to hear about this document at all.
    pub fn sync_now(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(path) = self.path.clone() else {
            return;
        };
        if self.off || self.backoff_active() {
            return;
        }
        if !extract::has_python_fence_hint(text) {
            self.clear(cx);
            return;
        }
        self.ensure_extract(text);
        let (effective, empty) = {
            let (_, eff, _) = self.cache.as_ref().expect("just filled");
            (eff.effective_text.clone(), eff.blocks.is_empty())
        };
        if empty {
            self.clear(cx);
            return;
        }
        if self.last_sent.as_deref() == Some(effective.as_str())
            || self.in_flight.as_deref() == Some(effective.as_str())
        {
            return;
        }
        self.push(path, effective, cx);
    }

    /// Push the virtual text to ty (TS `pushVirtualText`): the account is
    /// written *before* the call and rolled back on failure.
    fn push(&mut self, path: String, text: String, cx: &mut Context<Self>) {
        self.in_flight = Some(text.clone());
        let state = self.state.clone();
        let push = (self.services.sync)(&state, path, text.clone(), cx);
        cx.spawn(async move |this, cx| {
            let outcome = push.await;
            this.update(cx, |host, cx| host.finish_push(text, outcome, cx)).ok();
        })
        .detach();
    }

    /// The shared tail of every push: the account, the off latch and the
    /// backoff all settle the same way (`ensure_synced` reports the error to
    /// its own caller afterwards).
    fn finish_push(&mut self, text: String, outcome: Result<bool, String>, cx: &mut Context<Self>) {
        if self.in_flight.as_deref() == Some(text.as_str()) {
            self.in_flight = None;
        }
        match outcome {
            Ok(true) => {
                self.last_sent = Some(text);
                self.backoff_until = None;
            }
            Ok(false) => {
                // The project's LSP is off: stop poking until the toggle
                // resets the note.
                self.off = true;
                self.last_sent = None;
                self.raw.clear();
                cx.notify();
            }
            Err(_) => {
                self.last_sent = None;
                if !self.backoff_active() {
                    self.backoff_until = Some(Instant::now() + SYNC_FAILURE_BACKOFF);
                }
            }
        }
    }

    /// TS `clearPath`: the note has nothing for ty (or lost its fences).
    fn clear(&mut self, cx: &mut Context<Self>) {
        if self.last_sent.is_none() && self.raw.is_empty() {
            return;
        }
        self.last_sent = None;
        self.raw.clear();
        if let Some(path) = self.path.clone() {
            let state = self.state.clone();
            (self.services.close)(&state, path, cx).detach();
        }
        cx.notify();
    }

    fn backoff_active(&self) -> bool {
        self.backoff_until
            .map(|deadline| Instant::now() < deadline)
            .unwrap_or(false)
    }

    /// A `python-lsp-diagnostics` event (for any note; only the open one's
    /// diagnostics are kept).
    pub fn set_raw(
        &mut self,
        path: &str,
        diagnostics: Vec<serde_json::Value>,
        cx: &mut Context<Self>,
    ) {
        if self.path.as_deref() != Some(path) {
            return; // another note's diagnostics
        }
        self.raw = diagnostics;
        cx.notify();
    }

    /// The raw diagnostics mapped to the kit's per-document `Diagnostic`s,
    /// with the TS drop rules: an entry whose lines fall outside the document
    /// (the synthesized `__main__` guard, a stale range) is dropped, and a
    /// range is normalized to `start <= end`.
    pub fn diagnostics(&mut self, text: &str) -> Vec<Diagnostic> {
        self.ensure_extract(text);
        let Some((_, _, index)) = self.cache.as_ref() else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(self.raw.len());
        for raw in &self.raw {
            let Some(range) = raw.get("range") else { continue };
            let (Some(start), Some(end)) =
                (parse_lsp_point(range.get("start")), parse_lsp_point(range.get("end")))
            else {
                continue;
            };
            let (Some(start), Some(end)) = (
                lsp_point_to_editor(index, text, start),
                lsp_point_to_editor(index, text, end),
            ) else {
                continue;
            };
            let (start, end) = if start <= end { (start, end) } else { (end, start) };
            let severity = match raw.get("severity").and_then(|v| v.as_u64()) {
                Some(2) => DiagnosticSeverity::Warning,
                Some(3) => DiagnosticSeverity::Info,
                Some(4) => DiagnosticSeverity::Hint,
                _ => DiagnosticSeverity::Error,
            };
            let message = raw.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut diagnostic = Diagnostic::new(
                Position::new(start.0, start.1)..Position::new(end.0, end.1),
                message,
            )
            .with_severity(severity);
            let source = raw
                .get("source")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("ty");
            diagnostic = diagnostic.with_source(source);
            if let Some(code) = raw.get("code").and_then(code_of) {
                diagnostic = diagnostic.with_code(code);
            }
            out.push(diagnostic);
        }
        out
    }

    /// TS `toggle-lsp` + `resetLspStateForPath`: flip the project's mode, drop
    /// the sync bookkeeping, clear the note's diagnostics, close the doc, and
    /// (turning it on) push the current text right away.
    pub fn toggle_lsp(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(path) = self.path.clone() else {
            return;
        };
        self.off = false;
        self.last_sent = None;
        self.in_flight = None;
        self.backoff_until = None;
        self.raw.clear();
        cx.notify();

        let state = self.state.clone();
        let info = (self.services.info)(&state, path.clone(), cx);
        cx.spawn(async move |this, cx| {
            let current = info.await.ok();
            let was_enabled = current
                .as_ref()
                .and_then(|info| info.get("lsp").and_then(|v| v.as_str()))
                .map(|mode| mode == "ty")
                .unwrap_or(false);
            let next = if was_enabled { "" } else { "ty" }.to_string();
            // The seam calls are created on the main thread (they spawn the
            // core work); only the awaits happen here.
            let update_task = this
                .update(cx, |host, cx| {
                    let state = host.app_state().clone();
                    (host.services().set_lsp)(&state, path.clone(), Some(next), cx)
                })
                .ok();
            let Some(update_task) = update_task else { return };
            let updated = update_task.await.is_ok();
            let close_task = this
                .update(cx, |host, cx| {
                    let state = host.app_state().clone();
                    (host.services().close)(&state, path.clone(), cx)
                })
                .ok();
            if let Some(close_task) = close_task {
                close_task.detach();
            }
            this.update(cx, |host, cx| {
                // Turning it *off* keeps the note quiet; turning it on pushes
                // the text we already have (TS `syncNow` after the config).
                host.off = was_enabled || !updated;
                host.last_sent = None;
                if !host.off {
                    host.sync_now(&text, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The interaction gate (TS `prepareLsp`'s first half): a request may go
    /// out only with an open note whose cursor sits inside a python fence, the
    /// project's LSP live, and no backoff running.
    fn request_ready(&mut self, text: &str, offset: usize) -> Option<(String, (u32, u32), String)> {
        let path = self.path.clone()?;
        if self.off || self.backoff_active() || !extract::has_python_fence_hint(text) {
            return None;
        }
        self.ensure_extract(text);
        let (_, eff, index) = self.cache.as_ref()?;
        if eff.blocks.is_empty() {
            return None;
        }
        let position = extract::md_offset_to_lsp_position(text, index, eff, offset)?;
        Some((path, position, eff.effective_text.clone()))
    }

    /// TS `prepareLsp`'s second half: ty must hold the current virtual file
    /// before an interaction request refers to it.
    fn ensure_synced(
        &mut self,
        path: &str,
        effective: String,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        if self.last_sent.as_deref() == Some(effective.as_str()) {
            return Task::ready(Ok(()));
        }
        if self.in_flight.as_deref() == Some(effective.as_str()) {
            // A push for this very text is already on its way; the request can
            // follow it (the server processes didChange before the request).
            return Task::ready(Ok(()));
        }
        self.in_flight = Some(effective.clone());
        let state = self.state.clone();
        let push = (self.services.sync)(&state, path.to_string(), effective.clone(), cx);
        cx.spawn(async move |this, cx| {
            let outcome = push.await;
            let failed = outcome.as_ref().err().cloned();
            this.update(cx, |host, cx| host.finish_push(effective, outcome, cx)).ok();
            match failed {
                Some(e) => Err(e),
                None => Ok(()),
            }
        })
    }
}

fn code_of(code: &serde_json::Value) -> Option<SharedString> {
    match code {
        serde_json::Value::String(s) => Some(SharedString::from(s.clone())),
        serde_json::Value::Object(o) => o
            .get("value")
            .and_then(|v| v.as_str())
            .map(|s| SharedString::from(s.to_string())),
        _ => None,
    }
}

fn parse_lsp_point(value: Option<&serde_json::Value>) -> Option<(u32, u32)> {
    let value = value?;
    let line = value.get("line")?.as_u64()? as u32;
    let character = value.get("character")?.as_u64()? as u32;
    Some((line, character))
}

/// An LSP point (UTF-16 columns) → the editor's `Position` (scalar columns).
/// The kit counts Unicode scalars, LSP counts UTF-16 units, so astral
/// characters would otherwise shift every column after them.
fn lsp_point_to_editor(
    index: &LineIndex,
    text: &str,
    (line, utf16): (u32, u32),
) -> Option<(u32, u32)> {
    if line as usize >= index.line_count() {
        return None;
    }
    let char_col = index.utf16_col_to_char_col(text, line as usize, utf16 as usize)?;
    Some((line, char_col as u32))
}

// ---------------------------------------------------------------------------
// 补全 / hover:编辑器的 LSP 钩子(TS 里是 CM6 的 completionSource / hoverTooltip)
// ---------------------------------------------------------------------------

/// `textDocument/completion`, gated exactly like the TS source: only inside a
/// python fence, and only for a word character, a dot, or an explicit request
/// (Ctrl-Space).
pub struct PyCompletionProvider {
    pub host: WeakEntity<PyLspHost>,
}

impl CompletionProvider for PyCompletionProvider {
    fn completions(
        &self,
        text: &Rope,
        offset: usize,
        trigger: CompletionContext,
        _window: &mut gpui::Window,
        cx: &mut App,
    ) -> Task<anyhow::Result<CompletionResponse>> {
        let doc = text.to_string();
        // 三种入口:词中续打、点号后补属性、显式 Ctrl-Space。散文里的 CJK
        // 击键在第一个门就出去,不做全文提取。
        let head = &doc[..offset.min(doc.len())];
        let word = head
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .count()
            > 0;
        let dot = head.ends_with('.');
        if !word && !dot && trigger.trigger_kind != lsp_types::CompletionTriggerKind::INVOKED {
            return Task::ready(Ok(CompletionResponse::Array(vec![])));
        }

        let prepared = self.host.update(cx, |host, _| host.request_ready(&doc, offset));
        let Ok(Some((path, position, effective))) = prepared else {
            return Task::ready(Ok(CompletionResponse::Array(vec![])));
        };
        let synced = self
            .host
            .update(cx, |host, cx| host.ensure_synced(&path, effective, cx))
            .unwrap_or_else(|_| Task::ready(Ok(())));
        let weak = self.host.clone();
        let method = "textDocument/completion".to_string();
        cx.spawn(async move |cx| {
            if synced.await.is_err() {
                return Ok(CompletionResponse::Array(vec![]));
            }
            let params = serde_json::json!({
                "position": { "line": position.0, "character": position.1 },
            });
            let request = weak
                .update(cx, |host, cx| {
                    let state = host.app_state().clone();
                    (host.services().request)(&state, path.clone(), method, params, cx)
                })
                .ok();
            let Some(request) = request else {
                return Ok(CompletionResponse::Array(vec![]));
            };
            let raw = request.await.map_err(|e| anyhow::anyhow!(e))?;
            // 过期自证:等待期间换了笔记,结果对当前视图无意义(ty 随后一次
            // didChange 会重新发布)。
            let still_open = weak
                .read_with(cx, |host, _| host.path.as_deref() == Some(path.as_str()))
                .unwrap_or(false);
            if !still_open || raw.is_null() {
                return Ok(CompletionResponse::Array(vec![]));
            }
            Ok(serde_json::from_value::<CompletionResponse>(raw)
                .unwrap_or(CompletionResponse::Array(vec![])))
        })
    }

    /// The cheap gate the kit asks before it even builds a completion context:
    /// the same characters the TS source accepts as triggers (a word character
    /// or a dot); everything else — prose, CJK, whitespace — never reaches the
    /// provider.
    fn is_completion_trigger(&self, _offset: usize, new_text: &str, _cx: &mut App) -> bool {
        !new_text.is_empty()
            && new_text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
    }
}

/// `textDocument/hover`: ty's text, anchored one character left of the cursor
/// (TS `pythonHoverSource`'s `side < 0` arm).
pub struct PyHoverProvider {
    pub host: WeakEntity<PyLspHost>,
}

impl HoverProvider for PyHoverProvider {
    fn hover(
        &self,
        text: &Rope,
        offset: usize,
        _window: &mut gpui::Window,
        cx: &mut App,
    ) -> Task<anyhow::Result<Option<Hover>>> {
        let doc = text.to_string();
        let anchor = offset.saturating_sub(1);
        let prepared = self.host.update(cx, |host, _| host.request_ready(&doc, anchor));
        let Ok(Some((path, position, effective))) = prepared else {
            return Task::ready(Ok(None));
        };
        let synced = self
            .host
            .update(cx, |host, cx| host.ensure_synced(&path, effective, cx))
            .unwrap_or_else(|_| Task::ready(Ok(())));
        let weak = self.host.clone();
        let method = "textDocument/hover".to_string();
        cx.spawn(async move |cx| {
            if synced.await.is_err() {
                return Ok(None);
            }
            let params = serde_json::json!({
                "position": { "line": position.0, "character": position.1 },
            });
            let request = weak
                .update(cx, |host, cx| {
                    let state = host.app_state().clone();
                    (host.services().request)(&state, path.clone(), method, params, cx)
                })
                .ok();
            let Some(request) = request else { return Ok(None) };
            let raw = request.await.map_err(|e| anyhow::anyhow!(e))?;
            let still_open = weak
                .read_with(cx, |host, _| host.path.as_deref() == Some(path.as_str()))
                .unwrap_or(false);
            if !still_open || raw.is_null() {
                return Ok(None);
            }
            Ok(serde_json::from_value::<Hover>(raw).ok())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    type Log = Rc<RefCell<Vec<String>>>;

    /// A host whose services record calls and never touch a process; `sync`
    /// answers with the project's mode, `info` reports it too.
    /// `lsp_mode` is what `python_get_info` reports (the project's configured
    /// mode); `sync_enabled` is what `python_lsp_sync` answers — a project the
    /// user just turned on reports `off` to the toggle while the following sync
    /// already sees the live server.
    fn harness(
        cx: &mut gpui::TestAppContext,
        lsp_mode: &'static str,
        sync_enabled: bool,
        sync_error: bool,
    ) -> (gpui::Entity<PyLspHost>, Log) {
        let (state, _rx) = AppState::new(std::env::temp_dir().join("bnote-py-lsp-test"));
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        let recorded = log.clone();
        let services = PyLspServices {
            sync: Rc::new(move |_state, path, text, _cx| {
                recorded.borrow_mut().push(format!("sync {path} {:?}", text));
                let outcome = if sync_error {
                    Err("boom".to_string())
                } else {
                    Ok(sync_enabled)
                };
                Task::ready(outcome)
            }),
            request: {
                let recorded = log.clone();
                Rc::new(move |_state, _path, method, params, _cx| {
                    recorded.borrow_mut().push(format!("request {method} {params}"));
                    Task::ready(Ok(serde_json::Value::Null))
                })
            },
            close: {
                let recorded = log.clone();
                Rc::new(move |_state, path, _cx| {
                    recorded.borrow_mut().push(format!("close {path}"));
                    Task::ready(())
                })
            },
            info: Rc::new(move |_state, _path, _cx| {
                Task::ready(Ok(serde_json::json!({ "lsp": lsp_mode })))
            }),
            set_lsp: {
                let recorded = log.clone();
                Rc::new(move |_state, path, lsp, _cx| {
                    recorded.borrow_mut().push(format!("set_lsp {path} {lsp:?}"));
                    Task::ready(Ok(()))
                })
            },
            uv_create: Rc::new(|_state, _path, _cx| {
                Task::ready(Ok(bnote_core::python::uvenv::UvOutcome {
                    log: "log".to_string(),
                    ran_init: false,
                }))
            }),
            // (the toggle test's `info` reports "off" while `sync` answers
            // `lsp_enabled`, mirroring a project the user just turned on)
        };
        let host = cx.update(|cx| {
            use gpui::AppContext as _;
            cx.new(|_| PyLspHost::new(state, services))
        });
        (host, log)
    }

    fn fence_doc() -> String {
        "# 标题\n\n```python\nx: int = 1\n```\n".to_string()
    }

    fn settle(cx: &mut gpui::TestAppContext) {
        cx.run_until_parked();
        cx.run_until_parked();
    }

    /// The fence gate and the dedup: prose-only text never reaches ty, and an
    /// unchanged virtual file is not resent.
    #[gpui::test]
    fn sync_sends_the_virtual_file_once_per_change(cx: &mut gpui::TestAppContext) {
        let (host, log) = harness(cx, "ty", true, false);
        host.update(cx, |host, cx| host.set_path(Some("/v/n.md".to_string()), cx));

        let doc = fence_doc();
        host.update(cx, |host, cx| host.sync_now(&doc, cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 1, "{:?}", log.borrow());

        // Same document: the virtual file did not change, no resend.
        host.update(cx, |host, cx| host.sync_now(&doc, cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 1);

        // Prose edit outside the fence — same line count, so the line-aligned
        // virtual file is unchanged and ty hears nothing.
        let prose = doc.replace("# 标题", "# 改过");
        host.update(cx, |host, cx| host.sync_now(&prose, cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 1, "prose does not poke ty");
        // An edit that shifts lines does change the virtual file (the same
        // contract the TS has: line alignment is the whole point).
        let shifted = format!("# 新的一行\n{doc}");
        host.update(cx, |host, cx| host.sync_now(&shifted, cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 2, "inserting a line above re-sends");

        // Editing inside the fence does.
        let edited = doc.replace("x: int = 1", "x: int = 2");
        host.update(cx, |host, cx| host.sync_now(&edited, cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 3, "{:?}", log.borrow());
    }

    /// No fence (or no block) closes the doc instead of syncing it.
    #[gpui::test]
    fn a_document_without_python_fences_is_closed(cx: &mut gpui::TestAppContext) {
        let (host, log) = harness(cx, "ty", true, false);
        host.update(cx, |host, cx| host.set_path(Some("/v/n.md".to_string()), cx));

        let doc = fence_doc();
        host.update(cx, |host, cx| host.sync_now(&doc, cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 1);

        host.update(cx, |host, cx| host.sync_now("# 只剩散文\n", cx));
        settle(cx);
        assert_eq!(
            log.borrow().as_slice(),
            ["sync /v/n.md \"\\n\\n\\nx: int = 1\\n\\n\"", "close /v/n.md"],
            "losing the fences closes the doc (the payload is the virtual file)"
        );
    }

    /// `enabled: false` (the project's LSP is off) stops the note from poking
    /// the server on every edit; a failure backs off instead.
    #[gpui::test]
    fn the_off_and_backoff_latches_hold(cx: &mut gpui::TestAppContext) {
        let (host, log) = harness(cx, "off", false, false);
        host.update(cx, |host, cx| host.set_path(Some("/v/n.md".to_string()), cx));
        host.update(cx, |host, cx| host.sync_now(&fence_doc(), cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 1);
        host.update(cx, |host, cx| host.sync_now(&fence_doc().replace("1", "2"), cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 1, "off: no further sync calls");

        let (host, log) = harness(cx, "ty", true, true);
        host.update(cx, |host, cx| host.set_path(Some("/v/n.md".to_string()), cx));
        host.update(cx, |host, cx| host.sync_now(&fence_doc(), cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 1);
        host.update(cx, |host, cx| host.sync_now(&fence_doc().replace("1", "3"), cx));
        settle(cx);
        assert_eq!(log.borrow().len(), 1, "within the backoff window: no retry");
    }

    /// The request gate: outside a fence there is no position (so no request),
    /// and the cursor's column is the virtual file's, indent stripped.
    #[gpui::test]
    fn the_request_gate_needs_a_fence_and_a_live_project(cx: &mut gpui::TestAppContext) {
        let (host, _log) = harness(cx, "ty", true, false);
        let text = "- 项\n\n  ```python\n  for i in range(2):\n      print(i)\n  ```\n";
        host.update(cx, |host, cx| host.set_path(Some("/v/n.md".to_string()), cx));

        // 围栏内容行的列要剥掉围栏缩进:第 4 行 `      print(i)`(6 空格)减 2
        // 后,`print` 的 `p` 在虚拟文件的第 4 列。
        let at = text.find("print").expect("the line");
        let ready = host.update(cx, |host, _| host.request_ready(text, at));
        let position = ready.as_ref().map(|(_, position, _)| *position);
        assert_eq!(position, Some((4, 4)), "{ready:?}");
        // 行首(`for` 的 f)在虚拟文件里是第 0 列。
        let at = text.find("for i").expect("the line");
        let ready = host.update(cx, |host, _| host.request_ready(text, at));
        let position = ready.as_ref().map(|(_, position, _)| *position);
        assert_eq!(position, Some((3, 0)), "{ready:?}");

        // 围栏外(第 0 行)没有位置。
        let outside = host.update(cx, |host, _| host.request_ready(text, 1));
        assert!(outside.is_none(), "{outside:?}");

        // LSP 关着的项目:门直接不放行。
        let (host, _log) = harness(cx, "off", false, false);
        host.update(cx, |host, cx| host.set_path(Some("/v/n.md".to_string()), cx));
        host.update(cx, |host, cx| host.sync_now(&fence_doc(), cx));
        settle(cx);
        let off = host.update(cx, |host, _| host.request_ready(&fence_doc(), 20));
        assert!(off.is_none(), "off after the sync said so: {off:?}");
    }

    /// Diagnostics: the drop rules (out-of-range lines, missing ranges) and
    /// the UTF-16 → scalar column conversion.
    #[gpui::test]
    fn diagnostics_map_with_the_ts_drop_rules(cx: &mut gpui::TestAppContext) {
        let (host, _log) = harness(cx, "ty", true, false);
        let text = "# 标题\n```python\nx: int = \"hello\"\n```\n";
        host.update(cx, |host, cx| {
            host.set_path(Some("/v/n.md".to_string()), cx);
            host.set_raw(
                "/v/n.md",
                vec![
                    serde_json::json!({
                        "range": { "start": { "line": 2, "character": 9 }, "end": { "line": 2, "character": 16 } },
                        "severity": 2,
                        "message": "Type \"str\" is not assignable to \"int\"",
                        "code": "invalid-assignment",
                        "source": "ty",
                    }),
                    // 越界行(追加守卫区)→ 丢
                    serde_json::json!({ "range": { "start": { "line": 99, "character": 0 }, "end": { "line": 99, "character": 1 } }, "message": "ghost" }),
                    // 缺 range → 丢
                    serde_json::json!({ "message": "broken" }),
                    // end 在 start 之前 → 交换
                    serde_json::json!({ "range": { "start": { "line": 0, "character": 4 }, "end": { "line": 0, "character": 1 } }, "message": "m" }),
                    // code 为 LSP 3.17 对象形式
                    serde_json::json!({ "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }, "code": { "value": "E1" }, "message": "m" }),
                ],
                cx,
            );
        });
        let mapped = host.update(cx, |host, _| host.diagnostics(text));
        assert_eq!(mapped.len(), 3, "{mapped:?}");
        let first = &mapped[0];
        assert_eq!(first.range.start, Position::new(2, 9));
        assert_eq!(first.range.end, Position::new(2, 16));
        assert_eq!(first.severity, DiagnosticSeverity::Warning);
        assert_eq!(first.source.as_deref(), Some("ty"));
        assert_eq!(first.code.as_deref(), Some("invalid-assignment"));
        assert_eq!(mapped[1].range.start, Position::new(0, 1), "swapped");
        assert_eq!(mapped[1].range.end, Position::new(0, 4));
        assert_eq!(mapped[2].code.as_deref(), Some("E1"));

        // 代理对:emoji 之后按 UTF-16 收到的列要落回标量列。
        let text = "a🎉b = 1\n";
        host.update(cx, |host, cx| {
            host.set_raw(
                "/v/n.md",
                vec![serde_json::json!({
                    "range": { "start": { "line": 0, "character": 3 }, "end": { "line": 0, "character": 4 } },
                    "message": "after the emoji",
                })],
                cx,
            );
        });
        let mapped = host.update(cx, |host, _| host.diagnostics(text));
        assert_eq!(mapped[0].range.start, Position::new(0, 2), "utf16 col 3 = 标量列 2(a + 🎉)");
        assert_eq!(mapped[0].range.end, Position::new(0, 3));
    }

    /// The toggle flips the project's mode through the seam, resets the note's
    /// bookkeeping, and (turning it on) syncs right away.
    #[gpui::test]
    fn the_toggle_flips_the_project_mode_and_resets(cx: &mut gpui::TestAppContext) {
        // The project is off; the toggle turns ty on, and the sync that follows
        // already reaches a live server.
        let (host, log) = harness(cx, "off", true, false);
        host.update(cx, |host, cx| host.set_path(Some("/v/n.md".to_string()), cx));
        host.update(cx, |host, cx| {
            host.set_raw("/v/n.md", vec![serde_json::json!({ "message": "x" })], cx)
        });
        assert!(host.read_with(cx, |host, _| host.has_raw()));

        let doc = fence_doc();
        host.update(cx, |host, cx| host.toggle_lsp(doc, cx));
        settle(cx);
        let calls = log.borrow().clone();
        assert!(
            calls.iter().any(|call| call == "set_lsp /v/n.md Some(\"ty\")"),
            "off → ty: {calls:?}"
        );
        assert!(
            calls.iter().any(|call| call.starts_with("sync /v/n.md")),
            "enabling syncs the current text: {calls:?}"
        );
        assert!(!host.read_with(cx, |host, _| host.has_raw()), "diagnostics cleared");
    }

    /// A note switch resets the sync account: the same text on a different
    /// note is pushed again (ty keys documents by path).
    #[gpui::test]
    fn a_note_switch_resets_the_account(cx: &mut gpui::TestAppContext) {
        let (host, log) = harness(cx, "ty", true, false);
        let doc = fence_doc();
        host.update(cx, |host, cx| host.set_path(Some("/v/a.md".to_string()), cx));
        host.update(cx, |host, cx| host.sync_now(&doc, cx));
        settle(cx);
        host.update(cx, |host, cx| host.set_path(Some("/v/b.md".to_string()), cx));
        host.update(cx, |host, cx| host.sync_now(&doc, cx));
        settle(cx);
        assert_eq!(
            log.borrow().as_slice(),
            [
                "sync /v/a.md \"\\n\\n\\nx: int = 1\\n\\n\"",
                "sync /v/b.md \"\\n\\n\\nx: int = 1\\n\\n\"",
            ],
            "the same virtual file goes to the new note's project"
        );
    }
}

//! The IME follow: the macOS input source tracks the vim mode and the caret's
//! region — CJK in insert outside math/code, English everywhere else.
//!
//! Port of `src/editor/imeSwitch.ts`, with the same shape and the same rules
//! (`bnote_core::commands::ime::desired_source` is the single decision table):
//!
//! - every trigger (vim mode change, caret move, an overlay opening or
//!   closing, window focus) lands in [`ImeHost::sync`] / [`ImeHost::follow_editor`],
//!   which dedups against the last intent and hands the id to the switcher;
//! - the switch itself is the core command, on the **background executor** —
//!   its docs demand exactly that (TIS work must never block a frame);
//! - at most one switch is in flight; a burst of flips collapses into the
//!   one trailing call that matches the final intent;
//! - the source active before bnote's first forced switch of a focus session
//!   (`baseline`) is handed back when the window loses focus.
//!
//! [`ImeServices`] is the seam: `main` injects the platform's (real) commands,
//! the tests inject doubles, and a test therefore never touches the platform —
//! which matters, because a test process has no main run loop to service the
//! core's main-queue hop (see [`ImeServices`]).

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use bnote_core::commands::ime::{self, ImeSettings, ImeWhere};
use bnote_core::markdown::{context, math_scan};
use bnote_core::state::AppState;
use gpui::{App, Context, Task, WeakEntity};

use crate::editor::vim::core::Mode;

/// What actually performs a switch: `(state, source id, app) -> Task`. The
/// returned task models "this switch is done"; the host serializes on it.
pub type Switcher = Rc<dyn Fn(&Arc<AppState>, String, &mut App) -> Task<()>>;

/// How the host reads the source active right now (the blur baseline). The
/// returned task is already running off the UI thread — the core read blocks
/// on TIS.
pub type CurrentSource = Rc<dyn Fn(&mut App) -> Task<Option<String>>>;

/// Lists the selectable input sources — the pickers' data, and (dropped) the
/// prewarm. Already off the UI thread, like [`CurrentSource`].
pub type SourceList = Rc<dyn Fn(&mut App) -> Task<Vec<ime::InputSourceInfo>>>;

/// Every platform touchpoint the follow needs, injected at the composition
/// root (`main`) exactly like the vim and snippet bridges.
///
/// The seam exists because the platform is not always there: in a `cargo test`
/// process there is no main run loop, so the core entry points' main-queue hop
/// (`commands::ime::on_main`) parks until its 5 s timeout on *every* call —
/// measured on this suite, seconds per test. A test therefore wires inert
/// doubles and the platform is never touched; nothing here knows or cares
/// which it got.
#[derive(Clone)]
pub struct ImeServices {
    pub switch: Switcher,
    pub current: CurrentSource,
    pub list: SourceList,
}

impl ImeServices {
    /// The real thing: every call is the core command on the background
    /// executor (the core entry blocks on its own tokio runtime while the TIS
    /// calls run on the app's main thread — the executor hop is what keeps that
    /// out of the UI's frame).
    pub fn platform() -> Self {
        Self {
            switch: Rc::new(|state: &Arc<AppState>, id: String, cx: &mut App| {
                let state = state.clone();
                cx.background_executor()
                    .spawn(async move {
                        let _ = ime::set_input_source(&state, id);
                    })
            }),
            current: Rc::new(|cx: &mut App| {
                cx.background_executor()
                    .spawn(async move { ime::get_current_input_source().ok() })
            }),
            list: Rc::new(|cx: &mut App| {
                cx.background_executor()
                    .spawn(async move { ime::list_input_sources().unwrap_or_default() })
            }),
        }
    }
}

/// The follow's state (TS `imeSwitch.ts`'s module state, one instance for the
/// window).
pub struct ImeHost {
    state: Arc<AppState>,
    settings: ImeSettings,
    services: ImeServices,
    /// What bnote wants active (`None` = the user's own source stays).
    desired: Option<String>,
    /// The last target the *editor* asked for: a caret move inside one region
    /// must not re-issue the switch (TS `lastEditorTarget`).
    last_editor_target: Option<String>,
    /// Source active before bnote's first forced switch of this focus session.
    baseline: Option<String>,
    /// True while the window is unfocused and the baseline went back.
    suspended: bool,
    /// Whether bnote really forced a switch this session — the blur path only
    /// owes the user a restore then (a queued intent that never launched
    /// does not count).
    forced_this_session: bool,
    /// Invalidates in-flight baseline captures across focus flips.
    focus_seq: u64,
    /// At most one switch in flight; the trailing intent waits in `queued`.
    switching: bool,
    queued: Option<String>,
    /// A deferred launch is pending (TS `launchScheduled`).
    launch_scheduled: bool,
    /// The cached caret-context scan (the TS reads cached CM state fields;
    /// here the document revision is the cache key). Recomputing costs a
    /// document walk, so it happens once per edit, not per caret move.
    scan_revision: u64,
    math: Vec<math_scan::MathRegion>,
    fences: Vec<bool>,
}

impl ImeHost {
    pub fn new(state: Arc<AppState>, settings: ImeSettings, services: ImeServices) -> Self {
        Self {
            state,
            settings,
            services,
            desired: None,
            last_editor_target: None,
            baseline: None,
            suspended: false,
            forced_this_session: false,
            focus_seq: 0,
            switching: false,
            queued: None,
            launch_scheduled: false,
            scan_revision: u64::MAX,
            math: Vec::new(),
            fences: Vec::new(),
        }
    }

    /// Replace the settings (the settings modal's writer). Turning the follow
    /// off hands the user's source back.
    pub fn set_settings(&mut self, settings: ImeSettings, cx: &mut Context<Self>) {
        self.settings = settings;
        if !self.settings.enabled && self.desired.is_some() {
            self.yield_source(cx);
        } else {
            cx.notify();
        }
    }

    pub fn settings(&self) -> &ImeSettings {
        &self.settings
    }

    /// Prewarm the TIS enumeration off the UI thread: the first call contacts
    /// the input-method services (~90 ms on this machine) and would otherwise
    /// land on the key that first switches (TS `imeWarmUp`).
    pub fn warm_up(&self, cx: &mut App) {
        if !self.settings.enabled {
            return;
        }
        // The enumeration's result is only wanted for its side effect: the
        // platform caches it, so the first real switch never pays it.
        (self.services.list)(cx).detach();
    }

    /// The editor's trigger (TS `imeSwitchExtension`'s updateListener):
    /// `mode` is vim's current mode (`None` = vim off), `text`/`caret`/
    /// `revision` describe the document the caret sits in.
    pub fn follow_editor(
        &mut self,
        mode: Option<Mode>,
        text: &str,
        caret: usize,
        revision: u64,
        cx: &mut Context<Self>,
    ) {
        // Disabled never forces anything; vim off comes through as `mode`
        // None and takes the `VimOff` arm (which yields anything bnote held).
        if !self.settings.enabled {
            return;
        }
        let at = match mode {
            None => {
                self.last_editor_target = None;
                ImeWhere::VimOff
            }
            Some(Mode::Insert) | Some(Mode::Replace) => {
                let (math, code) = self.regions_at(text, caret, revision);
                ImeWhere::VimInsert { math, code }
            }
            Some(_) => ImeWhere::VimNormal,
        };
        let target = ime::desired_source(&self.settings, at);
        match target {
            Some(target) => {
                if self.last_editor_target.as_deref() == Some(target.as_str())
                    && !self.suspended
                {
                    return;
                }
                self.last_editor_target = Some(target.clone());
                self.apply(target, cx);
            }
            None => {
                self.last_editor_target = None;
                if self.desired.is_some() {
                    self.yield_source(cx);
                }
            }
        }
    }

    /// Any non-editor context change (an overlay opening or closing, focus):
    /// the target is applied as-is, without the editor's dedup (TS
    /// `imeSyncToEditor`).
    pub fn sync_modal(&mut self, at: ImeWhere, cx: &mut Context<Self>) {
        match ime::desired_source(&self.settings, at) {
            Some(target) => self.apply(target, cx),
            None => {
                if self.desired.is_some() {
                    self.yield_source(cx);
                }
            }
        }
    }

    /// Force a target source (TS `imeApply`): a no-op when it is already what
    /// bnote wants.
    pub fn apply(&mut self, target: String, cx: &mut Context<Self>) {
        if !self.settings.enabled {
            return;
        }
        if self.desired.as_deref() == Some(target.as_str()) && !self.suspended {
            return;
        }
        self.desired = Some(target);
        self.suspended = false;
        self.schedule_launch(cx);
    }

    /// Drop bnote's forced source and restore what the user had (TS
    /// `imeYield`).
    pub fn yield_source(&mut self, cx: &mut Context<Self>) {
        let restore = self.baseline.take();
        self.desired = None;
        self.suspended = false;
        self.queued = None;
        self.forced_this_session = false;
        if let Some(restore) = restore {
            self.send(restore, cx).detach();
        }
        cx.notify();
    }

    /// Window deactivated (TS `imeOnWindowBlur`): hand the user's own source
    /// back — only when bnote really forced one.
    pub fn on_window_blur(&mut self, cx: &mut Context<Self>) {
        self.focus_seq += 1;
        self.queued = None;
        if self.forced_this_session && self.desired.is_some() {
            if let Some(baseline) = self.baseline.clone() {
                self.send(baseline, cx).detach();
            }
        }
        self.forced_this_session = false;
        self.baseline = None;
        self.suspended = true;
    }

    /// Window activated (TS `imeOnWindowFocus`): a fresh baseline; the caller
    /// then re-syncs with the current context.
    pub fn on_window_focus(&mut self) {
        self.focus_seq += 1;
        if self.suspended {
            self.baseline = None;
        }
    }

    /// The caret's region flags, from the revision-keyed cache.
    fn regions_at(&mut self, text: &str, caret: usize, revision: u64) -> (bool, bool) {
        if !self.settings.math_keeps_english && !self.settings.code_keeps_english {
            return (false, false);
        }
        if self.scan_revision != revision {
            self.scan_revision = revision;
            self.math = math_scan::scan_math(text);
            self.fences = context::fence_state_scan(text);
        }
        let caret = caret.min(text.len());
        let math = self.math.iter().any(|r| caret >= r.from && caret <= r.to);
        let line = text[..caret].matches('\n').count();
        let code = self.fences.get(line).copied().unwrap_or(false);
        (math, code)
    }

    /// Defer the launch past the frame that asked: the mode and the caret
    /// land first, then TIS moves (TS `setTimeout(…, 0)`). Repeated flips in
    /// one batch collapse — `desired` is the single intent.
    fn schedule_launch(&mut self, cx: &mut Context<Self>) {
        if self.launch_scheduled {
            return;
        }
        self.launch_scheduled = true;
        let weak: WeakEntity<Self> = cx.weak_entity();
        cx.spawn(async move |_, cx| {
            // One background turn: this task is already after the current
            // update, the timer keeps it off the same frame's tail too.
            cx.background_executor().timer(Duration::from_millis(0)).await;
            weak.update(cx, |host, cx| {
                host.launch_scheduled = false;
                host.pump(cx);
            })
            .ok();
        })
        .detach();
    }

    fn pump(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.desired.clone() else { return };
        if self.suspended {
            return;
        }
        if self.switching {
            self.queued = Some(target);
            return;
        }
        self.launch_switch(target, cx);
    }

    fn launch_switch(&mut self, target: String, cx: &mut Context<Self>) {
        self.switching = true;
        self.forced_this_session = true;
        // Capture what the user had before bnote's first forced switch of the
        // session — the source to hand back on blur. Read off the UI thread.
        if self.baseline.is_none() {
            let seq = self.focus_seq;
            let weak: WeakEntity<Self> = cx.weak_entity();
            let asked = target.clone();
            let reading = (self.services.current)(cx);
            cx.spawn(async move |_, cx| {
                let current = reading.await;
                let current = current.filter(|id| *id != asked);
                weak.update(cx, |host, _cx| {
                    // A focus flip while the read was in flight invalidates it.
                    if host.focus_seq == seq {
                        if let Some(current) = current {
                            host.baseline = Some(current);
                        }
                    }
                })
                .ok();
            })
            .detach();
        }
        let task = self.send(target.clone(), cx);
        let weak: WeakEntity<Self> = cx.weak_entity();
        cx.spawn(async move |_, cx| {
            task.await;
            weak.update(cx, |host, cx| {
                host.switching = false;
                let next = host.queued.take();
                if let Some(next) = next.filter(|next| *next != target && !host.suspended) {
                    host.launch_switch(next, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Hand one id to the switcher (fire-and-forget bookkeeping: the caller
    /// owns the serialization flags).
    fn send(&mut self, target: String, cx: &mut App) -> Task<()> {
        (self.services.switch)(&self.state, target, cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::AppContext as _;
    use std::cell::RefCell;

    type Log = Rc<RefCell<Vec<String>>>;

    /// A host whose switches are recorded and whose "current source" is fixed:
    /// no TIS call ever runs (a real switch would move the machine's input
    /// source out from under whoever is using it).
    fn harness(
        cx: &mut gpui::TestAppContext,
        current: &str,
        settings: ImeSettings,
    ) -> (gpui::Entity<ImeHost>, Log) {
        let (state, _rx) = AppState::new(std::env::temp_dir().join("bnote-ime-test"));
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        let recorded = log.clone();
        let switch: Switcher = Rc::new(move |_state, id, _cx| {
            recorded.borrow_mut().push(id);
            Task::ready(())
        });
        let current = current.to_string();
        let read: CurrentSource =
            Rc::new(move |_cx| Task::ready(Some(current.clone())));
        let services = ImeServices { switch, current: read, list: Rc::new(|_| Task::ready(Vec::new())) };
        let host = cx.update(|cx| cx.new(|_| ImeHost::new(state, settings, services)));
        (host, log)
    }

    /// The launch is deferred (a spawned task, and inside it a baseline read):
    /// two park rounds drain the chain.
    fn settle(cx: &mut gpui::TestAppContext) {
        cx.run_until_parked();
        cx.run_until_parked();
    }

    fn text() -> String {
        "正文一段\n\n```\ncode\n```\n\n公式 $x$ 与块:\n\n$$\ny\n$$\n".to_string()
    }

    /// Byte offset of the first occurrence of `needle`.
    fn at(needle: &str) -> usize {
        text().find(needle).expect("the needle is in the fixture")
    }

    /// The follow's editor path: insert gets the CJK source, normal/visual the
    /// English one, and a caret move that does not change the answer costs no
    /// switch (the dedup).
    #[gpui::test]
    fn insert_and_normal_alternate_and_the_dedup_holds(cx: &mut gpui::TestAppContext) {
        let (host, log) = harness(cx, "input.abc", ImeSettings::default());
        let text = text();
        let body = at("正文");

        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Insert), &text, body, 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().as_slice(), ["com.sogou.inputmethod.sogou.pinyin"]);

        // A caret move inside the same region: no second switch.
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Insert), &text, body + 3, 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().len(), 1, "{:?}", log.borrow());

        // Esc: normal mode is English.
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Normal), &text, body + 3, 1, cx);
        });
        settle(cx);
        assert_eq!(
            log.borrow().as_slice(),
            ["com.sogou.inputmethod.sogou.pinyin", "com.apple.keylayout.ABC"]
        );

        // Visual is normal's English too.
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Visual), &text, body + 3, 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().len(), 2, "already English: no switch");

        // vim off: whatever bnote held goes back to the baseline.
        host.update(cx, |host, cx| {
            host.follow_editor(None, &text, body + 3, 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().as_slice()[2], "input.abc", "{:?}", log.borrow());
    }

    /// Formulas and fenced code keep English in insert mode — the two rules
    /// the settings can turn off.
    #[gpui::test]
    fn math_and_code_regions_keep_english_in_insert(cx: &mut gpui::TestAppContext) {
        let (host, log) = harness(cx, "input.abc", ImeSettings::default());
        let text = text();

        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Insert), &text, at("x"), 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().as_slice(), ["com.apple.keylayout.ABC"], "inline math");

        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Insert), &text, at("code"), 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().len(), 1, "still English: the code rule agrees");

        // Outside both regions the CJK source takes over again.
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Insert), &text, at("正文"), 1, cx);
        });
        settle(cx);
        assert_eq!(
            log.borrow().as_slice()[1],
            "com.sogou.inputmethod.sogou.pinyin",
            "{:?}",
            log.borrow()
        );

        // With the rules off, insert inside them is CJK like anywhere else.
        let mut settings = ImeSettings::default();
        settings.math_keeps_english = false;
        settings.code_keeps_english = false;
        let (host, log) = harness(cx, "input.abc", settings);
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Insert), &text, at("y"), 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().as_slice(), ["com.sogou.inputmethod.sogou.pinyin"]);
    }

    /// The overlays: the quick switcher (and the link panel) are ASCII search,
    /// so they want English; another overlay leaves the user's source alone.
    #[gpui::test]
    fn ascii_searches_want_english_and_other_overlays_let_go(cx: &mut gpui::TestAppContext) {
        let (host, log) = harness(cx, "input.abc", ImeSettings::default());
        host.update(cx, |host, cx| host.sync_modal(ImeWhere::AsciiSearch, cx));
        settle(cx);
        assert_eq!(log.borrow().as_slice(), ["com.apple.keylayout.ABC"]);

        // Another overlay: bnote stops forcing (the baseline goes back).
        host.update(cx, |host, cx| host.sync_modal(ImeWhere::Neutral, cx));
        settle(cx);
        assert_eq!(log.borrow().as_slice(), ["com.apple.keylayout.ABC", "input.abc"]);

        // Back to the editor: insert asks for CJK again.
        let text = text();
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Insert), &text, at("正文"), 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().len(), 3, "{:?}", log.borrow());
    }

    /// Losing the window hands the user's own source back — but only when
    /// bnote really forced one.
    #[gpui::test]
    fn blur_restores_the_baseline_only_after_a_forced_switch(cx: &mut gpui::TestAppContext) {
        let (host, log) = harness(cx, "input.abc", ImeSettings::default());

        // Nothing forced yet: blur owes nothing.
        host.update(cx, |host, cx| host.on_window_blur(cx));
        settle(cx);
        assert!(log.borrow().is_empty(), "{:?}", log.borrow());

        host.update(cx, |host, _| host.on_window_focus());
        let text = text();
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Normal), &text, at("正文"), 1, cx);
        });
        settle(cx);
        assert_eq!(log.borrow().as_slice(), ["com.apple.keylayout.ABC"]);

        host.update(cx, |host, cx| host.on_window_blur(cx));
        settle(cx);
        assert_eq!(
            log.borrow().as_slice(),
            ["com.apple.keylayout.ABC", "input.abc"],
            "the source the user had comes back"
        );

        // Back in front with a fresh session, the context's source applies
        // again (TS `imeOnWindowFocus` → `imeSyncToEditor`).
        host.update(cx, |host, _| host.on_window_focus());
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Normal), &text, at("正文"), 1, cx);
        });
        settle(cx);
        assert_eq!(
            log.borrow().as_slice(),
            ["com.apple.keylayout.ABC", "input.abc", "com.apple.keylayout.ABC"],
            "{:?}",
            log.borrow()
        );
    }

    /// With the follow off, nothing is ever forced.
    #[gpui::test]
    fn a_disabled_follow_never_switches(cx: &mut gpui::TestAppContext) {
        let mut settings = ImeSettings::default();
        settings.enabled = false;
        let (host, log) = harness(cx, "input.abc", settings);
        let text = text();
        host.update(cx, |host, cx| {
            host.follow_editor(Some(Mode::Insert), &text, at("正文"), 1, cx);
            host.sync_modal(ImeWhere::AsciiSearch, cx);
        });
        settle(cx);
        assert!(log.borrow().is_empty(), "{:?}", log.borrow());
    }
}

//! Inert platform seams for the headless debug channels (`harness.rs`,
//! `harness-shot`): a scripted run has no IME switcher and never spawns the
//! python LSP. The IME follow's real per-switch latency is a platform
//! behavior the headless process cannot measure anyway (the TIS hop needs a
//! live main run loop) — same blind spot the Tauri shell's browser debugging
//! had for `plugin:*` commands.

use gpui::Task;
use std::rc::Rc;

use crate::ime_host::{CurrentSource, ImeServices, Switcher};
use crate::python_lsp::PyLspServices;

/// The IME follow's seams, inert: every switch is a no-op, `list` is empty.
pub fn inert_ime() -> ImeServices {
    let switch: Switcher = Rc::new(|_, _, _| Task::ready(()));
    let current: CurrentSource = Rc::new(|_| Task::ready(None));
    ImeServices { switch, current, list: Rc::new(|_| Task::ready(Vec::new())) }
}

/// The ty follow's seams, inert: diagnostics/completions never arrive.
pub fn inert_lsp() -> PyLspServices {
    PyLspServices {
        sync: Rc::new(|_, _, _, _| Task::ready(Ok(false))),
        request: Rc::new(|_, _, _, _, _| Task::ready(Ok(serde_json::Value::Null))),
        close: Rc::new(|_, _, _| Task::ready(())),
        info: Rc::new(|_, _, _| Task::ready(Ok(serde_json::json!({ "lsp": "off" })))),
        set_lsp: Rc::new(|_, _, _, _| Task::ready(Ok(()))),
        uv_create: Rc::new(|_, _, _| {
            Task::ready(Ok(bnote_core::python::uvenv::UvOutcome {
                log: String::new(),
                ran_init: false,
            }))
        }),
    }
}

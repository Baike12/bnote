//! Input-source (IME) switching that follows vim mode, macOS only.
//!
//! Implementation calls the Carbon TIS APIs **in-process**: no binary spawn,
//! no focus stealing — a switch costs ~1–5 ms versus ~150 ms+ for the
//! shell-out approach (node → sh → macism) used by the Obsidian plugin this
//! feature replaces.
//!
//! macOS 26 (Tahoe) has a race where a freshly selected CJK input source may
//! not engage before the next keystrokes; if the selection did not stick we
//! retry once and then fall back to the `macism` CLI (which runs its own
//! temporary-window workaround) when it is installed.

use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Emitter};

use super::CmdResult;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InputSourceInfo {
    pub id: String,
    pub name: String,
    pub is_cjk: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetImeOutcome {
    /// false when the requested source was already active.
    pub switched: bool,
    /// true when the in-process select did not stick and the macism CLI took over.
    pub fallback_used: bool,
}

#[cfg(target_os = "macos")]
mod tis {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::{CFBoolean, CFBooleanRef};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        static kTISCategoryKeyboardInputSource: CFStringRef;
        static kTISPropertyInputSourceCategory: CFStringRef;
        static kTISPropertyInputSourceID: CFStringRef;
        static kTISPropertyInputSourceIsSelectCapable: CFStringRef;
        static kTISPropertyInputSourceLanguages: CFStringRef;
        static kTISPropertyLocalizedName: CFStringRef;

        fn TISCreateInputSourceList(
            filter: *const std::os::raw::c_void,
            include_all_installed: u8,
        ) -> CFArrayRef;
        fn TISCopyCurrentKeyboardInputSource() -> CFTypeRef;
        fn TISSelectInputSource(source: CFTypeRef) -> i32;
        fn TISGetInputSourceProperty(
            source: CFTypeRef,
            key: CFStringRef,
        ) -> *const std::os::raw::c_void;
    }

    unsafe fn live_sources() -> Vec<CFTypeRef> {
        let list = TISCreateInputSourceList(std::ptr::null(), 0);
        if list.is_null() {
            return Vec::new();
        }
        let arr = CFArray::<CFType>::wrap_under_get_rule(list);
        let out: Vec<CFTypeRef> = arr.into_iter().map(|t| t.as_CFTypeRef()).collect();
        out
    }

    unsafe fn prop_string(source: CFTypeRef, key: CFStringRef) -> Option<String> {
        let raw = TISGetInputSourceProperty(source, key);
        if raw.is_null() {
            return None;
        }
        Some(CFString::wrap_under_get_rule(raw as CFStringRef).to_string())
    }

    unsafe fn prop_bool(source: CFTypeRef, key: CFStringRef) -> bool {
        let raw = TISGetInputSourceProperty(source, key);
        if raw.is_null() {
            return false;
        }
        CFBoolean::wrap_under_get_rule(raw as CFBooleanRef) == CFBoolean::true_value()
    }

    unsafe fn prop_langs(source: CFTypeRef, key: CFStringRef) -> Vec<String> {
        let raw = TISGetInputSourceProperty(source, key);
        if raw.is_null() {
            return Vec::new();
        }
        let arr = CFArray::<CFString>::wrap_under_get_rule(raw as CFArrayRef);
        arr.into_iter().map(|s| s.to_string()).collect()
    }

    fn is_cjk(langs: &[String]) -> bool {
        langs
            .first()
            .map(|l| l == "ko" || l == "ja" || l == "vi" || l.starts_with("zh"))
            .unwrap_or(false)
    }

    /// Enumerates enabled, selectable keyboard input sources.
    pub fn selectable_sources() -> Vec<crate::commands::ime::InputSourceInfo> {
        unsafe {
            let keyboard_category = CFString::wrap_under_get_rule(kTISCategoryKeyboardInputSource);
            let category_key = kTISPropertyInputSourceCategory;
            let mut out = Vec::new();
            for src in live_sources() {
                if prop_string(src, category_key).as_deref() != Some(keyboard_category.to_string().as_str())
                {
                    continue;
                }
                if !prop_bool(src, kTISPropertyInputSourceIsSelectCapable) {
                    continue;
                }
                let id = prop_string(src, kTISPropertyInputSourceID).unwrap_or_default();
                if id.is_empty() {
                    continue;
                }
                let name = prop_string(src, kTISPropertyLocalizedName).unwrap_or_else(|| id.clone());
                let langs = prop_langs(src, kTISPropertyInputSourceLanguages);
                out.push(crate::commands::ime::InputSourceInfo {
                    id,
                    name,
                    is_cjk: is_cjk(&langs),
                });
            }
            out
        }
    }

    /// Id of the active input source (single TIS call, no enumeration).
    pub fn current_source_id() -> Option<String> {
        unsafe {
            let src = TISCopyCurrentKeyboardInputSource();
            if src.is_null() {
                return None;
            }
            let id = prop_string(src, kTISPropertyInputSourceID);
            id
        }
    }

    fn source_by_id(id: &str) -> Option<CFTypeRef> {
        unsafe {
            live_sources().into_iter().find(|&src| {
                prop_string(src, kTISPropertyInputSourceID).as_deref() == Some(id)
                    && prop_bool(src, kTISPropertyInputSourceIsSelectCapable)
            })
        }
    }

    /// Selects a source by id. Ok(true) when it was already active.
    pub fn select(id: &str) -> Result<bool, String> {
        if current_source_id().as_deref() == Some(id) {
            return Ok(true);
        }
        let src = source_by_id(id).ok_or_else(|| format!("input source not found: {id}"))?;
        let status = unsafe { TISSelectInputSource(src) };
        if status == 0 {
            Ok(false)
        } else {
            Err(format!("TISSelectInputSource({id}) failed: {status}"))
        }
    }

    pub fn is_cjk_source(id: &str) -> bool {
        match source_by_id(id) {
            Some(src) => unsafe { is_cjk(&prop_langs(src, kTISPropertyInputSourceLanguages)) },
            None => false,
        }
    }
}

#[cfg(target_os = "macos")]
fn macism_path() -> Option<&'static str> {
    for p in ["/opt/homebrew/bin/macism", "/usr/local/bin/macism"] {
        if std::path::Path::new(p).exists() {
            return Some(p);
        }
    }
    None
}

/// Runs a closure on the main thread and waits for its result.
///
/// macOS 26 (Tahoe) HIToolbox asserts that TIS APIs run on the main queue —
/// calling them from any other thread traps with EXC_BREAKPOINT
/// (dispatch_assert_queue_fail). Every TIS entry point must go through this.
#[cfg(target_os = "macos")]
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("main thread dispatch failed: {e}"))?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "main thread dispatch timed out".to_string())
}

#[cfg(target_os = "macos")]
async fn list_impl(app: AppHandle) -> CmdResult<Vec<InputSourceInfo>> {
    spawn_blocking(move || on_main(&app, tis::selectable_sources))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(not(target_os = "macos"))]
async fn list_impl(app: AppHandle) -> CmdResult<Vec<InputSourceInfo>> {
    let _ = app;
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
async fn current_impl(app: AppHandle) -> CmdResult<String> {
    spawn_blocking(move || on_main(&app, tis::current_source_id))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .and_then(|opt| opt.ok_or_else(|| "TISCopyCurrentKeyboardInputSource failed".to_string()))
}

#[cfg(not(target_os = "macos"))]
async fn current_impl(app: AppHandle) -> CmdResult<String> {
    let _ = app;
    Err("IME switching is only supported on macOS".into())
}

#[cfg(target_os = "macos")]
async fn set_impl(app: AppHandle, id: String) -> CmdResult<SetImeOutcome> {
    spawn_blocking(move || {
        let id_for_select = id.clone();
        let already = on_main(&app, move || tis::select(&id_for_select));
        eprintln!("[bnote] set_input_source({id}) -> {already:?}");
        let already = already??;
        if already {
            return Ok(SetImeOutcome { switched: false, fallback_used: false });
        }
        let id_for_cjk = id.clone();
        let cjk = on_main(&app, move || tis::is_cjk_source(&id_for_cjk))?;
        if cjk {
            verify_or_fallback(app, id);
        }
        Ok(SetImeOutcome { switched: true, fallback_used: false })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(not(target_os = "macos"))]
async fn set_impl(app: AppHandle, _id: String) -> CmdResult<SetImeOutcome> {
    let _ = app;
    Err("IME switching is only supported on macOS".into())
}

/// Lists enabled, selectable input sources for the settings picker.
#[tauri::command]
pub async fn list_input_sources(app: AppHandle) -> CmdResult<Vec<InputSourceInfo>> {
    list_impl(app).await
}

/// Returns the id of the current input source.
#[tauri::command]
pub async fn get_current_input_source(app: AppHandle) -> CmdResult<String> {
    current_impl(app).await
}

/// Selects an input source by id. Cheap no-op when already active. For CJK
/// targets, verifies on a background thread that the selection stuck (macOS 26
/// race) and falls back to the macism CLI when it did not.
#[tauri::command]
pub async fn set_input_source(app: AppHandle, id: String) -> CmdResult<SetImeOutcome> {
    set_impl(app, id).await
}

/// macOS 26: a freshly selected CJK source can silently fail to engage.
/// Re-check after a beat, retry once, then hand over to the macism CLI whose
/// temporary-window workaround forces the switch. TIS reads here also go
/// through the main thread (see `on_main`).
#[cfg(target_os = "macos")]
fn verify_or_fallback(app: AppHandle, target: String) {
    std::thread::spawn(move || {
        let current = || -> Option<String> {
            let handle = app.clone();
            on_main(&handle, tis::current_source_id).ok().flatten()
        };
        for attempt in 0..2 {
            std::thread::sleep(Duration::from_millis(120));
            if current().as_deref() == Some(target.as_str()) {
                return;
            }
            if attempt == 0 {
                let handle = app.clone();
                let t = target.clone();
                let _ = on_main(&handle, move || tis::select(&t));
            }
        }
        let used_fallback = match macism_path() {
            Some(path) => Command::new(path)
                .arg(&target)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok(),
            None => false,
        };
        let payload = if used_fallback {
            "输入法直接切换未生效，已用 macism 兜底（可能会闪一下焦点）".to_string()
        } else {
            "输入法切换未生效：请在 系统设置 → 隐私与安全性 → 辅助功能 中允许 bnote，或安装 macism（brew install laishulu/homebrew/macism）".to_string()
        };
        let _ = app.emit("ime-fallback", payload);
    });
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::tis;
    use std::time::{Duration, Instant};

    #[test]
    fn probe_switch_sources() {
        let t0 = Instant::now();
        let current = tis::current_source_id();
        println!("current: {current:?} (took {:?})", t0.elapsed());

        let sources = tis::selectable_sources();
        println!("{} selectable sources (took {:?}):", sources.len(), t0.elapsed());
        for s in &sources {
            println!("  {:<45} {} cjk={}", s.id, s.name, s.is_cjk);
        }

        let abc = "com.apple.keylayout.ABC";
        let sogou = "com.sogou.inputmethod.sogou.pinyin";
        if !sources.iter().any(|s| s.id == abc) || !sources.iter().any(|s| s.id == sogou) {
            println!("ABC or Sogou not installed — skipping switch test");
            return;
        }

        let t1 = Instant::now();
        let r = tis::select(abc);
        println!("select ABC: {r:?} (took {:?})", t1.elapsed());
        std::thread::sleep(Duration::from_millis(150));
        println!("  current now: {:?}", tis::current_source_id());

        let t2 = Instant::now();
        let r = tis::select(sogou);
        println!("select Sogou: {r:?} (took {:?})", t2.elapsed());
        std::thread::sleep(Duration::from_millis(150));
        println!("  current now: {:?}", tis::current_source_id());

        let t3 = Instant::now();
        let r = tis::select(abc);
        println!("select ABC again: {r:?} (took {:?})", t3.elapsed());

        // 恢复测试前的输入法
        if let Some(orig) = current {
            let _ = tis::select(&orig);
        }
    }
}

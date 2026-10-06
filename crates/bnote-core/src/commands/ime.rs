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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;

use super::CmdResult;
use crate::events::EventBus;

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

/// 代数戳（见 set_impl）:verify_or_fallback 的后台链属于哪次切换。
#[cfg(target_os = "macos")]
static SWITCH_SEQ: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
mod tis {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::{CFBoolean, CFBooleanRef};
    use core_foundation::string::{CFString, CFStringRef};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

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

    unsafe fn live_sources() -> Vec<CFType> {
        let list = TISCreateInputSourceList(std::ptr::null(), 0);
        if list.is_null() {
            return Vec::new();
        }
        let arr = CFArray::<CFType>::wrap_under_get_rule(list);
        // 迭代只借用数组里的元素（ItemRef）：逐个 clone 成自己持有的一份
        // （CFType::clone 走 CFRetain），否则数组一释放这些引用就悬空了。
        arr.into_iter().map(|item| (*item).clone()).collect()
    }

    /* ---- 输入源引用缓存 ----------------------------------------------------
       TIS 里最贵的一步是「枚举全部输入源」：TISCreateInputSourceList + 每个源读
       4 个属性（本机实测冷启动 ~33ms、热 ~1-2ms）。而 select 每次模式切换都要
       走一次，且必须挂在苹果主线程上（见 on_main）——枚举一次就白占一次主线程。
       输入源的集合在一次会话内基本不变，所以整份缓存下来：select 只在缓存未
       命中、或选中失败（源的集合变了）时才重新枚举。 ------------------------ */

    struct Sources(Mutex<Option<HashMap<String, CFType>>>);
    // CFType 是 +1 引用计数对象，retain/release 本身是线程安全的；这里只在
    // 主线程（on_main）读写，加 Mutex 只是为了让静态类型成立。
    unsafe impl Send for Sources {}
    unsafe impl Sync for Sources {}

    fn sources_cache() -> &'static Sources {
        static CACHE: OnceLock<Sources> = OnceLock::new();
        CACHE.get_or_init(|| Sources(Mutex::new(None)))
    }

    /// 枚举次数。门禁用：切换一次模式不该引起枚举（见 tests::cache_avoids_reenumeration）。
    static ENUMERATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// 本进程以来枚举输入源的次数（测试用）。
    #[cfg(test)]
    pub fn enumeration_count() -> u64 {
        ENUMERATIONS.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 单遍枚举全部可选键盘输入源，保持系统给出的顺序：
    /// (id, 展示名, 是否 CJK, 持有的 CFType 引用)。
    fn enumerate_sources() -> Vec<(String, String, bool, CFType)> {
        ENUMERATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut out = Vec::new();
        let keyboard_category = unsafe {
            CFString::wrap_under_get_rule(kTISCategoryKeyboardInputSource).to_string()
        };
        for src in unsafe { live_sources() } {
            let raw = src.as_CFTypeRef();
            unsafe {
                if prop_string(raw, kTISPropertyInputSourceCategory).as_deref()
                    != Some(keyboard_category.as_str())
                {
                    continue;
                }
                if !prop_bool(raw, kTISPropertyInputSourceIsSelectCapable) {
                    continue;
                }
            }
            let id = unsafe { prop_string(raw, kTISPropertyInputSourceID) }.unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let name = unsafe { prop_string(raw, kTISPropertyLocalizedName) }
                .unwrap_or_else(|| id.clone());
            let langs = unsafe { prop_langs(raw, kTISPropertyInputSourceLanguages) };
            out.push((id, name, is_cjk(&langs), src));
        }
        out
    }

    /// 枚举一次并替换缓存；返回本次枚举的展示信息（顺序同系统枚举）。
    fn refresh_sources() -> Vec<(String, String, bool)> {
        let entries = enumerate_sources();
        let mut map = HashMap::with_capacity(entries.len());
        let mut info = Vec::with_capacity(entries.len());
        for (id, name, cjk, src) in entries {
            info.push((id.clone(), name, cjk));
            map.insert(id, src);
        }
        if let Ok(mut guard) = sources_cache().0.lock() {
            *guard = Some(map);
        }
        info
    }

    /// 在持有的缓存里按 id 取引用并执行 `f`（锁内执行，引用在整个调用期间有效）。
    fn with_source<F, R>(id: &str, f: F) -> Option<R>
    where
        F: FnOnce(CFTypeRef) -> R,
    {
        let guard = sources_cache().0.lock().ok()?;
        let src = guard.as_ref()?.get(id)?;
        Some(f(src.as_CFTypeRef()))
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

    /// Enumerates enabled, selectable keyboard input sources. 设置面板用；顺手把
    /// select() 走的会话缓存一并刷成这次的结果。
    pub fn selectable_sources() -> Vec<crate::commands::ime::InputSourceInfo> {
        refresh_sources()
            .into_iter()
            .map(|(id, name, is_cjk)| crate::commands::ime::InputSourceInfo { id, name, is_cjk })
            .collect()
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

    /// Selects a source by id. Ok(true) when it was already active.
    ///
    /// 走会话缓存：命中时整条路径只有一次 TISCopyCurrentKeyboardInputSource +
    /// 一次 TISSelectInputSource，不再枚举全部输入源。解析失败（源刚被禁用或
    /// 新装上）才重新枚举一次并重试。
    pub fn select(id: &str) -> Result<bool, String> {
        if current_source_id().as_deref() == Some(id) {
            return Ok(true);
        }
        if let Some(status) = with_source(id, |src| unsafe { TISSelectInputSource(src) }) {
            if status == 0 {
                return Ok(false);
            }
        }
        refresh_sources();
        let status = with_source(id, |src| unsafe { TISSelectInputSource(src) })
            .ok_or_else(|| format!("input source not found: {id}"))?;
        if status == 0 {
            Ok(false)
        } else {
            Err(format!("TISSelectInputSource({id}) failed: {status}"))
        }
    }

    pub fn is_cjk_source(id: &str) -> bool {
        let langs = with_source(id, |src| unsafe {
            prop_langs(src, kTISPropertyInputSourceLanguages)
        });
        match langs {
            Some(langs) => is_cjk(&langs),
            None => {
                refresh_sources();
                match with_source(id, |src| unsafe {
                    prop_langs(src, kTISPropertyInputSourceLanguages)
                }) {
                    Some(langs) => is_cjk(&langs),
                    None => false,
                }
            }
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

/// Runs a closure on the app's main thread and waits for its result.
///
/// macOS 26 (Tahoe) HIToolbox asserts that TIS APIs run on the main queue —
/// calling them from any other thread traps with EXC_BREAKPOINT
/// (dispatch_assert_queue_fail). Every TIS entry point must go through this.
///
/// 原来挂在 Tauri `AppHandle::run_on_main_thread` 上;core 没有 UI runtime,
/// 直连 libdispatch 主队列(libSystem 默认链接,不加依赖):闭包经
/// dispatch_async_f 排进主队列,调用方带 5s 超时等结果 —— 排队与超时语义与
/// 原实现一致。主队列在 C 里就是全局静态 `_dispatch_main_q`
/// (dispatch_get_main_queue() 宏取的就是它的地址)。
#[cfg(target_os = "macos")]
fn on_main<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    use std::ffi::c_void;
    use std::sync::mpsc;

    unsafe extern "C" {
        static _dispatch_main_q: u8;
        fn dispatch_async_f(
            queue: *const u8,
            context: *mut c_void,
            work: unsafe extern "C" fn(*mut c_void),
        );
    }

    unsafe extern "C" fn trampoline(context: *mut c_void) {
        let f: Box<Box<dyn FnOnce() + Send>> = Box::from_raw(context.cast());
        f();
    }

    let (tx, rx) = mpsc::channel();
    let closure: Box<dyn FnOnce() + Send> = Box::new(move || {
        let _ = tx.send(f());
    });
    let payload: Box<Box<dyn FnOnce() + Send>> = Box::new(closure);
    unsafe {
        dispatch_async_f(
            std::ptr::addr_of!(_dispatch_main_q).cast(),
            Box::into_raw(payload).cast(),
            trampoline,
        );
    }
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "main thread dispatch timed out".to_string())
}

#[cfg(target_os = "macos")]
async fn list_impl() -> CmdResult<Vec<InputSourceInfo>> {
    tokio::task::spawn_blocking(move || on_main(tis::selectable_sources))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(not(target_os = "macos"))]
async fn list_impl() -> CmdResult<Vec<InputSourceInfo>> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
async fn current_impl() -> CmdResult<String> {
    tokio::task::spawn_blocking(move || on_main(tis::current_source_id))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .and_then(|opt| opt.ok_or_else(|| "TISCopyCurrentKeyboardInputSource failed".to_string()))
}

#[cfg(not(target_os = "macos"))]
async fn current_impl() -> CmdResult<String> {
    Err("IME switching is only supported on macOS".into())
}

#[cfg(target_os = "macos")]
async fn set_impl(events: EventBus, id: String) -> CmdResult<SetImeOutcome> {
    tokio::task::spawn_blocking(move || {
        // 代数戳:每次真实切换请求推进一格。verify_or_fallback 的后台链
        // (120ms 后复查 → 重选 → macism)拿到自己的代数,一旦有更新的切换
        // 开始就全部作废——否则慢链会把用户已经切走的目标又重选回来,输入
        // 源在 normal/insert 快速翻转时来回弹,读作"切模式卡顿"。
        let seq = SWITCH_SEQ.fetch_add(1, Ordering::SeqCst);
        let id_for_select = id.clone();
        let already = on_main(move || tis::select(&id_for_select));
        eprintln!("[bnote] set_input_source({id}) -> {already:?}");
        let already = already??;
        if already {
            return Ok(SetImeOutcome { switched: false, fallback_used: false });
        }
        let cjk = cached_is_cjk(&id)?;
        if cjk {
            verify_or_fallback(events, id, seq);
        }
        Ok(SetImeOutcome { switched: true, fallback_used: false })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(not(target_os = "macos"))]
async fn set_impl(_events: EventBus, _id: String) -> CmdResult<SetImeOutcome> {
    Err("IME switching is only supported on macOS".into())
}

/// Lists enabled, selectable input sources for the settings picker.
///
/// 同步入口,内部跑在 core 私有 tokio runtime 上;调用方(GPUI 壳)必须放到
/// 后台线程,不许在 UI 线程直接调。
pub fn list_input_sources() -> CmdResult<Vec<InputSourceInfo>> {
    crate::runtime::block_on(list_impl())
}

/// Returns the id of the current input source.
///
/// 同步入口,内部跑在 core 私有 tokio runtime 上;调用方(GPUI 壳)必须放到
/// 后台线程,不许在 UI 线程直接调。
pub fn get_current_input_source() -> CmdResult<String> {
    crate::runtime::block_on(current_impl())
}

/// Selects an input source by id. Cheap no-op when already active. For CJK
/// targets, verifies on a background thread that the selection stuck (macOS 26
/// race) and falls back to the macism CLI when it did not.
///
/// 同步入口,内部跑在 core 私有 tokio runtime 上;调用方(GPUI 壳)必须放到
/// 后台线程,不许在 UI 线程直接调。
pub fn set_input_source(state: &crate::state::AppState, id: String) -> CmdResult<SetImeOutcome> {
    let events = state.events.clone();
    crate::runtime::block_on(set_impl(events, id))
}

/// `settings.ime` — the five keys the Tauri shell persists (TS
/// `ImeSettings`), with the same defaults.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImeSettings {
    /// Follow the vim mode at all (macOS only).
    pub enabled: bool,
    /// The source insert mode wants (the user's CJK source).
    pub insert_source: String,
    /// The source normal / visual (and ASCII contexts) want.
    pub normal_source: String,
    /// In insert mode inside a math region, keep English (formulas are ASCII).
    pub math_keeps_english: bool,
    /// In insert mode inside a fenced code block, keep English (code is ASCII).
    pub code_keeps_english: bool,
}

impl Default for ImeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            insert_source: "com.sogou.inputmethod.sogou.pinyin".to_string(),
            normal_source: "com.apple.keylayout.ABC".to_string(),
            math_keeps_english: true,
            code_keeps_english: true,
        }
    }
}

/// Read `settings.ime` (missing keys take their defaults, the TS shape).
pub fn ime_settings(config: &serde_json::Value) -> ImeSettings {
    config
        .get("settings")
        .and_then(|s| s.get("ime"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// Write `settings.ime`.
pub fn set_ime_settings(config: &mut serde_json::Value, settings: &ImeSettings) {
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let settings_obj = config
        .as_object_mut()
        .expect("just ensured an object")
        .entry("settings".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !settings_obj.is_object() {
        *settings_obj = serde_json::json!({});
    }
    settings_obj
        .as_object_mut()
        .expect("just ensured an object")
        .insert(
            "ime".to_string(),
            serde_json::to_value(settings).unwrap_or(serde_json::Value::Null),
        );
}

/// Where the keyboard's context sits, as far as the follow cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImeWhere {
    /// An ASCII search field owns the keyboard (the quick switcher, the link
    /// panel): English.
    AsciiSearch,
    /// Another modal owns it (settings, quick-add naming): the user's own
    /// source stays — naming a note may well be Chinese.
    Neutral,
    /// The editor with vim off: leave the source alone.
    VimOff,
    /// vim normal / visual.
    VimNormal,
    /// vim insert, with the caret's region.
    VimInsert { math: bool, code: bool },
}

/// TS `imeDesiredSource` + `insertRegionWantsEnglish`: the source the current
/// context wants, or `None` for "leave whatever the user has".
///
/// This is the whole decision, in one function, so every trigger (mode change,
/// caret move, modal open, focus) answers with the same rules.
pub fn desired_source(settings: &ImeSettings, at: ImeWhere) -> Option<String> {
    if !settings.enabled {
        return None;
    }
    match at {
        ImeWhere::AsciiSearch => Some(settings.normal_source.clone()),
        ImeWhere::Neutral | ImeWhere::VimOff => None,
        ImeWhere::VimNormal => Some(settings.normal_source.clone()),
        ImeWhere::VimInsert { math, code } => {
            let keep_english = (math && settings.math_keeps_english)
                || (code && settings.code_keeps_english);
            Some(if keep_english {
                settings.normal_source.clone()
            } else {
                settings.insert_source.clone()
            })
        }
    }
}

/// CJK-ness of an input source, cached per source id. The uncached check
/// enumerates every live input source on the MAIN thread (see `on_main`), and
/// it runs on every switch — a source's languages never change within a
/// session, so the one main-thread enumeration per id is all we ever pay.
#[cfg(target_os = "macos")]
fn cached_is_cjk(id: &str) -> Result<bool, String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(hit) = map.get(id) {
            return Ok(*hit);
        }
    }
    let id_owned = id.to_string();
    // is_cjk_source 返回裸 bool,on_main 只有一层 Result。
    let cjk = on_main(move || tis::is_cjk_source(&id_owned))?;
    if let Ok(mut map) = cache.lock() {
        map.insert(id.to_string(), cjk);
    }
    Ok(cjk)
}

/// macOS 26: a freshly selected CJK source can silently fail to engage.
/// Re-check after a beat, retry once, then hand over to the macism CLI whose
/// temporary-window workaround forces the switch. TIS reads here also go
/// through the main thread (see `on_main`).
///
/// `seq` 是发起本次切换时的代数:任何一步动作(重选/macism)之前都要确认没有
/// 更新的切换开始——快速 normal↔insert 翻转时,慢链把旧目标重选回来会让输入
/// 源来回弹,前端毫无感知(它以为切好了)。
#[cfg(target_os = "macos")]
fn verify_or_fallback(events: EventBus, target: String, seq: u64) {
    std::thread::spawn(move || {
        let current = || -> Option<String> { on_main(tis::current_source_id).ok().flatten() };
        for attempt in 0..2 {
            std::thread::sleep(Duration::from_millis(120));
            if SWITCH_SEQ.load(Ordering::SeqCst) != seq {
                return; // 已有更新的切换:本次验证链整体作废
            }
            if current().as_deref() == Some(target.as_str()) {
                return;
            }
            if attempt == 0 {
                let t = target.clone();
                let _ = on_main(move || tis::select(&t));
            }
        }
        if SWITCH_SEQ.load(Ordering::SeqCst) != seq {
            return;
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
        crate::events::emit_event(&events, "ime-fallback", payload);
    });
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// The follow's whole decision table (TS `imeDesiredSource` +
    /// `insertRegionWantsEnglish`).
    #[test]
    fn the_desired_source_follows_the_context() {
        let mut settings = ImeSettings::default();
        settings.insert_source = "cjk".into();
        settings.normal_source = "abc".into();

        assert_eq!(
            desired_source(&settings, ImeWhere::AsciiSearch).as_deref(),
            Some("abc")
        );
        assert_eq!(desired_source(&settings, ImeWhere::Neutral), None, "naming a note stays");
        assert_eq!(desired_source(&settings, ImeWhere::VimOff), None, "vim off owns nothing");
        assert_eq!(
            desired_source(&settings, ImeWhere::VimNormal).as_deref(),
            Some("abc")
        );
        assert_eq!(
            desired_source(&settings, ImeWhere::VimInsert { math: false, code: false }).as_deref(),
            Some("cjk")
        );
        // Formulas and code are ASCII: insert there keeps English.
        assert_eq!(
            desired_source(&settings, ImeWhere::VimInsert { math: true, code: false }).as_deref(),
            Some("abc")
        );
        assert_eq!(
            desired_source(&settings, ImeWhere::VimInsert { math: false, code: true }).as_deref(),
            Some("abc")
        );

        // Each "keeps English" rule has its own switch.
        settings.math_keeps_english = false;
        assert_eq!(
            desired_source(&settings, ImeWhere::VimInsert { math: true, code: false }).as_deref(),
            Some("cjk")
        );
        assert_eq!(
            desired_source(&settings, ImeWhere::VimInsert { math: false, code: true }).as_deref(),
            Some("abc"),
            "the code rule is independent"
        );

        // Off means the whole follow lets go.
        settings.enabled = false;
        assert_eq!(desired_source(&settings, ImeWhere::VimNormal), None);
        assert_eq!(desired_source(&settings, ImeWhere::AsciiSearch), None);
    }

    /// `settings.ime` round-trips under its key, defaults fill the gaps.
    #[test]
    fn ime_settings_round_trip_under_the_settings_key() {
        let mut config = serde_json::json!({ "settings": { "vim": true } });
        assert_eq!(ime_settings(&config), ImeSettings::default(), "absent → defaults");

        let settings = ImeSettings {
            enabled: false,
            insert_source: "a".into(),
            normal_source: "b".into(),
            math_keeps_english: false,
            code_keeps_english: true,
        };
        set_ime_settings(&mut config, &settings);
        assert_eq!(ime_settings(&config), settings);
        assert_eq!(config["settings"]["vim"], serde_json::json!(true), "siblings survive");

        // A partial object keeps the defaults for what it omits.
        let partial = serde_json::json!({ "settings": { "ime": { "enabled": false } } });
        let read = ime_settings(&partial);
        assert!(!read.enabled);
        assert_eq!(read.normal_source, ImeSettings::default().normal_source);

        // A broken settings block grows/replaces instead of panicking.
        let mut broken = serde_json::json!({ "settings": "oops" });
        set_ime_settings(&mut broken, &settings);
        assert_eq!(ime_settings(&broken), settings);
    }

    use super::tis;
    use std::time::{Duration, Instant};

    /// TIS 的缓存与枚举计数是进程级全局状态，两个测试必须串行跑。
    static TIS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TIS_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 门禁：**切换一次模式不许重新枚举输入源**。枚举（TISCreateInputSourceList
    /// + 每个源读 4 个属性）是 TIS 里最贵的一步，而它每次都挂在苹果主线程上
    /// （见 on_main）——一次模式切换只该付「读当前源 + select」两次调用。枚举
    /// 只允许发生在首次填充，以及缓存未命中/选失败（输入源集合变了）时重试。
    #[test]
    fn cache_avoids_reenumeration() {
        let _guard = lock();
        let base = tis::enumeration_count();
        let sources = tis::selectable_sources();
        assert!(!sources.is_empty(), "本机应至少有一个可选键盘输入源");
        assert_eq!(tis::enumeration_count(), base + 1, "枚举一次即填好缓存");

        for _ in 0..3 {
            let _ = tis::select("com.apple.keylayout.ABC");
        }
        assert_eq!(
            tis::enumeration_count(),
            base + 1,
            "命中缓存时 select 不许重新枚举输入源"
        );

        assert!(tis::select("com.bnote.__nonexistent_layout__").is_err());
        assert_eq!(
            tis::enumeration_count(),
            base + 2,
            "缓存未命中只重枚举一次（选失败的重试路径）"
        );
    }

    #[test]
    fn probe_switch_sources() {
        let _guard = lock();
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

        // 稳态：每次模式切换都要付的就是这一段（缓存命中 → 只有
        // TISCopyCurrentKeyboardInputSource + TISSelectInputSource，不枚举）。
        let mut warm = Vec::new();
        for i in 0..6 {
            let target = if i % 2 == 0 { sogou } else { abc };
            let t = Instant::now();
            let _ = tis::select(target);
            warm.push(t.elapsed());
            std::thread::sleep(Duration::from_millis(150));
        }
        println!(
            "warm switch x6 (cache hit): {:?}  (enumerations so far: {})",
            warm,
            tis::enumeration_count()
        );

        // 恢复测试前的输入法
        if let Some(orig) = current {
            let _ = tis::select(&orig);
        }
    }
}

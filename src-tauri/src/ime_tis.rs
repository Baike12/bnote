//! Raw Carbon TIS (Text Input Source) calls: enumeration, current source,
//! selection, with a session reference cache.
//!
//! The switch costs real main-thread time (see commands/ime.rs for why the
//! call must leave the app's main thread): warm select measures 2–50 ms and a
//! cold input-method activation 30–170 ms on this machine (real-trace median
//! ~30 ms, p95 >100 ms). TIS must run on the Apple main queue — an off-main
//! `TISCreateInputSourceList` traps with dispatch_assert_queue_fail on macOS
//! 15.3 and 26 alike (crash report 2026-11-08) — so this module is only ever
//! called from the helper process (`ime_daemon`), never from the app's own
//! main thread.

use crate::commands::ime::InputSourceInfo;

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::{CFBoolean, CFBooleanRef};
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_foundation::string::{CFString, CFStringRef};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

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
    // Iteration only borrows the array's elements (ItemRef): clone each into
    // an owned copy (CFType::clone retains), else they dangle with the array.
    arr.into_iter().map(|item| (*item).clone()).collect()
}

/* ---- input source reference cache -------------------------------------
The most expensive step in TIS is "enumerate every input source":
TISCreateInputSourceList plus reading 4 properties per source (measured
on this machine: ~33 ms cold, ~1-2 ms warm). select() runs on every mode
switch and must run on the Apple main thread (see on_main), so every
enumeration wastes a main thread slot. The set of input sources barely
changes within a session, so cache the whole thing: select() only
re-enumerates on a cache miss, or when the selection failed (the source
set changed). ---------------------------------------------------------- */

struct Sources(Mutex<Option<HashMap<String, CFType>>>);
// CFType is a +1 reference-counted object and retain/release are themselves
// thread safe; this is only read and written on the main thread (on_main),
// and the Mutex exists purely to satisfy the static types.
unsafe impl Send for Sources {}
unsafe impl Sync for Sources {}

fn sources_cache() -> &'static Sources {
    static CACHE: OnceLock<Sources> = OnceLock::new();
    CACHE.get_or_init(|| Sources(Mutex::new(None)))
}

/// Enumeration count. Gate use: one mode switch must not cause an
/// enumeration (see tests::cache_avoids_reenumeration).
static ENUMERATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Number of input source enumerations since the process started (tests).
#[cfg(test)]
pub fn enumeration_count() -> u64 {
    ENUMERATIONS.load(std::sync::atomic::Ordering::SeqCst)
}

/// Enumerates every selectable keyboard input source in one pass, keeping
/// the order the system gives: (id, display name, is CJK, owned CFType).
fn enumerate_sources() -> Vec<(String, String, bool, CFType)> {
    ENUMERATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut out = Vec::new();
    let keyboard_category =
        unsafe { CFString::wrap_under_get_rule(kTISCategoryKeyboardInputSource).to_string() };
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
        let name =
            unsafe { prop_string(raw, kTISPropertyLocalizedName) }.unwrap_or_else(|| id.clone());
        let langs = unsafe { prop_langs(raw, kTISPropertyInputSourceLanguages) };
        out.push((id, name, is_cjk(&langs), src));
    }
    out
}

/// Enumerates once and replaces the cache; returns the display info of this
/// enumeration (same order as the system enumeration).
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

/// Looks the reference up by id in the owned cache and runs `f` on it (under
/// the lock, so the reference stays valid for the whole call).
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

/// Enumerates enabled, selectable keyboard input sources. Used by the
/// settings panel; also refreshes the session cache that select() reads to
/// this enumeration's result.
pub fn selectable_sources() -> Vec<InputSourceInfo> {
    refresh_sources()
        .into_iter()
        .map(|(id, name, is_cjk)| InputSourceInfo { id, name, is_cjk })
        .collect()
}

/// Id of the active input source (single TIS call, no enumeration).
pub fn current_source_id() -> Option<String> {
    // HIToolbox answers this from a per-process copy that is only updated by
    // change notifications delivered on this thread's run loop. The helper
    // blocks on stdin and never runs one, so without this drain it keeps
    // reporting its own last select: after the user (or macOS on window
    // activation) changed the source, `select` saw "already active" and
    // skipped the switch. A zero-timeout drain costs microseconds.
    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::ZERO, false);
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
/// Goes through the session cache: on a hit the whole path is one
/// TISCopyCurrentKeyboardInputSource plus one TISSelectInputSource, with no
/// enumeration of all input sources. Only a lookup failure (the source was
/// just disabled, or newly installed) re-enumerates once and retries.
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

/// Pre-pays the cold TIS select initialization, invisibly. The first
/// `TISSelectInputSource` invocation costs ~88ms on this machine even when it
/// selects the already-active source (a no-op: status 0, no source change,
/// no icon flash); every later switch is 2–10ms. `select`'s already-active
/// dedup would skip the call and never pay that init, so this selects the
/// current source RAW, once per process. Runs inside the warm-up's
/// main-thread dispatch (see `list_impl`), keeping the cost off the first
/// keystroke that switches modes or leaves a formula.
pub fn warm_select_current() {
    static WARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if WARMED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if let Some(id) = current_source_id() {
        // The status is deliberately dropped: a failed warm-up only leaves
        // the cold cost on the first real switch (the pre-warm-up behavior)
        // — there is nothing to recover and no user-visible effect.
        let _ = with_source(&id, |src| unsafe { TISSelectInputSource(src) });
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {

    use super::*;
    use std::time::{Duration, Instant};

    /// The TIS cache and the enumeration count are process-wide global state,
    /// so the two tests must run serially.
    static TIS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TIS_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Gate: **one mode switch must not re-enumerate the input sources**.
    /// Enumeration (TISCreateInputSourceList plus reading 4 properties per
    /// source) is the most expensive step in TIS, and it always lands on the
    /// Apple main thread (see on_main), so a mode switch should only pay for
    /// "read the current source + select". Enumeration is allowed only on the
    /// first fill, and on a cache miss or a failed selection (the source set
    /// changed).
    #[test]
    fn cache_avoids_reenumeration() {
        let _guard = lock();
        let base = enumeration_count();
        let sources = selectable_sources();
        assert!(!sources.is_empty(), "本机应至少有一个可选键盘输入源");
        assert_eq!(enumeration_count(), base + 1, "枚举一次即填好缓存");

        for _ in 0..3 {
            let _ = select("com.apple.keylayout.ABC");
        }
        assert_eq!(
            enumeration_count(),
            base + 1,
            "命中缓存时 select 不许重新枚举输入源"
        );

        assert!(select("com.bnote.__nonexistent_layout__").is_err());
        assert_eq!(
            enumeration_count(),
            base + 2,
            "缓存未命中只重枚举一次（选失败的重试路径）"
        );
    }

    /// Probe, not a gate: prints the live TIS costs on this machine.
    ///
    /// This test binary has no NSApplication, so HIToolbox's main-queue
    /// assertion is never reached and the calls below run from a test thread.
    /// That does **not** make off-main TIS safe: an off-main enumeration in the
    /// deployed app traps with dispatch_assert_queue_fail on macOS 15.3 too
    /// (crash report 2026-11-08). Every entry point stays on `on_main`.
    #[test]
    fn probe_switch_sources() {
        let _guard = lock();
        let t0 = Instant::now();
        let current = current_source_id();
        println!("current: {current:?} (took {:?})", t0.elapsed());

        let sources = selectable_sources();
        println!(
            "{} selectable sources (took {:?}):",
            sources.len(),
            t0.elapsed()
        );
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
        let r = select(abc);
        println!("select ABC: {r:?} (took {:?})", t1.elapsed());
        std::thread::sleep(Duration::from_millis(150));
        println!("  current now: {:?}", current_source_id());

        let t2 = Instant::now();
        let r = select(sogou);
        println!("select Sogou: {r:?} (took {:?})", t2.elapsed());
        std::thread::sleep(Duration::from_millis(150));
        println!("  current now: {:?}", current_source_id());

        let t3 = Instant::now();
        let r = select(abc);
        println!("select ABC again: {r:?} (took {:?})", t3.elapsed());

        // Steady state: this is what every mode switch costs (cache hit ->
        // only TISCopyCurrentKeyboardInputSource + TISSelectInputSource, no
        // enumeration).
        let mut warm = Vec::new();
        for i in 0..6 {
            let target = if i % 2 == 0 { sogou } else { abc };
            let t = Instant::now();
            let _ = select(target);
            warm.push(t.elapsed());
            std::thread::sleep(Duration::from_millis(150));
        }
        println!(
            "warm switch x6 (cache hit): {:?}  (enumerations so far: {})",
            warm,
            enumeration_count()
        );

        // Restore the input source from before the test
        if let Some(orig) = current {
            let _ = select(&orig);
        }
    }
}

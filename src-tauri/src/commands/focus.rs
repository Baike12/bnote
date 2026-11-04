//! Focus mode: for a stretch of time bnote is the only thing on screen and the
//! user cannot switch to another app.
//!
//! Three layers stack on top of each other; if any one of them fails, the
//! result is only a degradation and never a broken app:
//!
//! 1. **Fake fullscreen** (window layer): the window fills the current screen
//!    and drops the native decorations. Deliberately **not** using macOS native
//!    fullscreen: native fullscreen owns a Space, and ⌘Tab sends the user into
//!    another app's Space where bnote is not on screen at all -- exactly the
//!    opposite of the goal.
//! 2. **Level exclusivity** (window layer): the level is raised to
//!    `NSStatusWindowLevel` (25) so it sits above the system menu bar (24);
//!    `collectionBehavior` gains `canJoinAllSpaces` + `fullScreenAuxiliary` +
//!    `stationary` -- switching Spaces or fullscreening another app still leaves
//!    bnote on top of that Space.
//! 3. **Focus steal-back**: whenever the app loses focus it is pulled back, so
//!    the app the user switched to never gets input.
//!
//! On top of that sits a **hard lock**: a CGEventTap swallows the chords macOS
//! acts on before any app sees them (⌘Tab / ⌘Space / Mission Control / Spaces)
//! plus the app's own quit chord (⌘Q) -- the only way to make "I pressed it and
//! nothing happened" real; it needs Accessibility permission, and without it
//! only the three layers above apply. During a focus session there is no way
//! out of the app (⌘⌥Esc force quit cannot be blocked, and reopening the app
//! resumes the same session).
//!
//! The hard lock covers the mouse too: when the Dock auto-hides, hovering the
//! bottom edge of the screen raises the Dock **above** the fullscreen window
//! (the window level cannot hold it down, level 25 does not help either), so
//! clicking a Dock icon still switches away. Hence the tap is also attached to
//! mouse-down: when the press lands inside the visible Dock strip, the whole
//! gesture (Down/Dragged/Up) is swallowed. The strip is polled from a separate
//! thread through the Accessibility API (AX) -- AX is synchronous IPC, and
//! calling it inside the tap callback would time the callback out and get the
//! tap disabled by the system; the callback itself only does an in-memory read
//! and a coordinate comparison.
//!
//! Restore discipline: before locking, snapshot the level / collectionBehavior
//! / styleMask / inner size / position, and on unlock restore each item one by
//! one. Missing a single item leaves the window permanently unable to behave
//! normally (other apps stay pinned under bnote, and the user cannot tell
//! why), so the snapshot and the restore live in the same module and on the
//! same code path.
//!
//! **The window level is the truth.** `locked` is read back from the native
//! level instead of a store flag, a lock repairs a window it finds still raised
//! before taking its own snapshot, and an unlock never reports success without
//! restoring. Each of those three was a way the window used to stay at level 25
//! above every other app while the frontend believed the session had ended.
//!
//! The stylesheet has a matching constraint: the styleMask carries
//! `FullSizeContentView` (macOS's overlay title bar), so the restore must use
//! the snapshot's **original** value and never `set_decorations(true)` -- tao's
//! `true` branch only yields Closable|Miniaturizable|Resizable|Titled, which
//! strips the overlay title bar and leaves a native title bar at the top of the
//! window.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::AppHandle;

use super::CmdResult;
use crate::main_window;

/// Current focus mode state (read back by the frontend).
#[derive(Serialize, Clone, Copy, Debug, Default)]
pub struct FocusStatus {
    /// Whether the fake-fullscreen lock is on.
    pub locked: bool,
    /// Whether the hard lock is **armed** (the user turned the switch on, meaning
    /// "swallow system-wide shortcuts during a focus session").
    pub hard_lock: bool,
    /// Whether the hard lock is **actively intercepting**: true only while a
    /// pomodoro is running.
    /// Armed is not the same as intercepting: outside a focus session ⌘Tab must
    /// keep working as usual.
    pub hard_active: bool,
    /// Whether Accessibility permission has been granted -- the precondition for
    /// the hard lock. Without it the hard lock cannot be armed.
    pub trusted: bool,
    /// How many key events the hard lock's tap has seen (not a count of swallowed
    /// events; just evidence that the tap is alive).
    pub seen: u32,
    /// How many key events the hard lock swallowed.
    pub swallowed: u32,
}

/// Window snapshot taken before locking; restored item by item on unlock.
#[derive(Debug, Clone, Copy)]
struct WindowSnapshot {
    level: isize,
    behavior: usize,
    style_mask: usize,
    /// Inner size (logical pixels).
    inner: (f64, f64),
    /// Window position (logical pixels).
    pos: (f64, f64),
}

static LOCKED: AtomicBool = AtomicBool::new(false);
static HARD_LOCK: AtomicBool = AtomicBool::new(false);
static HARD_ACTIVE: AtomicBool = AtomicBool::new(false);
static SNAPSHOT: Mutex<Option<WindowSnapshot>> = Mutex::new(None);

/// Reports the current focus mode state.
///
/// `locked` is read from the window: a flag can disagree with the window (an
/// unlock that did not reach it, a window restored outside this module), and a
/// stale `false` makes the frontend save the locked full-screen geometry as the
/// user's window size (`src/lib/windowState.ts`) and stop repairing the lock.
/// The static below is only the cheap mirror used by the focus steal-back.
#[tauri::command]
pub fn focus_status(app: AppHandle) -> CmdResult<FocusStatus> {
    let locked = mac::is_locked(&app);
    LOCKED.store(locked, Ordering::Relaxed);
    Ok(FocusStatus {
        locked,
        hard_lock: HARD_LOCK.load(Ordering::Relaxed),
        hard_active: HARD_ACTIVE.load(Ordering::Relaxed),
        trusted: mac::trusted(),
        seen: mac::seen_count(),
        swallowed: mac::swallowed_count(),
    })
}

/// Enters the lock: fake fullscreen + level exclusivity + focus steal-back.
/// Idempotent no-op when the window is already locked.
#[tauri::command]
pub fn focus_lock(app: AppHandle) -> CmdResult<FocusStatus> {
    if !mac::is_locked(&app) {
        mac::lock(&app)?;
    }
    focus_status(app)
}

/// Leaves the lock: puts every snapshotted item back exactly as it was.
///
/// Unconditional and idempotent: the native window is the truth.
#[tauri::command]
pub fn focus_unlock(app: AppHandle) -> CmdResult<FocusStatus> {
    mac::unlock(&app)?;
    focus_status(app)
}

/// Arms or disarms the hard lock (swallowing system-wide shortcuts).
///
/// Arming alone intercepts nothing: real key swallowing starts when a pomodoro
/// runs (`focus_set_hard_lock_active`). Outside a focus session ⌘Tab must keep
/// working as usual -- otherwise "turn on the hard lock" would mean trapping
/// the user inside the app.
///
/// Without Accessibility permission this reports the error instead of degrading
/// silently: the user would think the app was locked while ⌘Tab still works,
/// which is worse than being told up front that it cannot be locked.
#[tauri::command]
pub fn focus_set_hard_lock(app: AppHandle, enabled: bool) -> CmdResult<FocusStatus> {
    mac::set_hard_lock(enabled)?;
    HARD_LOCK.store(enabled, Ordering::Relaxed);
    if !enabled {
        // Disarming stops immediately: the lock must not stay on until the end
        // of the current session.
        mac::set_hard_lock_active(false)?;
        HARD_ACTIVE.store(false, Ordering::Relaxed);
    }
    focus_status(app)
}

/// Toggles real interception when a pomodoro starts or ends. The frontend
/// passes true only while the timer runs.
#[tauri::command]
pub fn focus_set_hard_lock_active(app: AppHandle, active: bool) -> CmdResult<FocusStatus> {
    if active && !HARD_LOCK.load(Ordering::Relaxed) {
        return Err("NOT_ARMED: 硬锁没有武装,不需要拦截".into());
    }
    mac::set_hard_lock_active(active)?;
    HARD_ACTIVE.store(active, Ordering::Relaxed);
    focus_status(app)
}

/// Installs the "steal focus back" listener. Call once from setup.
pub fn install_focus_guard(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let guard = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            mac::maybe_refocus(&guard);
        }
    });
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicPtr, AtomicU32, Ordering};
    use std::time::Duration;

    use core_foundation::base::{CFRelease, TCFType};
    use core_foundation::string::CFString;
    use objc2::{class, msg_send};
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSApplication, NSStatusWindowLevel, NSWindowStyleMask};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::CGEventFlags;
    use tauri::{AppHandle, LogicalPosition, LogicalSize, Window};

    use super::{main_window, HARD_ACTIVE, HARD_LOCK, LOCKED, SNAPSHOT, WindowSnapshot};

    /// Collection behavior bits (canJoinAllSpaces / stationary / fullScreenAuxiliary).
    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const STATIONARY: usize = 1 << 4;
    const FULLSCREEN_AUXILIARY: usize = 1 << 8;

    /// `NSNormalWindowLevel`: the level of a window that is not locked.
    const NORMAL_LEVEL: isize = 0;

    /// Whether a window found at this level has to be repaired before a lock may
    /// snapshot it. Anything but the normal level means an earlier stretch never
    /// unlocked; snapshotting that state would record the locked window as the
    /// normal one, and every later restore would faithfully reproduce "always on
    /// top" -- the exact failure the snapshot exists to prevent.
    fn needs_repair(level: isize) -> bool {
        level != NORMAL_LEVEL
    }

    // Accessibility permission (AXIsProcessTrusted). The hard lock has to
    // swallow system-wide key events, and without this permission the event tap
    // cannot be created.
    //
    // The variant with a prompt makes the system show the authorization sheet
    // itself when permission is missing (the sheet has an "open System
    // Settings" button) -- a bare "permission required" message leaves the user
    // with no idea where to click.
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Makes macOS show the "bnote wants to control this computer" authorization prompt.
    fn prompt_accessibility() {
        unsafe {
            let dict: *mut AnyObject = msg_send![class!(NSMutableDictionary), new];
            let key: *mut AnyObject = msg_send![
                class!(NSString),
                stringWithUTF8String: b"AXTrustedCheckOptionPrompt\0".as_ptr() as *const c_char
            ];
            let value: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: true];
            let _: () = msg_send![dict, setObject: value, forKey: key];
            let _ = AXIsProcessTrustedWithOptions(dict as *const c_void);
        }
    }

    // ---- Dock strip (the hard lock blocks Dock clicks) ----------------------
    //
    // The Dock's visible area can only be obtained from the accessibility tree:
    // in WindowServer the Dock's window spans the whole screen (measured bounds
    // = 2560x1440), so the window list cannot pick out that strip; in AX the
    // Dock's AXList child element *is* the strip (when hidden, y = screen
    // height and the whole strip is off-screen).

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementCopyAttributeValue(
            element: *const c_void,
            attribute: *const c_void,
            value: *mut *const c_void,
        ) -> i32;
        fn AXValueGetValue(value: *const c_void, value_type: u32, out: *mut c_void) -> bool;
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    }

    /// kAXValueCGPointType / kAXValueCGSizeType (AXValueConstants.h).
    const AX_VALUE_CG_POINT: u32 = 1;
    const AX_VALUE_CG_SIZE: u32 = 2;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetActiveDisplayList(
            max_displays: u32,
            displays: *mut u32,
            count: *mut u32,
        ) -> i32;
        fn CGDisplayBounds(display: u32) -> CGRect;
    }

    /// Visible Dock strip (global screen coordinates, top-left origin): [x, y, w, h].
    /// None = the whole Dock is off-screen (auto-hiding), in which case no click
    /// is blocked at all.
    static DOCK_BAND: Mutex<Option<[f64; 4]>> = Mutex::new(None);
    /// The polling thread is started only once.
    static DOCK_WATCHED: AtomicBool = AtomicBool::new(false);
    /// Dock process id; AX queries fail after the Dock restarts, so clear it to
    /// 0 and look it up again.
    static DOCK_PID: AtomicI32 = AtomicI32::new(0);
    /// Whether this mouse gesture started with a press inside the Dock: the
    /// following Dragged/Up are swallowed together, so no half-gesture is left
    /// over for another window.
    static DOCK_GESTURE: AtomicBool = AtomicBool::new(false);
    /// Seeing the Dock entirely off-screen means it auto-hides, so when it rises
    /// it covers the window and must be blocked. A permanent Dock is always on
    /// screen, and the locked window (level 25) already covers it, so blocking
    /// it would only make the app's own bottom strip unclickable -- hence it is
    /// not blocked.
    static DOCK_AUTOHIDE: AtomicBool = AtomicBool::new(false);

    /// Padding added around the strip: polling lags, and during the Dock's rise
    /// animation the strip is moving up.
    const DOCK_PAD: f64 = 6.0;

    unsafe fn ns_string(text: &str) -> *mut AnyObject {
        let c = std::ffi::CString::new(text).unwrap_or_default();
        let s: *mut AnyObject = msg_send![class!(NSString), alloc];
        msg_send![s, initWithUTF8String: c.as_ptr()]
    }

    /// The Dock's pid. NSRunningApplication is an AppKit class; only its class
    /// method is used here, to avoid pulling in another objc2-app-kit feature.
    fn dock_pid() -> Option<i32> {
        let cached = DOCK_PID.load(Ordering::Relaxed);
        if cached > 0 {
            return Some(cached);
        }
        unsafe {
            let bundle = ns_string("com.apple.dock");
            let apps: *mut AnyObject = msg_send![
                class!(NSRunningApplication),
                runningApplicationsWithBundleIdentifier: bundle
            ];
            let _: () = msg_send![bundle, release];
            if apps.is_null() {
                return None;
            }
            let app: *mut AnyObject = msg_send![apps, firstObject];
            if app.is_null() {
                return None;
            }
            let pid: i32 = msg_send![app, processIdentifier];
            if pid <= 0 {
                return None;
            }
            DOCK_PID.store(pid, Ordering::Relaxed);
            Some(pid)
        }
    }

    /// Reads one AX attribute (Copy rule: +1, the caller owns the CFRelease).
    unsafe fn ax_attr(element: *const c_void, name: &str) -> Option<*const c_void> {
        let attr = CFString::new(name);
        let mut value: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            element,
            attr.as_concrete_TypeRef().cast(),
            &mut value,
        );
        if err == 0 && !value.is_null() {
            Some(value)
        } else {
            None
        }
    }

    unsafe fn ax_point(element: *const c_void, name: &str) -> Option<CGPoint> {
        let value = ax_attr(element, name)?;
        let mut out = CGPoint { x: 0.0, y: 0.0 };
        let ok = AXValueGetValue(value, AX_VALUE_CG_POINT, (&mut out as *mut CGPoint).cast());
        CFRelease(value);
        ok.then_some(out)
    }

    unsafe fn ax_size(element: *const c_void, name: &str) -> Option<CGSize> {
        let value = ax_attr(element, name)?;
        let mut out = CGSize { width: 0.0, height: 0.0 };
        let ok = AXValueGetValue(value, AX_VALUE_CG_SIZE, (&mut out as *mut CGSize).cast());
        CFRelease(value);
        ok.then_some(out)
    }

    /// The Dock's visible strip. When hidden the AXList sits below the bottom
    /// edge of the screen (y == screen height); it is returned as-is and
    /// rejected by `on_screen`.
    fn dock_strip() -> Option<[f64; 4]> {
        let pid = dock_pid()?;
        let strip = unsafe {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                return None;
            }
            let mut out = None;
            if let Some(children) = ax_attr(app, "AXChildren") {
                if CFArrayGetCount(children) > 0 {
                    // children[0] is the AXList: the whole Dock (without
                    // whatever lives in the menu bar).
                    let list = CFArrayGetValueAtIndex(children, 0);
                    if !list.is_null() {
                        if let (Some(pos), Some(size)) =
                            (ax_point(list, "AXPosition"), ax_size(list, "AXSize"))
                        {
                            if size.width > 1.0 && size.height > 1.0 {
                                out = Some([pos.x, pos.y, size.width, size.height]);
                            }
                        }
                    }
                }
                CFRelease(children);
            }
            CFRelease(app);
            out
        };
        if strip.is_none() {
            // Failing to find it most likely means the Dock restarted with a
            // new pid: look it up again next time.
            DOCK_PID.store(0, Ordering::Relaxed);
        }
        strip
    }

    /// Whether the strip intersects any display in use. A hidden Dock lies
    /// entirely off-screen, so the intersection is 0.
    fn on_screen(band: [f64; 4]) -> bool {
        let [x, y, w, h] = band;
        let mut displays = [0u32; 8];
        let mut count = 0u32;
        let ok = unsafe {
            CGGetActiveDisplayList(displays.len() as u32, displays.as_mut_ptr(), &mut count)
        } == 0;
        if !ok {
            return false;
        }
        displays.iter().take(count as usize).any(|&id| {
            let b = unsafe { CGDisplayBounds(id) };
            (x + w).min(b.origin.x + b.size.width) - x.max(b.origin.x) > 0.0
                && (y + h).min(b.origin.y + b.size.height) - y.max(b.origin.y) > 0.0
        })
    }

    fn in_dock_band(point: CGPoint) -> bool {
        let band = *DOCK_BAND.lock().unwrap_or_else(|e| e.into_inner());
        let Some([x, y, w, h]) = band else {
            return false;
        };
        point.x >= x - DOCK_PAD
            && point.x <= x + w + DOCK_PAD
            && point.y >= y - DOCK_PAD
            && point.y <= y + h + DOCK_PAD
    }

    /// Polls the Dock strip. AX is only queried while the hard lock is really
    /// active (a pomodoro is running); otherwise the strip is written as None
    /// and nothing is blocked. When the Dock is visible the poll speeds up to
    /// ~60ms: during the rise animation the strip is moving up, and a slower
    /// poll would miss clicks in the early part of the animation.
    fn ensure_dock_watch() {
        if DOCK_WATCHED.swap(true, Ordering::Relaxed) {
            return;
        }
        let _ = std::thread::Builder::new()
            .name("bnote-dock-watch".into())
            .spawn(|| loop {
                let strip = if HARD_LOCK.load(Ordering::Relaxed)
                    && HARD_ACTIVE.load(Ordering::Relaxed)
                {
                    dock_strip()
                } else {
                    None
                };
                if let Some(b) = strip {
                    if !on_screen(b) {
                        DOCK_AUTOHIDE.store(true, Ordering::Relaxed);
                    }
                }
                let band = strip.filter(|b| {
                    on_screen(*b) && DOCK_AUTOHIDE.load(Ordering::Relaxed)
                });
                let visible = band.is_some();
                *DOCK_BAND.lock().unwrap_or_else(|e| e.into_inner()) = band;
                std::thread::sleep(Duration::from_millis(if visible { 60 } else { 250 }));
            });
    }

    /// The window's native level (NSWindowLevel).
    fn native_level(ns: *mut AnyObject) -> isize {
        unsafe { msg_send![ns, level] }
    }

    fn set_native_level(ns: *mut AnyObject, level: isize) {
        unsafe { msg_send![ns, setLevel: level] }
    }

    fn native_behavior(ns: *mut AnyObject) -> usize {
        unsafe { msg_send![ns, collectionBehavior] }
    }

    fn set_native_behavior(ns: *mut AnyObject, behavior: usize) {
        unsafe { msg_send![ns, setCollectionBehavior: behavior] }
    }

    fn native_style_mask(ns: *mut AnyObject) -> usize {
        unsafe { msg_send![ns, styleMask] }
    }

    /// Changes the styleMask and hands first responder back to the webview.
    ///
    /// Deliberately **not** using tao's `set_decorations`: it changes the mask
    /// asynchronously through GCD, and that late change would overwrite our
    /// exact restore value (tao only gives
    /// Titled|Closable|Miniaturizable|Resizable, dropping FullSizeContentView,
    /// so the overlay title bar is gone and a native title bar appears at the
    /// top of the window). We change it synchronously ourselves -- we are on
    /// the main thread anyway (`setStyleMask:` is only safe on the main thread).
    ///
    /// Afterwards `makeFirstResponder(webview)` is mandatory: otherwise the
    /// window is not key and keyboard input stops working (tao's own
    /// `set_style_mask` does the same).
    fn set_style_mask(ns: *mut AnyObject, view: *mut AnyObject, mask: usize) {
        unsafe {
            let _: () = msg_send![ns, setStyleMask: mask];
            let _: bool = msg_send![ns, makeFirstResponder: view];
        }
    }

    /// The styleMask of a borderless window: the same value tao's "no
    /// decorations" branch uses.
    fn borderless_mask() -> usize {
        (NSWindowStyleMask::Borderless | NSWindowStyleMask::Resizable).0 as usize
    }

    /// Runs a block of AppKit work on the main thread and waits for it.
    ///
    /// AppKit is not thread safe. Tauri's synchronous commands run on the thread
    /// the IPC arrived on (usually the main thread), but a command may also be
    /// called from elsewhere, so everything goes through here instead of
    /// gambling on the thread at each call site. Already on the main thread
    /// means run it directly, so we never wait on ourselves.
    fn on_main_thread<T: Send + 'static>(
        app: &AppHandle,
        f: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        if objc2::MainThreadMarker::new().is_some() {
            return f();
        }
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("MAIN_THREAD: {}", e))?;
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(result) => result,
            Err(e) => Err(format!("MAIN_THREAD_TIMEOUT: {}", e)),
        }
    }

    /// Reads the main window's current level, on the main thread.
    ///
    /// `None` when the window is gone or the native handle is unavailable; the
    /// caller treats that as "not locked".
    fn window_level(app: &AppHandle) -> Option<isize> {
        let app = app.clone();
        let inner_app = app.clone();
        on_main_thread(&app, move || {
            let win = main_window(&inner_app).ok_or("NO_WINDOW")?;
            let ns = win.ns_window().map_err(|e| format!("ns_window: {e}"))? as *mut AnyObject;
            Ok(native_level(ns))
        })
        .ok()
    }

    /// Whether the window is currently at the locked level.
    pub fn is_locked(app: &AppHandle) -> bool {
        window_level(app) == Some(NSStatusWindowLevel)
    }

    pub fn lock(app: &AppHandle) -> Result<(), String> {
        let app = app.clone();
        let inner_app = app.clone();
        on_main_thread(&app, move || {
            let win = main_window(&inner_app).ok_or("NO_WINDOW: 主窗口不在")?;
            let ns = win
                .ns_window()
                .map_err(|e| format!("ns_window: {e}"))? as *mut AnyObject;
            let view = win
                .ns_view()
                .map_err(|e| format!("ns_view: {e}"))? as *mut AnyObject;

            // A raised level means the previous stretch never unlocked. Repair
            // the window first, so the snapshot below records the normal state
            // and not a locked one.
            if needs_repair(native_level(ns)) {
                restore(&win, ns, view)?;
            }

            let scale = win.scale_factor().unwrap_or(1.0);
            // Every step's error carries the step name: the frontend shows the
            // message verbatim, so a failed lock names the exact native call.
            let inner = win
                .inner_size()
                .map_err(|e| format!("inner_size: {e}"))?
                .to_logical::<f64>(scale);
            let pos = win
                .outer_position()
                .map_err(|e| format!("outer_position: {e}"))?
                .to_logical::<f64>(scale);

            // Snapshot: restored item by item on unlock; missing a single item
            // is an incident.
            let snap = WindowSnapshot {
                level: native_level(ns),
                behavior: native_behavior(ns),
                style_mask: native_style_mask(ns),
                inner: (inner.width, inner.height),
                pos: (pos.x, pos.y),
            };

            // Strip the decorations first: once they are gone inner size ==
            // outer size, so filling the screen is exact (otherwise it would
            // fall short by a strip).
            set_style_mask(ns, view, borderless_mask());

            // Fill the current screen (the whole thing, including the menu bar
            // strip -- level 25 covers the menu bar, so the picture really is
            // only bnote). With a single display, the current one is it.
            let monitor = win
                .current_monitor()
                .map_err(|e| format!("current_monitor: {e}"))?
                .or(win
                    .primary_monitor()
                    .map_err(|e| format!("primary_monitor: {e}"))?)
                .ok_or("NO_MONITOR: 找不到屏幕")?;
            let m_scale = win.scale_factor().unwrap_or(1.0);
            let m_size = monitor.size().to_logical::<f64>(m_scale);
            let m_pos = monitor.position().to_logical::<f64>(m_scale);
            win.set_size(LogicalSize::new(m_size.width, m_size.height))
                .map_err(|e| format!("set_size: {e}"))?;
            win.set_position(LogicalPosition::new(m_pos.x, m_pos.y))
                .map_err(|e| format!("set_position: {e}"))?;

            // Level exclusivity: above the system menu bar (24); across Spaces
            // and accompanying fullscreen, so it stays on top wherever the user
            // goes.
            set_native_level(ns, NSStatusWindowLevel);
            set_native_behavior(
                ns,
                snap.behavior | CAN_JOIN_ALL_SPACES | STATIONARY | FULLSCREEN_AUXILIARY,
            );

            *SNAPSHOT.lock().unwrap_or_else(|e| e.into_inner()) = Some(snap);
            Ok(())
        })
    }

    /// Puts the window back into a normal state: the snapshot item by item when
    /// there is one, and the bare minimum (normal level, our collection bits
    /// removed) when there is not.
    ///
    /// Shared by unlock and by a lock that finds the window still raised, so
    /// there is exactly one restore path. The snapshot is only cleared by the
    /// caller when every step succeeded: a restore that failed must stay
    /// retryable.
    fn restore(win: &Window, ns: *mut AnyObject, view: *mut AnyObject) -> Result<(), String> {
        let snap = *SNAPSHOT.lock().unwrap_or_else(|e| e.into_inner());
        match snap {
            Some(snap) => {
                // Decorations: put the snapshotted styleMask back verbatim
                // (with the FullSizeContentView overlay title bar). Use our own
                // synchronous path so tao's asynchronous change cannot
                // overwrite it.
                set_style_mask(ns, view, snap.style_mask);

                set_native_level(ns, snap.level);
                set_native_behavior(ns, snap.behavior);

                win.set_size(LogicalSize::new(snap.inner.0, snap.inner.1))
                    .map_err(|e| format!("set_size: {e}"))?;
                win.set_position(LogicalPosition::new(snap.pos.0, snap.pos.1))
                    .map_err(|e| format!("set_position: {e}"))?;
            }
            None => {
                // No snapshot to restore: the locked geometry is gone, but a
                // window left above every other app is worse. Drop the level and
                // remove exactly the collection bits we added.
                set_native_level(ns, NORMAL_LEVEL);
                let behavior =
                    native_behavior(ns) & !(CAN_JOIN_ALL_SPACES | STATIONARY | FULLSCREEN_AUXILIARY);
                set_native_behavior(ns, behavior);
            }
        }
        Ok(())
    }

    pub fn unlock(app: &AppHandle) -> Result<(), String> {
        let app = app.clone();
        let inner_app = app.clone();
        on_main_thread(&app, move || {
            // A missing window is an error, never a success: reporting "ok" here
            // is what left the window at level 25 above every other app while the
            // frontend believed the session had ended.
            let win = main_window(&inner_app).ok_or("NO_WINDOW: 主窗口不在")?;
            let ns = win
                .ns_window()
                .map_err(|e| format!("ns_window: {e}"))? as *mut AnyObject;
            let view = win
                .ns_view()
                .map_err(|e| format!("ns_view: {e}"))? as *mut AnyObject;

            restore(&win, ns, view)?;
            *SNAPSHOT.lock().unwrap_or_else(|e| e.into_inner()) = None;
            Ok(())
        })
    }

    /// Focus steal-back: pulls bnote back to the foreground so the app the
    /// user switched to gets no input.
    ///
    /// A native modal sheet (pick repository / pick file) resigns the app as
    /// key on its own, and pulling focus back then fights the dialog -- reject
    /// that case with `modalWindow`. When the window is minimized or hidden,
    /// tao's `set_focus` does nothing by itself, so a minimized window is never
    /// popped back up.
    pub fn maybe_refocus(window: &Window) {
        if !LOCKED.load(Ordering::Relaxed) {
            return;
        }
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        if app.modalWindow().is_some() {
            return;
        }
        if !app.isActive() {
            let _ = window.set_focus();
        }
    }

    // ---- Hard lock (CGEventTap) -----------------------------------------------

    /// The event tap's MachPort; used to enable/disable the tap when the hard
    /// lock is turned on or off.
    static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    /// Whether the system authorization sheet has already been shown. Each
    /// process shows it only once: toggling the switch would otherwise re-prompt
    /// every time, and macOS only ever prompts once per app anyway -- the
    /// "grant access" button in the UI covers the retry.
    static PROMPTED: AtomicBool = AtomicBool::new(false);

    /// Number of key events the tap has seen / number of key events it swallowed.
    ///
    /// These two counters are the evidence that the hard lock is actually alive:
    /// synthesized events travel through the injection channel and the tap never
    /// sees them, only real keyboard events get in -- if the counters do not
    /// move, the tap was never created or the system disabled it.
    static SEEN: AtomicU32 = AtomicU32::new(0);
    static SWALLOWED: AtomicU32 = AtomicU32::new(0);

    pub fn seen_count() -> u32 {
        SEEN.load(Ordering::Relaxed)
    }

    pub fn swallowed_count() -> u32 {
        SWALLOWED.load(Ordering::Relaxed)
    }

    /// Combinations the hard lock swallows: key code (ANSI layout) -> the
    /// modifiers that must be held down at the same time.
    ///
    /// Two groups, nothing else:
    ///
    /// - **Chords macOS acts on before any app sees them**: ⌘Tab (switch app),
    ///   ⌘Space (Spotlight), ⌘` (switch windows of the same app), ⌃↑/⌃↓ (Mission
    ///   Control), ⌃⌘←/→ (switch Space). The HID-level tap is the only thing that
    ///   can stop them: by the time an app could ignore the key, the system has
    ///   already switched away.
    /// - **⌘Q**, the app's own quit chord: "no leaving midway" includes quitting
    ///   the app. The system-level force quit (⌘⌥Esc) cannot be blocked; it is
    ///   the OS's last exit -- and even after a kill the timer state and endsAt
    ///   are on disk, so reopening the app resumes the session and re-locks.
    ///
    /// ⌘H / ⌘M / ⌘W are deliberately **not** listed: `lib.rs::install_menu`
    /// (f6b6b44) gives the menu no key equivalents for them, so they reach the
    /// webview as ordinary app chords and belong to the keybinding layer -- ⌘M
    /// is the default binding of `edit.insert-math-block`, ⌘W of
    /// `region.focus-agent` in the notes region. Swallowing them here killed
    /// those bindings during a session, and nothing needs blocking: a menu that
    /// owns no chord cannot hide or close the window on its own.
    const BLOCKED: &[(u64, u64)] = &[
        (48, CGEventFlags::MaskCommand.0), // Tab
        (49, CGEventFlags::MaskCommand.0), // Space
        (50, CGEventFlags::MaskCommand.0), // `
        (12, CGEventFlags::MaskCommand.0), // Q (the app's quit chord)
        (126, CGEventFlags::MaskControl.0), // Up (Mission Control)
        (125, CGEventFlags::MaskControl.0), // Down
        (
            123,
            CGEventFlags::MaskControl.0 | CGEventFlags::MaskCommand.0,
        ), // Left (switch Space)
        (
            124,
            CGEventFlags::MaskControl.0 | CGEventFlags::MaskCommand.0,
        ), // Right
    ];

    fn should_swallow(code: i64, flags: u64) -> bool {
        BLOCKED
            .iter()
            .any(|(key, need)| code == *key as i64 && flags & need == *need)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const CMD: u64 = CGEventFlags::MaskCommand.0;

        #[test]
        fn a_raised_window_is_repaired_before_it_is_snapshotted() {
            // Normal level: nothing to repair.
            assert!(!needs_repair(NORMAL_LEVEL));
            // The locked level and any other raised level mean the previous
            // stretch never unlocked; snapshotting it would store the locked
            // state as the normal one (the "always on top" bug).
            assert!(needs_repair(NSStatusWindowLevel));
            assert!(needs_repair(3)); // NSFloatingWindowLevel
        }

        #[test]
        fn swallows_the_system_chords_and_quit_only() {
            // System-handled chords: only the HID tap can stop them.
            for code in [48i64, 49, 50, 12] {
                assert!(should_swallow(code, CMD), "⌘ code {code} must be swallowed");
            }
            // App chords the menu no longer claims: swallowing these would kill
            // the user's own bindings (⌘M math block, ⌘W region.focus-agent).
            for code in [4i64, 46, 13] {
                assert!(!should_swallow(code, CMD), "⌘ code {code} must not be swallowed");
            }
            // The control chords need Control; ⌘ alone must not match.
            assert!(!should_swallow(126, CMD));
            assert!(!should_swallow(123, 0));
        }
    }

    /// The event tap's callback: a blocked combination returns null, which eats
    /// the event.
    ///
    /// macOS disables the tap when the callback times out or the user generates
    /// too much input (`kCGEventTapDisabledBy...`), which makes the hard lock
    /// fail silently -- so the tap has to be re-enabled.
    unsafe extern "C-unwind" fn tap_callback(
        _proxy: objc2_core_graphics::CGEventTapProxy,
        event_type: objc2_core_graphics::CGEventType,
        event: std::ptr::NonNull<objc2_core_graphics::CGEvent>,
        _user_info: *mut c_void,
    ) -> *mut objc2_core_graphics::CGEvent {
        use objc2_core_graphics::{CGEvent, CGEventField, CGEventType};

        const DISABLED_BY_TIMEOUT: u32 = 0xFFFF;
        const DISABLED_BY_USER_INPUT: u32 = 0xFFFE;

        if event_type.0 == DISABLED_BY_TIMEOUT || event_type.0 == DISABLED_BY_USER_INPUT {
            set_tap_enabled(true);
            return event.as_ptr();
        }
        if !HARD_LOCK.load(Ordering::Relaxed) || !HARD_ACTIVE.load(Ordering::Relaxed) {
            return event.as_ptr();
        }
        let et = event_type.0;
        let keyboard = et == CGEventType::KeyDown.0 || et == CGEventType::KeyUp.0;
        if !keyboard {
            // Mouse: only press/release/drag matter; everything else (scroll,
            // movement) passes through untouched.
            let down = et == CGEventType::LeftMouseDown.0
                || et == CGEventType::RightMouseDown.0
                || et == CGEventType::OtherMouseDown.0;
            let up = et == CGEventType::LeftMouseUp.0
                || et == CGEventType::RightMouseUp.0
                || et == CGEventType::OtherMouseUp.0;
            let dragged = et == CGEventType::LeftMouseDragged.0
                || et == CGEventType::RightMouseDragged.0
                || et == CGEventType::OtherMouseDragged.0;
            if !(down || up || dragged) {
                return event.as_ptr();
            }
            let event_ref = unsafe { event.as_ref() };
            if down {
                let hit = in_dock_band(CGEvent::location(Some(event_ref)));
                DOCK_GESTURE.store(hit, Ordering::Relaxed);
                if hit {
                    return std::ptr::null_mut();
                }
                return event.as_ptr();
            }
            // The press landed on the Dock: swallow the whole gesture. Reset
            // on release.
            if DOCK_GESTURE.load(Ordering::Relaxed) {
                if up {
                    DOCK_GESTURE.store(false, Ordering::Relaxed);
                }
                return std::ptr::null_mut();
            }
            return event.as_ptr();
        }
        let event_ref = unsafe { event.as_ref() };
        let flags = CGEvent::flags(Some(event_ref)).0;
        let code = CGEvent::integer_value_field(Some(event_ref), CGEventField::KeyboardEventKeycode);
        SEEN.fetch_add(1, Ordering::Relaxed);
        if should_swallow(code, flags) {
            SWALLOWED.fetch_add(1, Ordering::Relaxed);
            return std::ptr::null_mut();
        }
        event.as_ptr()
    }

    fn set_tap_enabled(enabled: bool) {
        let ptr = TAP_PORT.load(Ordering::Acquire);
        if ptr.is_null() {
            return;
        }
        // The mouse-up can be missed between disabling and re-enabling the tap:
        // the gesture state must not survive across segments, or the next drag
        // would be swallowed.
        DOCK_GESTURE.store(false, Ordering::Relaxed);
        unsafe {
            let port = &*(ptr as *const objc2_core_foundation::CFMachPort);
            objc2_core_graphics::CGEvent::tap_enable(port, enabled);
        }
    }

    /// Arms the hard lock: only checks permission, **does not create the tap**.
    ///
    /// Real interception is turned on by `set_hard_lock_active` when a pomodoro
    /// starts -- arming only expresses the intent "I agree to swallow
    /// system-wide shortcuts during a focus session"; it does not change whether
    /// the user can switch away right now.
    pub fn set_hard_lock(enabled: bool) -> Result<(), String> {
        if !enabled {
            return Ok(());
        }
        if !trusted() {
            // Show the system authorization sheet first, then report the error:
            // once the user allows it, the frontend re-checks the permission
            // when the window comes back to the foreground and arms the hard
            // lock automatically -- no second trip to the switch.
            if !PROMPTED.swap(true, Ordering::Relaxed) {
                prompt_accessibility();
            }
            return Err(
                "NEEDS_ACCESSIBILITY: 硬锁需要辅助功能权限(已弹出系统授权提示,允许后自动打开)"
                    .into(),
            );
        }
        Ok(())
    }

    /// Starts/stops real interception. The frontend toggles it when a pomodoro
    /// starts (and stops).
    ///
    /// Stop: turn the tap off -- the thread stays, the tap stays, so the next
    /// start does not have to rebuild it. Start: make sure the tap exists and
    /// is enabled. Without permission it does not prompt (starting a session
    /// must not raise a system sheet) and just reports the error.
    pub fn set_hard_lock_active(active: bool) -> Result<(), String> {
        if !active {
            set_tap_enabled(false);
            return Ok(());
        }
        if !trusted() {
            return Err(
                "NEEDS_ACCESSIBILITY: 硬锁需要辅助功能权限,这一段番茄钟不会拦截切换".into(),
            );
        }
        ensure_tap()?;
        ensure_dock_watch();
        set_tap_enabled(true);
        Ok(())
    }

    /// Builds the event tap once, on a dedicated thread's run loop (it does not
    /// take the main thread).
    fn ensure_tap() -> Result<(), String> {
        use objc2_core_graphics::{
            CGEvent, CGEventMask, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
            CGEventType,
        };

        if !TAP_PORT.load(Ordering::Acquire).is_null() {
            return Ok(());
        }

        // Keys and mouse: the keyboard swallows system-wide shortcuts, the Dock
        // mouse gestures block click-away. Mouse movement is not hooked: every
        // move entering the callback is pointless.
        let mask: CGEventMask = (1u64 << CGEventType::KeyDown.0)
            | (1u64 << CGEventType::KeyUp.0)
            | (1u64 << CGEventType::FlagsChanged.0)
            | (1u64 << CGEventType::LeftMouseDown.0)
            | (1u64 << CGEventType::LeftMouseUp.0)
            | (1u64 << CGEventType::LeftMouseDragged.0)
            | (1u64 << CGEventType::RightMouseDown.0)
            | (1u64 << CGEventType::RightMouseUp.0)
            | (1u64 << CGEventType::RightMouseDragged.0)
            | (1u64 << CGEventType::OtherMouseDown.0)
            | (1u64 << CGEventType::OtherMouseUp.0)
            | (1u64 << CGEventType::OtherMouseDragged.0);

        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new()
            .name("bnote-hard-lock".into())
            .spawn(move || {
                let created = (|| -> Result<(), String> {
                    let tap = unsafe {
                        CGEvent::tap_create(
                            // HID level (before the window server): only this
                            // level can make "I pressed it and nothing happened"
                            // real. The session level is too late -- the ⌘Tab
                            // switch has already happened by then, so swallowing
                            // the key only keeps the app from receiving it while
                            // the app has already switched away.
                            CGEventTapLocation::HIDEventTap,
                            CGEventTapPlacement::HeadInsertEventTap,
                            CGEventTapOptions::Default,
                            mask,
                            Some(tap_callback),
                            std::ptr::null_mut(),
                        )
                    }
                    .ok_or("TAP_FAILED: 事件 tap 建不起来(辅助功能权限没给?)")?;
                    let port = objc2_core_foundation::CFRetained::as_ptr(&tap).as_ptr() as *mut c_void;
                    TAP_PORT.store(port, Ordering::Release);
                    let Some(source) = objc2_core_foundation::CFMachPort::new_run_loop_source(
                        None,
                        Some(tap.as_ref()),
                        0,
                    ) else {
                        return Err("TAP_FAILED: run loop source 建不起来".into());
                    };
                    let Some(loop_) = objc2_core_foundation::CFRunLoop::current() else {
                        return Err("TAP_FAILED: 拿不到当前 run loop".into());
                    };
                    // The mode must be kCFRunLoopDefaultMode: passing NULL makes
                    // CFRunLoopAddSource crash inside CoreFoundation
                    // (CFRunLoopCopyMode -> CFHash -> SIGTRAP, measured).
                    loop_.add_source(
                        Some(source.as_ref()),
                        unsafe { objc2_core_foundation::kCFRunLoopDefaultMode },
                    );
                    Ok(())
                })();
                let _ = tx.send(created);
                // The thread parks on this run loop; the tap's callback runs on
                // this thread.
                objc2_core_foundation::CFRunLoop::run();
            })
            .map_err(|e| format!("TAP_THREAD: {}", e))?;

        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|e| format!("TAP_TIMEOUT: {}", e))?
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use tauri::{AppHandle, Window};

    pub fn trusted() -> bool {
        false
    }

    pub fn lock(_app: &AppHandle) -> Result<(), String> {
        Err("UNSUPPORTED: 专注模式目前只做了 macOS".into())
    }

    pub fn unlock(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }

    pub fn set_hard_lock(_enabled: bool) -> Result<(), String> {
        Err("UNSUPPORTED: 硬锁目前只做了 macOS".into())
    }

    pub fn set_hard_lock_active(_active: bool) -> Result<(), String> {
        Err("UNSUPPORTED: 硬锁目前只做了 macOS".into())
    }

    pub fn maybe_refocus(_window: &Window) {}
}

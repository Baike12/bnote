//! Pen-shaped cursor for the study mode web view (macOS).
//!
//! Why not `cursor: url(...)` in the page:
//!
//! On every mouse move the web process sends the whole Cursor to the UI process
//! over IPC (`WebChromeClient::setCursor` -> `PageClientImplMac::setCursor`),
//! and the latter skips `[NSCursor set]` only when the newly created platform
//! cursor compares identical to the current one. Native keywords
//! (`crosshair`/`arrow`/`text`...) return AppKit singletons, so the comparison
//! is always equal; an image cursor builds a new NSCursor via
//! `createCustomCursor` every time, so the comparison is never equal -> the
//! cursor is reset on every move and the pointer flickers constantly. That is
//! independent of the level the selector is written at, and of
//! `cursor: inherit`.
//!
//! So the pen comes from the native layer: the page CSS only uses native
//! keywords (see installCursorSheet in study/webAnnotations.ts), and here every
//! cursor request inside this webview's area is replaced with **the same** pen
//! NSCursor (the same PNG and the same hotspot 12 22 as the PDF reader). All
//! requests WebKit sends afterwards become no-ops, the window server draws the
//! pointer directly, and there is zero lag and no flicker.
//!
//! The interception point is the in-process `-[NSCursor set]` (the UI process is
//! this process). It is process-wide, so it needs double gating on "the
//! pointer is inside the child webview rect" plus "the webview is visible";
//! the main window and the PDF reading area are completely unaffected.

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, AtomicUsize, Ordering};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, define_class, msg_send, sel, AnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSApplication, NSApplicationDidBecomeActiveNotification, NSCursor, NSEvent, NSImage,
        NSView, NSWindowDidBecomeKeyNotification, NSWindowDidChangeScreenNotification,
        NSWindowDidMoveNotification, NSWindowDidResizeNotification,
    };
    use objc2_foundation::{
        NSData, NSNotification, NSNotificationCenter, NSObject, NSPoint, NSSize,
    };

    /// The same image as the PDF reader (the `?inline` variant is for the page;
    /// this one is for the native side).
    const PEN_HIGHLIGHT_PNG: &[u8] =
        include_bytes!("../../../src/assets/cursors/pdf-highlight.png");
    const PEN_NOTE_PNG: &[u8] = include_bytes!("../../../src/assets/cursors/pdf-note.png");
    const PEN_SIZE: f64 = 24.0;
    /// Tip position inside the image (origin at the top left), matching the
    /// `12 22` in the CSS.
    const HOTSPOT_X: f64 = 12.0;
    const HOTSPOT_Y: f64 = 22.0;

    /// The original `-[NSCursor set]` implementation; 0 = not installed yet.
    static ORIGINAL_SET: AtomicUsize = AtomicUsize::new(0);
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    /// The study mode web view (WKWebView), dereferenced only on the main thread.
    static WEBVIEW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
    static PEN_HIGHLIGHT: AtomicPtr<NSCursor> = AtomicPtr::new(std::ptr::null_mut());
    static PEN_NOTE: AtomicPtr<NSCursor> = AtomicPtr::new(std::ptr::null_mut());
    /// Whether the current annotation tool is a text annotation (blue pen);
    /// everything else uses the highlighter (yellow pen).
    static NOTE_MODE: AtomicBool = AtomicBool::new(false);
    static OBSERVING: AtomicBool = AtomicBool::new(false);
    /// The web view's rect in screen coordinates. The hot path (every
    /// `-[NSCursor set]`) only reads this cache and does arithmetic; window
    /// move/resize and view re-layout recompute it through notifications or
    /// refresh(). Never query the WindowServer here: `windowNumberAtPoint`
    /// measured 27.7 us per call, and the cursor set happens on every mouse
    /// move and in every post-layout cursor recomputation.
    static RECT: [AtomicU64; 4] = [
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
    ];
    static RECT_VALID: AtomicBool = AtomicBool::new(false);

    type SetFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel);

    /// Recompute the web view's screen rect (main thread).
    fn refresh_rect() {
        let view = WEBVIEW.load(Ordering::Relaxed) as *const NSView;
        if view.is_null() || MainThreadMarker::new().is_none() {
            RECT_VALID.store(false, Ordering::Relaxed);
            return;
        }
        unsafe {
            let view = &*view;
            let Some(window) = view.window() else {
                RECT_VALID.store(false, Ordering::Relaxed);
                return;
            };
            let rect = window.convertRectToScreen(view.convertRect_toView(view.bounds(), None));
            RECT[0].store(rect.origin.x.to_bits(), Ordering::Relaxed);
            RECT[1].store(rect.origin.y.to_bits(), Ordering::Relaxed);
            RECT[2].store(rect.size.width.to_bits(), Ordering::Relaxed);
            RECT[3].store(rect.size.height.to_bits(), Ordering::Relaxed);
            RECT_VALID.store(true, Ordering::Relaxed);
        }
    }

    fn inside_cached(mouse: NSPoint) -> bool {
        if !RECT_VALID.load(Ordering::Relaxed) {
            return false;
        }
        let x = f64::from_bits(RECT[0].load(Ordering::Relaxed));
        let y = f64::from_bits(RECT[1].load(Ordering::Relaxed));
        let w = f64::from_bits(RECT[2].load(Ordering::Relaxed));
        let h = f64::from_bits(RECT[3].load(Ordering::Relaxed));
        mouse.x >= x && mouse.x <= x + w && mouse.y >= y && mouse.y <= y + h
    }

    // Re-apply the pen when the app becomes active or the window becomes key.
    //
    // Switching to another app makes macOS replace our cursor with an arrow,
    // and that step does not go through `-[NSCursor set]`, so the interceptor
    // never sees it; when the user switches back without moving the mouse,
    // WebKit does not set the cursor again either. So re-set the pen
    // proactively on these two notifications.
    //
    // A window move/resize changes the cached rect for the same reason, so it
    // is recomputed at the same time.
    define_class!(
        // SAFETY: the observer only calls apply_now()/refresh_rect() and holds
        // no other UI state.
        #[unsafe(super(NSObject))]
        #[name = "BNotePenCursorKeeper"]
        #[ivars = ()]
        struct PenCursorKeeper;

        impl PenCursorKeeper {
            #[unsafe(method(penCursorRefresh:))]
            fn pen_cursor_refresh(&self, _note: &NSNotification) {
                apply_now();
            }

            #[unsafe(method(penCursorGeometry:))]
            fn pen_cursor_geometry(&self, _note: &NSNotification) {
                refresh_rect();
            }
        }
    );

    impl PenCursorKeeper {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    /// The implementation installed on `-[NSCursor set]`: inside the web area
    /// it replaces any cursor with that pen. It returns right away when the
    /// cursor already is that same pen -- WebKit calls this on every mouse
    /// move.
    unsafe extern "C-unwind" fn bnote_cursor_set(receiver: *mut AnyObject, cmd: Sel) {
        let raw = ORIGINAL_SET.load(Ordering::Relaxed);
        if raw == 0 {
            return;
        }
        let original: SetFn = unsafe { std::mem::transmute(raw) };
        if let Some(pen) = wanted_pen() {
            let current: *mut AnyObject = unsafe { msg_send![class!(NSCursor), currentCursor] };
            if current != pen.cast() {
                unsafe { original(pen.cast(), cmd) };
            }
            return;
        }
        unsafe { original(receiver, cmd) };
    }

    /// Which pen the pointer should show right now; None = do not take over,
    /// hand the cursor back unchanged.
    ///
    /// This runs on **every** `-[NSCursor set]` (mouse moves, post-layout cursor
    /// recomputation), so it starts with a pure arithmetic check against the
    /// cached rect: if the pointer is not over the web view it returns without
    /// making a single AppKit call.
    fn wanted_pen() -> Option<*mut NSCursor> {
        let mtm = MainThreadMarker::new()?;
        let view = WEBVIEW.load(Ordering::Relaxed) as *const NSView;
        if view.is_null() {
            return None;
        }
        let mouse = NSEvent::mouseLocation();
        if !inside_cached(mouse) {
            return None;
        }
        unsafe {
            let view = &*view;
            let window = view.window()?;
            // Do not take over when the app is not in the foreground, the view
            // is hidden (a popup covers it), or the window is not key (another
            // bnote window is on top).
            if !NSApplication::sharedApplication(mtm).isActive()
                || view.isHiddenOrHasHiddenAncestor()
                || !window.isKeyWindow()
            {
                return None;
            }
        }
        let slot = if NOTE_MODE.load(Ordering::Relaxed) {
            &PEN_NOTE
        } else {
            &PEN_HIGHLIGHT
        };
        let pen = slot.load(Ordering::Relaxed);
        if pen.is_null() {
            None
        } else {
            Some(pen)
        }
    }

    fn make_pen(png: &[u8]) -> Option<Retained<NSCursor>> {
        let data = NSData::with_bytes(png);
        let image = NSImage::initWithData(NSImage::alloc(), &data)?;
        image.setSize(NSSize::new(PEN_SIZE, PEN_SIZE));
        Some(NSCursor::initWithImage_hotSpot(
            NSCursor::alloc(),
            &image,
            NSPoint::new(HOTSPOT_X, HOTSPOT_Y),
        ))
    }

    fn ensure_pens() {
        if PEN_HIGHLIGHT.load(Ordering::Relaxed).is_null() {
            if let Some(pen) = make_pen(PEN_HIGHLIGHT_PNG) {
                PEN_HIGHLIGHT.store(Retained::into_raw(pen), Ordering::Relaxed);
            }
        }
        if PEN_NOTE.load(Ordering::Relaxed).is_null() {
            if let Some(pen) = make_pen(PEN_NOTE_PNG) {
                PEN_NOTE.store(Retained::into_raw(pen), Ordering::Relaxed);
            }
        }
    }

    fn install_once() {
        if INSTALLED.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(cls) = AnyClass::get(c"NSCursor") else {
            return;
        };
        let Some(method) = cls.instance_method(sel!(set)) else {
            return;
        };
        let replacement: Imp = unsafe { std::mem::transmute::<SetFn, Imp>(bnote_cursor_set) };
        let original = unsafe { method.set_implementation(replacement) };
        ORIGINAL_SET.store(original as usize, Ordering::SeqCst);
    }

    /// Immediately paints the current cursor with the pen it should show (the
    /// mouse may be sitting still). Every call site is a low-frequency event
    /// (activation, tool switch, view shown/moved), so the rect cache is
    /// refreshed here as well.
    fn apply_now() {
        let raw = ORIGINAL_SET.load(Ordering::SeqCst);
        if raw == 0 {
            return;
        }
        refresh_rect();
        if let Some(pen) = wanted_pen() {
            let current: *mut AnyObject = unsafe { msg_send![class!(NSCursor), currentCursor] };
            if current == pen.cast() {
                return;
            }
            let original: SetFn = unsafe { std::mem::transmute(raw) };
            unsafe { original(pen.cast(), sel!(set)) };
        }
    }

    /// Re-applies the pen when the app becomes active or the window becomes
    /// key: at those moments macOS replaces the cursor with an arrow, and that
    /// step does not go through `-[NSCursor set]`, so the interceptor never
    /// sees it.
    fn install_observers() {
        if OBSERVING.swap(true, Ordering::SeqCst) {
            return;
        }
        if MainThreadMarker::new().is_none() {
            return;
        }
        // A selector-based observer is not retained by the notification center:
        // leak one so it lives until the process ends.
        let observer = Retained::into_raw(PenCursorKeeper::new()) as *const AnyObject;
        let center = NSNotificationCenter::defaultCenter();
        unsafe {
            let observer = &*observer;
            center.addObserver_selector_name_object(
                observer,
                sel!(penCursorRefresh:),
                Some(NSApplicationDidBecomeActiveNotification),
                None,
            );
            center.addObserver_selector_name_object(
                observer,
                sel!(penCursorRefresh:),
                Some(NSWindowDidBecomeKeyNotification),
                None,
            );
            // The window geometry changed, so the cached rect is recomputed.
            for name in [
                NSWindowDidMoveNotification,
                NSWindowDidResizeNotification,
                NSWindowDidChangeScreenNotification,
            ] {
                center.addObserver_selector_name_object(
                    observer,
                    sel!(penCursorGeometry:),
                    Some(name),
                    None,
                );
            }
        }
    }

    /// Call after the web view is created or rebuilt; calling it again is
    /// idempotent.
    pub fn attach(view: *mut c_void) {
        if view.is_null() {
            return;
        }
        install_once();
        install_observers();
        ensure_pens();
        WEBVIEW.store(view, Ordering::SeqCst);
        apply_now();
    }

    /// Call after the web view is closed: hand the system cursor back (the next
    /// mouse move is taken over by the main window itself).
    pub fn detach() {
        WEBVIEW.store(std::ptr::null_mut(), Ordering::SeqCst);
        RECT_VALID.store(false, Ordering::SeqCst);
        if MainThreadMarker::new().is_some() {
            NSCursor::arrowCursor().set();
        }
    }

    /// Annotation tool switch: true = text annotation (blue pen), false =
    /// highlighter (yellow pen).
    pub fn set_mode(note: bool) {
        NOTE_MODE.store(note, Ordering::SeqCst);
        apply_now();
    }

    /// Refreshes once after the view is shown again or re-laid out (a popup was
    /// closed, set_bounds moved it).
    pub fn refresh() {
        apply_now();
    }
}

#[cfg(target_os = "macos")]
pub use mac::{attach, detach, refresh, set_mode};

#[cfg(not(target_os = "macos"))]
pub fn attach(_view: *mut std::ffi::c_void) {}

#[cfg(not(target_os = "macos"))]
pub fn detach() {}

#[cfg(not(target_os = "macos"))]
pub fn set_mode(_note: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn refresh() {}

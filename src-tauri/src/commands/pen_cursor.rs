//! 学习模式网页里的笔形光标(macOS)。
//!
//! 为什么不在页面里用 `cursor: url(...)`:
//!
//! Web 进程每次鼠标移动都会经 IPC 把整条 Cursor 发给 UI 进程
//! (`WebChromeClient::setCursor` → `PageClientImplMac::setCursor`),后者只在
//! 「新建的平台光标 == 当前光标」时才跳过 `[NSCursor set]`。原生关键字
//! (`crosshair`/`arrow`/`text`…) 返回 AppKit 单例,比较恒等;图片光标每次都由
//! `createCustomCursor` 新建 NSCursor,比较恒不等 → 每移动一次就重设一次,
//! 指针一直闪。这与选择器写在哪一级、是否 `cursor: inherit` 都无关。
//!
//! 所以笔由原生层给:页面 CSS 只写原生关键字(见 study/webAnnotations.ts 的
//! installCursorSheet),这里把这块 webview 区域内的光标请求统一换成**同一支**
//! pen NSCursor(与 PDF 阅读器同一张 PNG、同一热点 12 22)。WebKit 之后发来的
//! 请求全部变成空操作,指针由窗口服务器直接绘制,零滞后、不闪。
//!
//! 拦截点是进程内的 `-[NSCursor set]`(UI 进程就是本进程)。它是进程级的,
//! 因此必须用「指针在子 webview 矩形内」+「webview 可见」双重门控,主窗口与
//! PDF 阅读区完全不受影响。

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicUsize, Ordering};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel, AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSCursor, NSEvent, NSImage, NSView};
    use objc2_foundation::{NSData, NSPoint, NSSize};

    /// 与 PDF 阅读器同一张图(`?inline` 那份是给页面用的,这里是原生用)。
    const PEN_HIGHLIGHT_PNG: &[u8] =
        include_bytes!("../../../src/assets/cursors/pdf-highlight.png");
    const PEN_NOTE_PNG: &[u8] = include_bytes!("../../../src/assets/cursors/pdf-note.png");
    const PEN_SIZE: f64 = 24.0;
    /// 笔尖在图片里的位置(左上角为原点),与 CSS 里的 `12 22` 一致。
    const HOTSPOT_X: f64 = 12.0;
    const HOTSPOT_Y: f64 = 22.0;

    /// `-[NSCursor set]` 的原始实现;0 = 还没装好。
    static ORIGINAL_SET: AtomicUsize = AtomicUsize::new(0);
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    /// 学习模式网页的 NSView(WKWebView),只在主线程解引用。
    static WEBVIEW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
    static PEN_HIGHLIGHT: AtomicPtr<NSCursor> = AtomicPtr::new(std::ptr::null_mut());
    static PEN_NOTE: AtomicPtr<NSCursor> = AtomicPtr::new(std::ptr::null_mut());
    /// 当前批注工具是否为文字批注(蓝笔);其余情况用高亮笔(黄笔)。
    static NOTE_MODE: AtomicBool = AtomicBool::new(false);

    type SetFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel);

    /// 装到 `-[NSCursor set]` 上的实现:在网页区域里把任何光标换成那支笔。
    /// 已经是同一支笔就直接返回 —— WebKit 每次鼠标移动都会来一次。
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

    /// 指针此刻应该显示哪支笔;None = 不接管,交回原来的光标。
    fn wanted_pen() -> Option<*mut NSCursor> {
        if MainThreadMarker::new().is_none() {
            return None;
        }
        let view = WEBVIEW.load(Ordering::Relaxed) as *mut NSView;
        if view.is_null() {
            return None;
        }
        unsafe {
            let view = &*view;
            let window = view.window()?;
            if !window.isKeyWindow() || view.isHiddenOrHasHiddenAncestor() {
                return None;
            }
            let mouse = NSEvent::mouseLocation();
            let in_window = view.convertRect_toView(view.bounds(), None);
            let rect = window.convertRectToScreen(in_window);
            if mouse.x < rect.origin.x
                || mouse.x > rect.origin.x + rect.size.width
                || mouse.y < rect.origin.y
                || mouse.y > rect.origin.y + rect.size.height
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

    /// 立刻把当前光标刷成应当显示的那一支(鼠标可能正停着不动)。
    fn apply_now() {
        let raw = ORIGINAL_SET.load(Ordering::SeqCst);
        if raw == 0 {
            return;
        }
        if let Some(pen) = wanted_pen() {
            let current: *mut AnyObject = unsafe { msg_send![class!(NSCursor), currentCursor] };
            if current == pen.cast() {
                return;
            }
            let original: SetFn = unsafe { std::mem::transmute(raw) };
            unsafe { original(pen.cast(), sel!(set)) };
        }
    }

    /// 网页视图创建/重建后调用;重复调用是幂等的。
    pub fn attach(view: *mut c_void) {
        if view.is_null() {
            return;
        }
        install_once();
        ensure_pens();
        WEBVIEW.store(view, Ordering::SeqCst);
        apply_now();
    }

    /// 网页视图关掉后调用:交还系统光标(下一次鼠标移动由主窗口自己接管)。
    pub fn detach() {
        WEBVIEW.store(std::ptr::null_mut(), Ordering::SeqCst);
        if MainThreadMarker::new().is_some() {
            NSCursor::arrowCursor().set();
        }
    }

    /// 批注工具切换:true = 文字批注(蓝笔),false = 高亮(黄笔)。
    pub fn set_mode(note: bool) {
        NOTE_MODE.store(note, Ordering::SeqCst);
        apply_now();
    }

    /// 视图重新显示后刷新一次(弹窗关掉、原生视图 show 回来)。
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

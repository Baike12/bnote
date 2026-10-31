//! 专注模式:一段时间里屏幕上只有 bnote,而且切不到别的应用。
//!
//! 三层叠在一起,任何一层失效都只是降级,不会把应用搞坏:
//!
//! 1. **伪全屏**(窗口层):窗口铺满当前屏幕、摘掉原生装饰。
//!    刻意**不用** macOS 的原生全屏:原生全屏独占一个 Space,⌘Tab 会把人送进
//!    别的应用的 Space,bnote 整个不在屏上——那正好和目标相反。
//! 2. **层级独占**(窗口层):level 抬到 `NSStatusWindowLevel`(25),盖过系统菜单栏
//!    (24);`collectionBehavior` 加上 `canJoinAllSpaces` + `fullScreenAuxiliary` +
//!    `stationary`——切 Space、切到别的应用进全屏,bnote 都出现在那个 Space 的
//!    最上面。
//! 3. **焦点抢回**:失焦即拉回,让切走的应用拿不到输入。
//!
//! 另加**硬锁**:CGEventTap 吞掉 ⌘Tab / ⌘Space 等系统级快捷键——这是唯一能让
//! 「按了没反应」的手段,需要辅助功能权限;没权限就只做上面三层。
//!
//! 复原纪律:进锁前快照 level / collectionBehavior / styleMask / 内框尺寸 / 位置,
//! 退锁时逐项还原。漏一项就再也回不到正常窗口(别的应用会被 bnote 一直压住,
//! 而且用户看不出来),所以快照与还原写在同一个模块、同一条路径上。
//!
//! 样式表另有一处配套:styleMask 里带着 `FullSizeContentView`(macOS 的 overlay
//! 标题栏),所以还原必须用快照的**原值**,不能用 `set_decorations(true)`——
//! tao 的 true 分支只给 Closable|Miniaturizable|Resizable|Titled,会把 overlay
//! 标题栏抹掉,窗口顶上会多出一条原生标题栏。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::AppHandle;

use super::CmdResult;

/// 专注模式的当前状态(前端回读用)。
#[derive(Serialize, Clone, Copy, Debug, Default)]
pub struct FocusStatus {
    /// 伪全屏锁是否开着。
    pub locked: bool,
    /// 硬锁是否**武装**(用户打开了这个开关,表示"专注期间吞系统级快捷键")。
    pub hard_lock: bool,
    /// 硬锁是否**正在拦截**:只有一段番茄钟在跑的时候才为真。
    /// 武装 ≠ 拦截:没在专注时 ⌘Tab 必须照常可用。
    pub hard_active: bool,
    /// 辅助功能权限是否已授予——硬锁的前提。没授权时硬锁开不起来。
    pub trusted: bool,
    /// 硬锁的 tap 看到过多少个按键事件(不含被吞的诊断计数,只是"活着"的证据)。
    pub seen: u32,
    /// 硬锁吞掉了多少个按键事件。
    pub swallowed: u32,
}

/// 进锁前的窗口快照;退锁时逐项还原。
#[derive(Debug)]
struct WindowSnapshot {
    level: isize,
    behavior: usize,
    style_mask: usize,
    /// 内框尺寸(逻辑像素)。
    inner: (f64, f64),
    /// 窗口位置(逻辑像素)。
    pos: (f64, f64),
}

static LOCKED: AtomicBool = AtomicBool::new(false);
static HARD_LOCK: AtomicBool = AtomicBool::new(false);
static HARD_ACTIVE: AtomicBool = AtomicBool::new(false);
static SNAPSHOT: Mutex<Option<WindowSnapshot>> = Mutex::new(None);

/// 专注模式的当前状态。
#[tauri::command]
pub fn focus_status() -> CmdResult<FocusStatus> {
    Ok(FocusStatus {
        locked: LOCKED.load(Ordering::Relaxed),
        hard_lock: HARD_LOCK.load(Ordering::Relaxed),
        hard_active: HARD_ACTIVE.load(Ordering::Relaxed),
        trusted: mac::trusted(),
        seen: mac::seen_count(),
        swallowed: mac::swallowed_count(),
    })
}

/// 进锁:伪全屏 + 层级独占 + 焦点抢回。已经在锁里就是幂等的空操作。
#[tauri::command]
pub fn focus_lock(app: AppHandle) -> CmdResult<FocusStatus> {
    if LOCKED.load(Ordering::Relaxed) {
        return focus_status();
    }
    mac::lock(&app)?;
    LOCKED.store(true, Ordering::Relaxed);
    focus_status()
}

/// 退锁:把快照里的每一项原样放回去。
#[tauri::command]
pub fn focus_unlock(app: AppHandle) -> CmdResult<FocusStatus> {
    if LOCKED.load(Ordering::Relaxed) {
        mac::unlock(&app)?;
        LOCKED.store(false, Ordering::Relaxed);
    }
    focus_status()
}

/// 武装/解除硬锁(吞系统级快捷键)。
///
/// 它只是**武装**:真正开始吞键要等一段番茄钟跑起来(focus_set_hard_lock_active)。
/// 没在专注时 ⌘Tab 必须照常能用——否则"打开硬锁"就等于把自己锁在应用里。
///
/// 没有辅助功能权限时直接报错,不静默降级:用户以为锁住了,其实 ⌘Tab 还能用,
/// 比明说"锁不住"更糟。
#[tauri::command]
pub fn focus_set_hard_lock(enabled: bool) -> CmdResult<FocusStatus> {
    mac::set_hard_lock(enabled)?;
    HARD_LOCK.store(enabled, Ordering::Relaxed);
    if !enabled {
        // 解除武装立刻停手:不能等到下一次会话结束才放开。
        mac::set_hard_lock_active(false)?;
        HARD_ACTIVE.store(false, Ordering::Relaxed);
    }
    focus_status()
}

/// 一段番茄钟开始/结束时切换"真正拦截"。前端只在计时跑着的时候传 true。
#[tauri::command]
pub fn focus_set_hard_lock_active(active: bool) -> CmdResult<FocusStatus> {
    if active && !HARD_LOCK.load(Ordering::Relaxed) {
        return Err("NOT_ARMED: 硬锁没有武装,不需要拦截".into());
    }
    mac::set_hard_lock_active(active)?;
    HARD_ACTIVE.store(active, Ordering::Relaxed);
    focus_status()
}

/// 装上"失焦抢回"的监听。进 setup 里调一次。
pub fn install_focus_guard(app: &AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
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
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering};
    use std::time::Duration;

    use objc2::{class, msg_send};
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSApplication, NSStatusWindowLevel, NSWindowStyleMask};
    use objc2_core_graphics::CGEventFlags;
    use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

    use super::{HARD_ACTIVE, HARD_LOCK, LOCKED, SNAPSHOT, WindowSnapshot};

    /// 集合行为位(canJoinAllSpaces / stationary / fullScreenAuxiliary)。
    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const STATIONARY: usize = 1 << 4;
    const FULLSCREEN_AUXILIARY: usize = 1 << 8;

    // 辅助功能权限(AXIsProcessTrusted)。硬锁要吞系统级按键,没有这个权限
    // 事件 tap 建不起来。
    //
    // 带 Prompt 的那个变体能在没权限时让系统直接弹出授权框(框里有"打开系统
    // 设置"的按钮)——只回一句"需要权限"的话,用户不知道该去哪儿点。
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// 让 macOS 弹出「bnote 想要控制这台电脑」的授权提示。
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

    /// NSWindow 的原生层级(NSWindowLevel)。
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

    /// 改 styleMask,并把 first responder 交回 webview。
    ///
    /// **不**用 tao 的 `set_decorations`:它走 GCD 异步改 mask,恢复时那份
    /// 异步改动会盖掉我们精确的还原值(tao 只给
    /// Titled|Closable|Miniaturizable|Resizable,把 FullSizeContentView 丢了,
    /// overlay 标题栏就没了,窗口顶上会多出一条原生标题栏)。这里自己同步改
    /// ——我们本来就在主线程(setStyleMask: 只在主线程安全)。
    ///
    /// 改完必须 makeFirstResponder(webview):否则窗口不是 key,键盘输入会失灵
    /// (tao 自己的 set_style_mask 也是这么做的)。
    fn set_style_mask(ns: *mut AnyObject, view: *mut AnyObject, mask: usize) {
        unsafe {
            let _: () = msg_send![ns, setStyleMask: mask];
            let _: bool = msg_send![ns, makeFirstResponder: view];
        }
    }

    /// 无边框窗口的 styleMask:和 tao 的「关装饰」分支取同一个值。
    fn borderless_mask() -> usize {
        (NSWindowStyleMask::Borderless | NSWindowStyleMask::Resizable).0 as usize
    }

    /// 把一段 AppKit 操作放到主线程执行,并等它做完。
    ///
    /// AppKit 不是线程安全的。Tauri 的同步命令跑在 IPC 到达的那个线程
    /// (通常是主线程),但命令也可能从别处被调到,所以统一走这里,不在调用点
    /// 赌线程。已经在主线程就直接执行,免得自己等自己。
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

    pub fn lock(app: &AppHandle) -> Result<(), String> {
        let app = app.clone();
        let inner_app = app.clone();
        on_main_thread(&app, move || {
            let win = inner_app
                .get_webview_window("main")
                .ok_or("NO_WINDOW: 主窗口不在")?;
            let scale = win.scale_factor().unwrap_or(1.0);
            let inner = win
                .inner_size()
                .map(|s| s.to_logical::<f64>(scale))
                .map_err(|e| e.to_string())?;
            let pos = win
                .outer_position()
                .map(|p| p.to_logical::<f64>(scale))
                .map_err(|e| e.to_string())?;
            let ns = win.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;

            // 快照:退锁时逐项还原,漏一项都算事故。
            let snap = WindowSnapshot {
                level: native_level(ns),
                behavior: native_behavior(ns),
                style_mask: native_style_mask(ns),
                inner: (inner.width, inner.height),
                pos: (pos.x, pos.y),
            };

            // 先摘装饰:摘掉后内框 == 外框,铺屏才严丝合缝(否则会小一圈)。
            let view = win.ns_view().map_err(|e| e.to_string())? as *mut AnyObject;
            set_style_mask(ns, view, borderless_mask());

            // 铺满当前屏幕(整块,含菜单栏那条——level 25 会盖住菜单栏,画面才
            // 真的只剩 bnote)。只有一块屏,当前屏就是它。
            let monitor = win
                .current_monitor()
                .map_err(|e| e.to_string())?
                .or(win.primary_monitor().map_err(|e| e.to_string())?)
                .ok_or("NO_MONITOR: 找不到屏幕")?;
            let m_scale = win.scale_factor().unwrap_or(1.0);
            let m_size = monitor.size().to_logical::<f64>(m_scale);
            let m_pos = monitor.position().to_logical::<f64>(m_scale);
            win.set_size(LogicalSize::new(m_size.width, m_size.height))
                .map_err(|e| e.to_string())?;
            win.set_position(LogicalPosition::new(m_pos.x, m_pos.y))
                .map_err(|e| e.to_string())?;

            // 层级独占:盖过系统菜单栏(24);跨 Space + 伴随全屏,切到哪儿都在
            // 最上面。
            set_native_level(ns, NSStatusWindowLevel);
            set_native_behavior(
                ns,
                snap.behavior | CAN_JOIN_ALL_SPACES | STATIONARY | FULLSCREEN_AUXILIARY,
            );

            *SNAPSHOT.lock().unwrap_or_else(|e| e.into_inner()) = Some(snap);
            Ok(())
        })
    }

    pub fn unlock(app: &AppHandle) -> Result<(), String> {
        let app = app.clone();
        let inner_app = app.clone();
        on_main_thread(&app, move || {
            let snap = SNAPSHOT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            let Some(snap) = snap else {
                return Ok(());
            };
            let Some(win) = inner_app.get_webview_window("main") else {
                return Ok(());
            };
            let ns = win.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;

            // 装饰:把快照里的 styleMask 原样放回去(带 FullSizeContentView 的
            // overlay 标题栏)。走自己的同步路径,别让 tao 的异步改动盖掉它。
            let view = win.ns_view().map_err(|e| e.to_string())? as *mut AnyObject;
            set_style_mask(ns, view, snap.style_mask);

            set_native_level(ns, snap.level);
            set_native_behavior(ns, snap.behavior);

            win.set_size(LogicalSize::new(snap.inner.0, snap.inner.1))
                .map_err(|e| e.to_string())?;
            win.set_position(LogicalPosition::new(snap.pos.0, snap.pos.1))
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    /// 失焦抢回:把 bnote 拉回前台,让切走的应用拿不到输入。
    ///
    /// 原生模态框(选仓库/选文件)打开时 app 本来就 resign key,这时拉回会
    /// 和对话框打架——用 `modalWindow` 判掉。窗口最小化/不可见时 tao 的
    /// `set_focus` 自己就不做事,不会把最小化的窗口弹出来。
    pub fn maybe_refocus(window: &WebviewWindow) {
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

    // ---- 硬锁(CGEventTap) ----------------------------------------------------

    /// 事件 tap 的 MachPort;关/开硬锁时要用它 enable/disable。
    static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    /// 系统授权框是否已经弹过。每个进程只弹一次:反复点开关就反复弹框,
    /// 而 macOS 本来也只对同一个应用弹一次——再点由界面上的「去授权」兜底。
    static PROMPTED: AtomicBool = AtomicBool::new(false);

    /// tap 见过的按键事件数 / 吞掉的按键事件数。
    ///
    /// 这两个计数是"硬锁到底活着没有"的证据:合成事件走的是注入通道,tap 看不见,
    /// 只有真键盘事件才进得来——计数不动就说明 tap 没建起来或被系统关了。
    static SEEN: AtomicU32 = AtomicU32::new(0);
    static SWALLOWED: AtomicU32 = AtomicU32::new(0);

    pub fn seen_count() -> u32 {
        SEEN.load(Ordering::Relaxed)
    }

    pub fn swallowed_count() -> u32 {
        SWALLOWED.load(Ordering::Relaxed)
    }

    /// 硬锁吞掉的组合:键码(ANSI 布局) → 必须同时按下的修饰键。
    ///
    /// 只吞「系统自己处理、因而根本到不了应用」的那几个:⌘Tab(切应用)、
    /// ⌘Space(Spotlight)、⌘`(同应用窗口切换)、⌃↑/⌃↓(调度中心)、⌃⌘←/→(切
    /// Space)、⌘H(隐藏)、⌘M(最小化)。⌘Q 刻意放行——那是一条正当的逃生口。
    const BLOCKED: &[(u64, u64)] = &[
        (48, CGEventFlags::MaskCommand.0),          // Tab
        (49, CGEventFlags::MaskCommand.0),          // Space
        (50, CGEventFlags::MaskCommand.0),          // `
        (4, CGEventFlags::MaskCommand.0),           // H
        (46, CGEventFlags::MaskCommand.0),          // M
        (126, CGEventFlags::MaskControl.0),         // Up(调度中心)
        (125, CGEventFlags::MaskControl.0),         // Down
        (
            123,
            CGEventFlags::MaskControl.0 | CGEventFlags::MaskCommand.0,
        ), // Left(切 Space)
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

    /// 事件 tap 的回调:命中要吞的组合就返回 null(事件被吃掉)。
    ///
    /// 系统会在回调超时或用户输入过多时把 tap 关掉(`kCGEventTapDisabledBy…`),
    /// 这时硬锁会静默失效——所以要把 tap 重新打开。
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
        if event_type != CGEventType::KeyDown && event_type != CGEventType::KeyUp {
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
        unsafe {
            let port = &*(ptr as *const objc2_core_foundation::CFMachPort);
            objc2_core_graphics::CGEvent::tap_enable(port, enabled);
        }
    }

    /// 武装硬锁:只检查权限,**不建 tap**。
    ///
    /// 真正的拦截由 `set_hard_lock_active` 在一段番茄钟开始时打开——武装只是
    /// "我同意专注期间吞掉系统级快捷键"这个意向,不改变当前能不能切走。
    pub fn set_hard_lock(enabled: bool) -> Result<(), String> {
        if !enabled {
            return Ok(());
        }
        if !trusted() {
            // 先弹系统授权框,再回错误:用户允许之后,前端会在窗口回到前台
            // 时重新查一次权限并自动把武装补上——不用再点一次开关。
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

    /// 开始/停止真正拦截。番茄钟跑起来(stop 掉)时由前端切。
    ///
    /// 停:把 tap 关掉——线程留着,tap 也留着,下次不用重建。
    /// 起:确保 tap 建好并启用。没权限时不弹框(会话开始不该弹系统提示),直接报错。
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
        set_tap_enabled(true);
        Ok(())
    }

    /// 建一次事件 tap,跑在专属线程的 run loop 上(不占主线程)。
    fn ensure_tap() -> Result<(), String> {
        use objc2_core_graphics::{
            CGEvent, CGEventMask, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
            CGEventType,
        };

        if !TAP_PORT.load(Ordering::Acquire).is_null() {
            return Ok(());
        }

        // 只关心按键按下/抬起。
        let mask: CGEventMask = (1u64 << CGEventType::KeyDown.0)
            | (1u64 << CGEventType::KeyUp.0)
            | (1u64 << CGEventType::FlagsChanged.0);

        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new()
            .name("bnote-hard-lock".into())
            .spawn(move || {
                let created = (|| -> Result<(), String> {
                    let tap = unsafe {
                        CGEvent::tap_create(
                            // HID 层(窗口服务器之前):只有这一层能让「按了没反应」。
                            // session 层太晚——⌘Tab 的切换在那之前就发生了,吞掉按键
                            // 只是不让应用收到键,应用已经切走了。
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
                    // mode 必须给 kCFRunLoopDefaultMode:传 NULL 会让
                    // CFRunLoopAddSource 在 CoreFoundation 内部直接崩
                    // (CFRunLoopCopyMode → CFHash → SIGTRAP,实测过)。
                    loop_.add_source(
                        Some(source.as_ref()),
                        unsafe { objc2_core_foundation::kCFRunLoopDefaultMode },
                    );
                    Ok(())
                })();
                let _ = tx.send(created);
                // 线程停在这个 run loop 上,tap 的回调就在这条线程里跑。
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

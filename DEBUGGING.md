# DEBUGGING.md — bnote-gpui 的后台调试方法

Tauri 版的调试脚手架是 `harness.html`（浏览器 + 内存假仓库）。GPUI 版没有
WebView，等价物是 **gpui 的无头测试栈**：所有调试都在 `#[gpui::test]` 里进行，
窗口是纯内存 `TestWindow`（永远不上屏、`is_active()` 恒 false），**不抢焦点、
不截屏、不打扰正在使用应用的用户**。四个层次按需选用：

## 0. 入口：`src/harness.rs`

```rust
use crate::harness;

#[gpui::test]
fn my_behavior(cx: &mut TestAppContext) {
    let (ws, fixture, cx) = harness::note_fixture(cx, true); // vim 开
    harness::draw(cx);                                       // 一帧渲染
    let w = harness::window(cx);
    harness::press(cx, w, "iHello");                         // 真实键路径
    harness::chord(cx, w, "escape");
    harness::press(cx, w, "V");
    assert_eq!(harness::doc(&ws, cx), "Hello");
    assert_eq!(harness::mode(&ws, cx), Some(Mode::Visual));
}
```

- `note_fixture` / `workspace_fixture_with`：真 `Workspace` + 临时 vault
  （`tempfile`，并行安全）+ 真 vim/snippet 桥 + inert IME/LSP。
- `press`（打字，带 `key_char`）、`chord`（"cmd-s" 等组合键）、
  `doc`/`mode`/`cursor`/`open_path` 读取、`draw`（一帧）。
- 私有视图经 `Workspace::harness_*`（cfg(test)）访问，release 不编译。

## 1. 行为模拟（默认层）

`TestAppContext` 的窗口是内存对象，键事件经 `dispatch_keystroke` 走
**真实拦截链**（vim 桥 → 片段桥 → keymap → 引擎），不是直接调函数。
计时器用测试时钟：`cx.executor().advance_clock(Duration)` 后
`cx.run_until_parked()`。动画类（wall-clock）推不动，测试要避开或等真时间。

## 2. 几何测量（无光栅化）

`harness::draw(cx)` 之后：

- `cx.debug_bounds("元素id")` → 该元素的 `Bounds<Pixels>`（要求元素带 id）。
- `cx.update_window(handle, |_, window, _| window.painted_quads())` → 最近一帧
  全部 `Quad`（bounds + content mask + 背景色），按颜色过滤可得行盒、光标
  条、装饰几何——参照 gpui-kit `crates/kit/tests/input/preview_lines.rs` 的
  `quads_of`。
- 离屏文本排版：`cx.text_system().layout_line(...)`（不需要窗口）。
- 视口变化：`cx.simulate_window_resize(handle, size)`。

## 3. 像素快照（看页面长什么样）—— `--harness-shot`

调试要能**看见**:页面布局、输入后的样子、按快捷键后的样子。这是脚本驱动的
无头整轮运行——真实 `Workspace`、真实按键派发,每步可截 PNG。窗口
`show: false, focus: false`,Metal 渲染到纹理:**不出屏、不抢焦点**,跑完即退。

```bash
cargo run --features harness-shot -p bnote-gpui -- \
  --harness-shot script.json [out-dir]     # 默认 /tmp/bnote-harness-shots
```

脚本（字段齐备,`steps` 每项可组合,按 footprints→doc→open→cursor→
type→key/chord→waitMs→shot 顺序执行;`footprints` 直接注入今日足迹索引,
用来把「日记末尾的足迹区」摆上画面,不必等一次真实编辑周期）:

```json
{
  "size": [1200, 800], "theme": "dark", "vim": true,
  "files": { "note.md": "# 标题\n\n正文 **加粗** $x^2$" }, "open": "note.md",
  "steps": [
    { "shot": "01-open" },
    { "type": "i你好" }, { "key": "escape" },
    { "chord": "cmd-shift-o" }, { "waitMs": 400 },
    { "shot": "02-daily" }
  ]
}
```

输出目录会打印每张 PNG 的路径与一次性 vault 路径（磁盘字节可直接 diff/
读取）。`waitMs` 同时推进模拟时钟（自动保存等定时器）与真实时间（图片解码
等后台线程）。运行日志带 `[bnote]` 前缀的 IPC 痕迹（read_file/list_files）,
可核对行为。构建由 `harness-shot` feature 门控,**正式构建不含该通道**。

无头渲染的盲区（与 Tauri 浏览器调试一致）:OS IME 全貌、系统对话框、Dock
交互——这几类留待用户实机反馈。

## 3.5 真窗口探针（`BNOTE_DIAG_VAULT`，`harness-shot` 构建）

第 0-3 层都跑在 `TestWindow` 上，看不到**平台层**的事实：真窗口的焦点归属、真键在拦截链里的走向、组件回调（palette 的 Enter/Escape）是否真的执行。这一层补上：同一个可执行文件，带 `harness-shot` feature 构建，运行时给三个环境变量即可——它照常开一个真窗口，等 vault 落定后自注入一串按键（`Window::dispatch_keystroke`，即真实按键在平台层之后的入口），把每一步的 mode/光标/文本、以及界面的关键状态写进日志文件，然后自己退出。

```bash
cargo build --features harness-shot -p bnote-gpui
BNOTE_DIAG_VAULT=/tmp/diag-vault \
BNOTE_DATA_DIR=/tmp/diag-config \
BNOTE_DIAG_LOG=/tmp/bnote-gpui-diag.log \
  ./target/debug/bnote-gpui
```

- `BNOTE_DIAG_VAULT`：用这个 vault（不碰用户的仓库，也避开 `lastVault`）；`BNOTE_DATA_DIR`：另一个配置目录（`config.json` 不互相覆盖）。两个都要给：只给前者仍会写用户的 config。
- 覆盖：焦点归属（`window.focused` / `editor.focused`）、vim 模式与按键后果、预览快照（spans/blocks/lines + 窗格宽度/可见范围）、quick switcher 的打开/输入/Enter/Escape。加一层就在 `Workspace::debug_schedule_diag` 的脚本里追加，**注意**：派发必须在窗口借用之外（`update_in` 里派发 action 会重入 Workspace 而 panic）。
- 盲区照旧：平台层**之上**的东西（真实键盘事件 → macOS 的 IME 前置门）注入不出来，那一段只能在真机上手按验证。

## 4. 性能

- 交互运行挂 `gpui_kit::fps` 的 `fps_monitor`（FPS/帧耗时/CPU/GPU HUD）。
- `gpui/profiler` feature：`FrameTimingCollector` + 任务级计时。
- `#[gpui::bench]` / `BenchAppContext` 出直方图报告。
- 性能门禁照旧：预算按本机实测标定，写进 `*.test.ts` 对应的 Rust 测试。

## 5. 与 Tauri 版 harness 的对应

| Tauri (harness.html) | GPUI (src/harness.rs) |
|---|---|
| `__loadDoc` / `__setCursor` | `fixture.write` + `harness_load` / `harness::press` |
| `__view` / DOM 断言 | `harness::doc` / `debug_bounds` / `painted_quads` |
| 浏览器截图（仅参考） | `HeadlessAppContext::capture_screenshot`（离屏） |
| 逐帧 DOM 记录 | 每帧 `draw` 后断言（测试时钟推进） |
| `pnpm gate` | `cargo test -p bnote-gpui`（+ core/mathml 套件） |

## 6. 平台行为盲区（headless 测不到）

OS IME 全貌、系统对话框（folder picker）、Dock/窗口管理器交互、打包 app 的
activation 政策——这几类只能留给用户实机部署后反馈，与 Tauri 版浏览器调试的
盲区（plugin:* 命令、子 webview）一致。

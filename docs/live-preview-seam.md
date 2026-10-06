# Live-preview 引擎接缝设计（gpui-kit 编辑器）

状态：**设计已定，未实现**。这是 bnote-gpui 渲染层（Obsidian 式 live preview：隐藏标记、
公式/图片/公式块/widget、callout 面板）的前置条件。gpui-kit 0.7 的编辑器只有三种装饰通道
（`TextDecoration` 染色、`RangeDecoration` 几何框、被 EditorMode 禁用的 `InlineToken`），
**没有任何"隐藏文本/替换文本"的能力**——CM6 的 replace decoration 对不上，必须在引擎里开接缝。

本文给出改动点、数据模型与验证方案。所有行号基于 /Users/baike3/CodeRepo/gpui-kit 当前树。

## 数据模型（bnote-gpui 侧产出，引擎消费）

per buffer line 的"显示编辑"列表（bnote 的规则：**隐藏只发生在光标不在的行**，
所以光标永远不会落在隐藏段内部——这消掉了大半映射复杂度）：

```rust
/// 一段从显示中移除的 buffer 字节范围（行内偏移）。
struct HideSpan { line: u64, start: usize, end: usize }
/// 隐藏段 + 在该位置渲染的元素（公式/图片/勾选框）。无 element = 纯隐藏。
struct WidgetSpan { hide: HideSpan, element: Box<dyn Fn(&mut Window, &mut App) -> AnyElement> }
/// 整块替换某行区间（公式块/callout 面板/表格）。
struct BlockWidget { first_line: u64, last_line: u64, height_hint: Option<Pixels>, element: ... }
```

一个 `PreviewDecorations { hides, widgets, block_widgets, revision }` 放在
`InputBaseState<EditorMode>` 上（扩展 `InputExtras for EditorExtras`，kind.rs:235-277 的既有模式），
`set_preview_decorations` 由 app 在每次文档变更/光标移动后写入（bnote 侧只在"影响渲染的
事务"后重建——沿用 Tauri 壳 `selectionAffectsDecos` 的快路径纪律）。

## 改动点（element.rs，6 处）

1. **shape 前裁剪**（`layout_lines`, element.rs:1998）：
   对每个 visible buffer line，`line_text` 与 `line_runs` 减去该行的 hide spans，
   得到 `visible_line_text`；`shape_line(visible_line_text, …)`。
   `LineLayout` 增加字段 `hidden: SmallVec<[Range<usize>; 2]>`（行内 buffer 字节段，升序）
   与 `widgets: SmallVec<[…; 2]>`（同时预先 prepaint widget 元素，参照 inline token 的
   `prepaint_tokens` element.rs:1916 的 prepaint 模式：先 measure 再 paint）。

2. **buffer offset → shaped offset 换算**：所有 `position_for_index(local, …)` 调用点的
   local 需先换算 `shaped_local = local - hidden_bytes_before(hidden, local)`。
   调用点：
   - 光标（`caret_for`, element.rs:562-571）
   - 选区（`layout_selections`, element.rs:934-1010）
   - RangeDecoration（element.rs:800-869）
   - 搜索匹配（element.rs:871-901）
   - 折叠浮标/缩进导引（element.rs:104/1374 附近）——仅当隐藏与 fold 重叠时才需要。
   封装为 `LineLayout::shaped_index(local) -> usize` 与 `buffer_index(shaped) -> usize`。

3. **命中测试（反向）**：鼠标位置 → `index_for_position` → shaped index →
   `buffer_index()` 加回隐藏字节。查 element.rs 的 on_mouse_down/drag 路径（grep
   `index_for_position` 的使用点），同样 6 处。

4. **行高/宽度**：`LineLayout` 的 `wrapped_lines` 宽度由 shape 结果自然变窄 ✓；
   widget 的行内高度若超过行高，需要在 `layout_lines` 的高度累计处取 max（参照
   element.rs:2094-2104 的 wrap_indent 区域与 2792-2812 的 scroll_size 计算）。

5. **paint**：在 paint 序列（element.rs:2975-3327）的"text lines"（3134-3198）之后、
   选区之前插入两组绘制：
   - inline widgets：按 `(row, shaped_index)` 取 `position_for_index` 得到原点绘制
     （复用 token 的绘制路径 3201-3203）。
   - block widgets：按行 y 偏移绘制，高度已在 layout 计入。

6. **光标在隐藏行**：bnote 侧保证光标行不下发 hide spans（光标行显示源码）；
   引擎不为此加特例。widget 命中（点击公式 → 回到源码）由 bnote 侧在 widget 元素上
   挂 on_click 实现。

## 行号/滚动不变的保证

- 隐藏不影响 buffer line 计数（只在行内重排），`buffer_line_to_display_row` 不变；
- block widget 的高度通过 `display_map` 的一个新"额外行高表"参与滚动尺寸计算
  （`scroll_size` element.rs:2792-2812 与 `calculate_visible_range` element.rs:1023-1090
  各加一次查表）——step 6 的 block widget 若行数很多，这张表要 O(log n) 查询。

## 分步落地（每步独立可验证）

- **S1 隐藏**：hide spans + 换算 + 命中测试（8 处调用点）。验收：harness 里把
  `# ` 隐藏后，截图/DOM 断言文本宽度缩短、点击位置映射正确、光标行不隐藏。
- **S2 inline widget**：公式（行内 `$…$`）与图片。验收：MathML/SVG 元素渲染在行内。
- **S3 block widget**：公式块、callout 面板、代码块语言标签。验收：行高、滚动、
  click-to-source。
- **S4 bnote 侧 PreviewDecorations 状态机**：markdown 扫描（bnote-core 已有
  `markdown::math_scan`/`callout`/`numbering`/`context`）+ 光标行豁免 + 增量重建纪律
  （只在影响渲染的事务后重建，性能门禁：perf 基线参考 Tauri 壳的 decoration 重建量级）。

## 与 KaTeX 的对应

bnote 的 Tauri 壳用 katex（npm，JS）。GPUI 侧方案：`latex2mathml` crate →
自写 MathML→GPUI 布局器（mathml 子集：mrow/mi/mo/mn/msup/msub/frac/radical/table 对齐）。
S2 先落"公式源码降级渲染"（等宽字体 + 高亮），MathML 渲染器单独成模块后接入。

## 测试与门禁

- gpui-kit 侧：element.rs 的换算函数（shaped_index/buffer_index）纯函数单测；
  layout 宽度与高度的几何断言（TestAppContext 已有 input 测试基建，见
  gpui-kit crates/kit/tests/input/）。
- bnote-gpui 侧：PreviewDecorations 状态机纯逻辑单测（光标行豁免、range 合并、
  增量重建触发条件）+ 浏览器/harness 无法覆盖（GPUI 原生）——用 gpui 的
  TestAppContext 写视口级断言。
- 性能：S1 落地后测"每键 shape 裁剪"的增量（对比关掉预览的基线），
  10 倍级回归拦在 perf.gate 风格的量级测试里。

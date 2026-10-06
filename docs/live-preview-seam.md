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

- **S1 隐藏** ✅：hide spans + 换算 + 命中测试。验收通过（gpui-kit 64d87947）。
- **S2 inline widget** ✅：行内公式（MathML）、图片、勾选框、子弹、callout 标题 chip、
  水平线。验收通过（bnote-gpui c209856 + 图片 widget）。
- **S3 block widget**（进行中）：行区间替换为声明高度的元素，**外加插入语义**
  （`lines: L..L` = 在 L 行行首插入、不替换任何行；`L == 行数` = 文末插入）。
  bnote-core 侧的模型已经就绪（见下），引擎侧在 gpui-kit。
- **S4 bnote 侧扫描** ✅：`bnote-core::preview::scan`——纯数据规则，
  `(text, selections, visible, math_preview) → PreviewSnapshot{spans, blocks, panels}`，
  64 个测试；全文档扫描线性（perf_tests 门禁）。
- **S5 逐行容器样式**（未开始，引擎侧）：见下节。

## S3/S5 的宿主侧数据模型（bnote-core 已产出，引擎/宿主照此消费）

```rust
// 替换或插入的块元素；`last_line == None` = 插入（见上）
struct PreviewBlock { first_line: usize, last_line: Option<usize>, kind: BlockKind }
enum BlockKind {
    Math { tex, display },          // 多行公式块（替换）
    MathPreview { tex },            // 编辑中公式的渲染副本（插入，锚在块下一行行首/文末）
    Callout { title, body_first_line, body_last_line },   // `:::` 边界行（替换，widget 自带块面）
    HiddenLine,                     // 围栏行：零高塌陷（`.cw-hidden-line{height:0}`）
}
// 逐行"样式"容器：行保持可见可编辑,永不替换
struct PreviewPanel { first_line, last_line, kind: PanelKind }
enum PanelKind {
    Callout { depth, open_line, close_line },  // 背景+左竖线+按深度内缩+顶/底帽；不随光标门控
    CodeBlock,                                 // 围栏体行：code-block 底色 + 等宽；仅光标在块外
    Blockquote,                                // 引用行：左竖线+accent 斜体；仅非活动行
}
```

**S5 引擎需求：行级样式通道（`PreviewLineStyle`）**——逐行容器视觉，只改
x 不改 y（取舍见下）：

```rust
/// 一行的容器样式：TS 行类 `md-callout-line` / `md-code-line` / `md-quote`
/// 的引擎侧表达。
pub struct PreviewLineStyle {
    pub line: u64,
    /// 整行背景：文本区左缘 → 右缘（**不是**文本末尾），画在文本之下。
    pub background: Option<Hsla>,
    /// 文本区左缘的竖线 `(宽, 色)`。
    pub left_border: Option<(Pixels, Hsla)>,
    /// 文本左缩进（TS `padding-left` 11/25/39px）；wrap 宽度随之收窄。
    pub inset: Pixels,
}
```

放进 `PreviewDecorations`（新增 `lines` 字段），随 `set_preview_decorations`
一次生效。契约：

- 按 `line` 升序、每行至多一条；被块替换的行不下发（无文本，样式无效果）；
- **不动行高、不动块几何、不动 `scroll_size`**：inset 只改 x（文本起点、
  wrap 宽度、命中/光标 x）；查表用单调游标（与 spans 同款），空表零开销；
- 竖线画在 inset 区域内（TS 里 `border-left` 与 `padding-left` 并列，都从
  文本区左缘起算）。

已评估并**有意未做**（记录缺口，不阻塞当前视觉）：
- 行 padding（`padding-top/bottom: 8px`）：只在 callout 边界行，而边界行是
  块替换（宿主已把 8px 帽算进块高），body 行无 padding——不需要；
- 标题字号（1.7/1.5/1.2/1.1em）与行高表：`HighlightStyle`/`TextRun` 无
  per-run 字号，per-line 字号要求"行高表"替代统一 `line_height`（波及
  滚动尺寸、可见范围反查、光标 y、vim 像素锚定）——单独立项；
- 圆角：背景矩形的 4px 顶/底帽在 callout 里由**块**绘制，行背景不需要。

**S5 通道的宿主消费清单**（TS 行类 → `PreviewLineStyle`，颜色取自同一份
CSS 变量）：
- `md-callout-line d{n}`：背景 `h2@8%`、竖线 3px `h2@50%`、inset 11/25/39px
  （面板不随光标门控，core 的 `PreviewPanel::Callout` 已备齐）；
- `md-code-line`：背景 `--code-block-bg`（无竖线、无 inset），仅光标在块外
  （core `PanelKind::CodeBlock`）；
- `md-quote`：竖线 3px `h2@40%`、文字 `h2` 色 + **斜体**（TextDecoration 的
  font_style 即可），**无 inset**；仅非活动行（core `PanelKind::Blockquote`）；
- `md-list-line li-i{depth} li-{b,t,o}`：**悬挂缩进（另立项）**——
  `padding-left: li-px + li-hang` + `text-indent: -li-hang`：首行文本起于
  `li-px`（`0.8125em + depth×1.75em`），续行起于 `li-px + li-hang`（槽宽
  按种类）；引擎侧表达 = 行 inset(`li-px`) + 续行 wrap indent(`li-hang`)，
  且 bullet widget 的声明宽度应与 `li-hang` 对齐（现在 0.62em 是近似）。

**S6 文本样式通道（core ✅ / 宿主 ✅，不需引擎改动）**：core 的
`PreviewSnapshot` 增加 `styles: Vec<PreviewStyleSpan>`（范围 + `SpanStyle`：
Strong/Emphasis/Strike/InlineCode/Link/LinkUrl/WikiLink/Heading{level}/
HeadingMark/ListMark/MathDelim/MathCmd/MathBrace，逐个对应 TS 的
`Decoration.mark` 类），宿主翻译成引擎既有的 `TextDecoration`
（`HighlightStyle` 的 color / font_weight / font_style / background_color /
strikethrough），颜色取自同一份 `global.css` 变量（经 `ActivePalette`）。

两条与 TS 逐字对齐的门控事实（core 测试锁定）：
- inline code 的内容 mark **无条件**（光标在内时源码可见但仍有底色）；
- emphasis/strong/strike 的整个处理由 `!active(node)` 门控，光标在其内时
  **连 mark 都没有**；heading 的 `md-hmark` 只在光标行，`md-heading md-h{n}`
  恒有。

已评估并**有意未做**：标题字号（1.7/1.5/1.2/1.1em）与 `.md-hline-{n}` 的
行垂直留白（h1 上 22px、h2 18px、h3 14px、h4-6 10px，h1/h2 下 2px）——两者
都要求"行高表"取代统一 `line_height`（与 S5 的 per-line 字号同源），单独
立项。样式先行以颜色 + 字重表达标题。

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

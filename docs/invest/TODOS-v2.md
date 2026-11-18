# 投资模式第二轮改进待办（v2）

> 输入：三位盲测用户的报告（职业交易员 / 卖方分析师 / 量化基金经理，各 272–587 次工具操作的真实交互）+ 业界调研（[RESEARCH-v2.md](./RESEARCH-v2.md)：TradingView / 同花顺 / Bloomberg / 聚宽口径 / AI 投研助手形态）。
> 原则：数据正确性 > 工作流效率 > 功能广度。**每一项带验收标准**，完成后勾选并注明证据。
> 三份报告的留存：本文引用编号 B=交易员、F=分析师、Q=量化经理。

## 0. 三份报告的共同结论

- **骨架成立**：三栏 + per-scope 文档/会话 + 快捷键全区域生效（三方一致认可）。
- **数据层坏**：单位/口径混乱、K 线主图 0 高、导入无入口、快照与 K 线矛盾无提示（三方一致 P0）。
- **Agent 未融入投资语境**：欢迎语/会话名/上下文可见性全是学习模式复制品；且分析模式下详情整体消失（分析师 P1-2/P1-7）。
- **键盘工作流与业界差距**：↑↓ 切股、键盘精灵、K 线 ←→/↑↓ 缺失（调研第 2 节）。

---

## 批次 A — 数据正确性（P0，全部必修）

### A1 金额与比率单位契约（F P0-1/2/4、B P0-2/3、Q P0-5）
- **契约（写入 DESIGN.md）**：金额一律「元」（akshare/交易所原始口径）；比率一律 0–1 小数（0.91 = 91%）。腾讯快照抓取入库前换算（亿→元、百分数→小数）。
- [ ] `ingest.rs fetch_quote_snapshot`：amount/market_cap/float_cap ×1e8，turnover /100
- [ ] `DetailTabs`：全部金额过 `yi()`（元口径），全部比率过 `pct()`（2 位小数）；资金流 `change_ratio` 修复直拼 bug；浮点尾巴（`0.16999999999999998%`）消除
- [ ] 毛利率/净利率/ROE/ROA/负债率按 0-1 小数显示 91.00%
- [ ] 财务表补列：扣非净利、经营现金流、ROA、流动比率（数据已在库，UI 未展示）
- 验收：茅台财务营收 400 亿（预置数据按元重生成）、毛利率 91.00%、资金流涨跌 -3.27%；快照成交额 148.42 亿。

### A2 K 线主图高度 0（三方一致 P0，B P0-1/Q P1-14）
- **根因**：`.invest-center-content` 无 flex 规则 → 中栏内容高度塌缩 → klinecharts 主图分到 0px。
- [ ] `global.css`：`.invest-center-content { flex: 1; min-height: 0; display: flex; }`
- [ ] 空态遮罩高度异常修复（`.invest-kline-overlay` inset:0 贴合容器）
- 验收：进入模式主图 ≥ 中栏高度 60%；VOL/MACD 副图可见；窗口缩放后正常。

### A3 自选星标恒 true（F P1-6、B P1-6）
- **根因**：`store.toggleWatch` 硬编码 `setWatch(..., true)`。
- [ ] toggle 语义：读当前值取反；乐观更新 + 失败回滚
- 验收：点 ★ 移出（watch=false），再点加回；「仅自选」过滤联动。

### A4 read_skill 运行时失败（F P1-8）
- **根因**：AgentPanel（子组件 effect）先于 InvestLayout initialize 启动会话，`invest_scope` 冻结为 None。
- [ ] invest 模式 `startSession`：selectedScope 为 null 时不启动会话，等 identity 随 scope 变化再启动（无 scope 无会话的不变量）
- [ ] 集成测试锁定：scope 未定时无会话；scope 就绪后自动启动
- 验收：进入模式自动选中标的 → 分析面板直接可用，read_skill 成功返回 SKILL.md。

### A5 预测回放 asOf 锚定墙钟日期（Q P0-6）
- **根因**：`REPLAY_LAG_DAYS` 从墙钟日期倒推，数据止于过去时必然 NOT_FOUND。
- [ ] asOf 缺省改为「数据最后交易日 − 10 个交易日」（后端计算：查该 scope 最后 bar 日期）
- [ ] 数据陈旧时错误信息友好化：「数据止于 YYYY-MM-DD，无法回放」
- 验收：预置数据上回放成功产出预测记录。

### A6 数据可信层（Q P0-2/3/4/5、Q P1-17）
- [ ] **导入质量闸门**（ingest 或 commands 校验）：OHLC 自洽（high≥max(open,close)、low≤min(open,close)）、close>0；非法行拒绝并报行号
- [ ] **数据陈旧提示**：K 线工具栏显示「数据截至 YYYY-MM-DD」，超过 7 个自然日标黄（用现有 --danger/--ok token）
- [ ] **快照与 K 线矛盾提示**：快照价格偏离末根 close >3% 时显示「快照与本地 K 线不一致（快照 X / K 线 Y）」
- [ ] 预置样例数据重生成：真实 A 股 2025 日历（跳过休市日）、跳空开盘、`source: "sample"` 不再冒充 akshare
- 验收：导入含休市日/负价数据被拒并报行号；陈旧数据顶栏标黄；无矛盾提示（数据一致时）。

### A7 导入数据入口（三方一致 P0）
- [ ] 命令 `invest.import-data`（⌘P 可达）：弹导入面板（选择 JSON 文件 → 预览计数 → 写入回显行数）
- [ ] 左栏空态文案可点（「导入数据」按钮直接打开）
- [ ] 导入面板字段映射说明（akshare 导出格式链接到 README）
- 验收：空 vault 用户 3 步内完成导入并看到 K 线。

### A8 编辑器空文档 RangeError（B P0-4）
- **根因**：`buildInlineDecorations` 在空文档上 `Invalid position Infinity`（live preview 装饰的位置计算未防护 0 行文档）。
- [ ] 复现并修复 livePreview 的空文档/单行文档边界（`src/editor/livePreview.ts` 或相关装饰模块）
- [ ] 回归测试：空文档 + 模板短文档不崩
- 验收：空文档打开无控制台报错；实时预览正常。

---

## 批次 B — 信息架构（P1）

### B9 Agent 面板移到左栏（F P1-2/P1-7 —— 架构修正）
- **依据**：原始需求即「左侧 Agent 面板 + 右侧笔记」；业界惯例 AI copilot 不占中栏（行情常驻）。
- [x] 左栏在「标的列表 | Agent 面板」间切换（⌘⌥A 分析 / ⌘⌥R 列表 + 按钮），**中栏 K 线+详情常驻**
- [x] 详情 tab 不再消失；移除 mainColumn 互斥逻辑在 invest 模式的使用
- [x] Agent 欢迎语/输入框 placeholder/scope chip 显示当前标的（名称+代码+行业）
- [x] 会话按 scope 命名（`600519 贵州茅台`），不再全叫「主会话」
- 验收：分析模式下详情仍可见；面板标注当前标的；read_skill 正常。

### B10 知识检索可用（F P1-4、B P2-13、Q P2-18）
- [x] 命中结果带**匹配片段**（docs_fts 是 contentless 表，FTS5 snippet() 不可用 → 后端 `docs::snippet_around` 字符安全截取 + Rust 测试）
- [x] 点击命中 → 切换到对应 scope + 打开该文档（store.openSearchHit：parseScope 容错 skill 版本文档）
- [x] ⌘⌥P 全局检索命令（`invest.search-knowledge`，结果带 scope 徽标 + 片段）
- 验收：搜「茅台」→ 3 条结果带片段 → 点击跳到 600519 的 events.md。

### B11 板块视图补齐（F P1-5/Q P1-13）
- [x] 板块详情加「成分股」列表（MembersTab，点击行下钻到个股；后端 sector_members 已有）
- [x] 误导文案修复：板块页不显示「刷新快照」（header 按钮已限定 stock scope）；空态按钮化
- [x] 板块 K 线导入路径与标的一致（invest_import_data 加 bar_kind="sector" → sector_kline_daily）
- 验收：板块页显示成分股 + 可导入板块指数数据出 K 线。

### B12 tab 状态记忆（F P1-9/P2-8）
- [x] 详情 tab 按 scope 记忆（`detailTabByScope`，切回不重置）
- [x] 右栏 doc tab 按 scope 记忆（`docByScope`，selectScope 恢复；文档被删则回退第一篇）
- 验收：行情页选「财务」→ 切分析 → 回行情仍是「财务」。

### B13 空态按钮化（Q P1-16、F P2-6）
- [x] 预测/回测/事件空态直接放「回放预测」「跑 ma_cross 基准」「新增事件」按钮（事件表单为 F26）
- [x] K 线空态放「导入数据」按钮
- 验收：空态页 1 次点击即触发动作。

### B14 快照 as-of 与刷新反馈（Q P2-22、F P2-4）
- [x] 行情 tab 显示快照抓取时间（fetched_at，批次 A 完成）
- [x] 刷新快照：store.refreshSnapshot（busy="snapshot" loading 态 + toast 显示新 fetched_at 或失败原因）
- [x] 「刷新快照」移出 tab 行，放到中栏 header 动作位（F P2-5）
- 验收：刷新后 toast 显示新 fetched_at 或失败原因。

---

## 批次 C — 键盘工作流对齐业界（P1，依据调研第 2 节）

### C15 ↑↓ 切股 + 列表键盘导航（同花顺/TradingView 惯例）
- [x] 左栏列表聚焦时 ↑/↓ 直接切换标的（`invest.list-up/down` 裸键 + moveListCursor），Enter 打开文档（`invest.open-doc`）
- [x] cycle 限定在**当前过滤结果**内（B P2-15），搜索框不清空；搜索框内 ↑↓ 也走过滤游标（globalKeys 对 editable 的裸键放行 + 组件级 onKeyDown）
- 验收：列表焦点下 ↓ 逐个浏览，⌘P 无关；搜索「茅台」后 ↓ 不会跳到未过滤标的。

### C16 键盘精灵（敲代码直达标的）
- [x] 列表持有焦点时敲任意可打印字符 → 聚焦搜索框并注入该字符（onSpriteKey），实时过滤即快搜；↓ 选择 + Enter 打开文档完成切换
- [x] 敲中文同样可达（名称匹配沿用 filterInstruments）
- 验收：任意时刻敲 `600519` → 搜索框自动聚焦并过滤；↓ + Enter 切到茅台。

### C17 K 线键位（TradingView 惯例：←→ 平移、-/= 缩放）
- [x] ←/→ 平移 20 根（scrollToDataIndex，钳制在数据范围）、-/= 缩放 1.25/0.8（zoomAtDataIndex 锚定末根）；↑↓ 保留给列表切股（同花顺核心），不与缩放冲突
- 验收：键盘可完成平移缩放，无需滚轮。

### C18 详情 tab 快捷键
- [x] `invest.detail-tab-1..7`（⌘⌥1..7）对应当前 scope kind 的第 N 个 tab（STOCK_TABS/SECTOR_TABS 与 DetailTabs 共享常量）
- [x] 回测/回放命令给出默认键位（⌘⌥F 预测回放 / ⌘⌥B 回测）；docs/keybindings.md 最后统一重生成
- 验收：⌘⌥3 直达财务 tab。

---

## 批次 D — 回测与预测增强（P1，量化报告）

### D19 回测结果展示补齐（Q P1-7/8/9、B P2-7）
- [x] **净值曲线**：轻量 SVG polyline（O(点数) 循环求极值，虚线 = 期初净值 1）
- [x] **交易明细表**：点击历史行展开（成交日/方向/股数/价格/费用/盈亏）
- [x] **指标口径说明**：总收益/年化/Sharpe/回撤全部带表头 tooltip（rf 2%、√252、复合年化、相对峰值）
- [x] **样本量提示**：交易数 < 30 显示「样本不足」（批次 A 完成）
- [ ] **成本参数**：佣金/印花税/滑点可配（默认万 2.5/千 0.5/0）——后端常量已是万 2.5 + 0.05%；可配置 UI 降级到 v3（见 backlog）
- 验收：跑一次回测 → 点击行 → 曲线 + 明细 + 口径说明齐备。

### D20 回测历史管理（Q P2-20、B P1-12）
- [x] 记录带运行时间戳（批次 A 完成）
- [x] 支持删除单条回测（invest_backtest_delete + devbridge + 行内 ✕）
- 验收：可删除重复运行产生的旧记录。

### D21 预测统计修正（Q P1-10）
- [x] forecasts 唯一键（scope+skill_version+as_of+target_date+mode）：migrate 先去重再建唯一索引，record 改 ON CONFLICT upsert（重放清空结算结果）+ Rust 回归测试
- [x] flat 单列统计（forecast.rs hard_score 已有：flat 只在 |move|<1% 计 0.5）
- [x] 命中率显示样本量 N 与「随机基线 50%」对比（批次 A 已有）
- 验收：重复回放不双计；准确率带 N。

### D22 基准对比（Q P1-7，可选依赖基准数据）
- [ ] 支持导入指数（如 000300）作为基准 scope；回测结果叠加基准净值曲线
- 验收：导入沪深300 → 回测页显示两条曲线与超额收益。

---

## 批次 E — 列表与快照增强（P1/P2）

### E23 列表升级为迷你评分表（Q P1-11 部分、B P2-3、B P2-17）
- [x] 每行加：现价、涨跌幅（新命令 invest_quote_overview 一次查询；无快照显示 —；涨红跌绿）
- [x] 自选分组置顶（「自选 / 全部」两段；moveListCursor 行走顺序与视觉一致）
- [x] 搜索无结果文案区分（批次 A 完成）
- 验收：不点开详情即可扫涨跌；自选段置顶。

### E24 快照盘口字段补齐（B P1-11）
- [x] 后端：涨跌停价（47/48）、振幅（43）、量比（49）——已用真实腾讯响应逐字段核对（3/4/5/33/34/6/37/38/39/44/45/46 现有映射同样全部吻合），Snapshot 加 4 列 + 旧库迁移 + roundtrip 测试
- [x] 行情 tab 显示：涨停/跌停/振幅/量比 + 52 周高低（bars 末 250 根聚合）
- 验收：600519 行情 tab 显示涨跌停价与振幅。

---

## 批次 F — 摄取与事件（P1/P2）

### F25 摄取失败明细（F P1-10、Q P2-21）
- [x] 摄取完成 toast 列出失败源与原因（前 2 个源 `source: error` + 计数；store.integration.test 锁定新契约）
- [x] 默认源保持 sina-finance-roll 单源（更稳公开 feed 需实测 URL 可用性，避免写死未验证端点；镜像说明在 yaml 头注释）
- 验收：源失败时 toast 直接显示原因。

### F26 事件手工补录（F P2-10）
- [x] 事件 tab 加「新增事件」表单（日期/类型/标题/正文/情绪；invest_event_add 复用 insert_event 的 dedup + 日期/标题校验）
- [x] 提交后 refreshDetail 刷新时间线；空态直接放「新增事件」按钮（B13 收尾）
- [ ] 事件写入同步追加到 events.md 文档（待办：写入时 attach 到 scope 文档）
- 验收：30 秒内补录一条结构化事件并出现在时间线。

---

## 批次 G — 锦上添花（P2）

- [x] G27 一键「插入当前标的快照表格」到右栏笔记（buildSnapshotMarkdown 纯函数 + 测试；SnapshotTab 按钮 → store.insertSnapshotToNote → findEditorFor(activeDocAbs) 追加，autosave 持久化）
- [x] G28 Agent 轮次上限前输出阶段性结论提示（session.rs 上限前 2 轮注入 system-reminder + Notice；SYSTEM_PROMPT 增收敛纪律第 7 条）
- [x] G29 分隔条：浏览器回归正常拖拽（CDP 假象判定维持，见盲测交叉对照）；命中区与最小宽度维持现状——真实人工验证留给部署后
- [ ] G30 板块列表涨跌列（需板块快照数据源，腾讯接口无板块快照；随 v3 的数据源扩展一起做）
- [x] G31 会话历史面板在 invest 模式可用（历史按钮打开，按 scope 命名的会话组「贵州茅台」+ 新会话按钮）

## v3 backlog（本轮不做，记录方向）

- 组合/持仓/风险暴露视图（量化最想要 #3）——需要持仓数据模型，规模大
- 批量评分/排名/导出表（量化最想要 #2）——依赖 F26/E23 后的信号聚合
- 跨标的对比视图（分析师最想要 #3）
- K 线画线工具与复盘锚点（交易员最想要 #1）
- 分时图、五档盘口、复权（前/后）、分钟线
- 数据增量同步（akshare 自动拉取）
- AI 上下文分级开关（scoped context switching）与 inline citations

---

## 执行顺序与验证

1. 批次 A 全部 → gate + cargo test → 浏览器回归（K 线/财务/资金流/自选/read_skill）
2. 批次 B → gate → 浏览器回归（agent 移左栏/检索跳转/板块成分股）
3. 批次 C → gate + keybindings 文档重生成
4. 批次 D → cargo test（trades/统计）→ 浏览器回归
5. 批次 E/F/G → gate → 浏览器回归
6. 全部完成后：TODOS-v2 全量勾选审计 + README/DESIGN 同步 + 交付总结

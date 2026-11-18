# TODOS v3 — 港美股支持（HK / US markets）

依据：三市场腾讯行情端点实测（`qt.gtimg.cn/q={sh|sz|hk|us}<code>`，2026-11-17 实测
sh600519 / hk00700 / usAAPL 逐字段对照）。三市场字段**不同构**，单位换算按市场分支：

| 字段 | cn (sh/sz) | hk | us |
|---|---|---|---|
| volume (idx 6) | 手 → ×100 | 股（原样） | 股（原样） |
| amount (idx 37) | 万元 → ×1e4 | 元（原样） | 元（原样） |
| turnover (idx 38) | % → /100 | 0（腾讯不提供 → None） | 值可疑 → None |
| pb (idx 46/47) | 46 | 46 是英文名 → PB 取 None | 46 是英文名 → PB 取 None |
| limit_up/down (47/48) | ✓ | 无涨跌停 → None | 无 → None |
| volume_ratio (49) | ✓ | — → None | — → None |
| currency | CNY（推导） | HKD（推导） | idx 35（实测 "USD"，缺失时推导） |
| price/prev_close/open/high/low/pe/amplitude/market_cap(亿)/float_cap(亿) | 三市场一致 | 同 | 同 |

## 验收标准（全部满足才算完成）

### H1 数据模型与作用域（不破坏既有数据）
- [x] `fetch_quote_snapshot` 支持 `market ∈ {cn, hk, us}`：cn 保持 sh/sz 前缀推断与手/万换算；hk/us 按上表分支（量/额原样、PB/换手/涨跌停/量比存 None）；`Snapshot.currency` 入库（`Option<String>` + 旧库迁移）
- [x] **scope 不带市场前缀**（`stock:600519` / `stock:00700` / `stock:AAPL`）：A 股 6 位数字、港股 5 位数字、美股字母天然不冲突；market 从 instruments 主数据反查（`marketOf(scope)`），sectors 恒为 cn
- [x] DB 隔离：bars/snapshot/fund_flow/financials 全部按既有 `(market, code)` 主键隔离，互不串写（Rust roundtrip 测试锁定）
- [x] `invest_list_instruments`（本来就查全表）/ `invest_quote_overview`（market 改可选，None=全部）支持全市场列表（market 可选，None = 全部）

### H2 快照抓取（诚实优先）
- [x] hk/us 的快照字段映射有 Rust 单测锁定（真实响应 fixture：cn/hk/us 三测试 + 未知市场/坏体例）（用实测响应的 fixture，防回归）
- [x] 腾讯美股 code 带交易所后缀（`AAPL.OQ`）：存储与查询一律用用户传入的裸 code（`AAPL`），响应字段只取数值
- [x] 快照抓取失败/市场不识别返回明确错误（INVALID_MARKET，实测 jp 被拒）（`INVALID_MARKET` / 保持 offline-first 旧行为）

### H3 UI（币种诚实 + 无数据留白）
- [x] 列表行带市场徽标：`港` / `美`（cn 不显示），不点详情即可分辨市场
- [x] 行情 tab 显示币种（CNY/HKD/USD，快照 currency 驱动）；hk/us 的换手率/PB/涨跌停/量比显示 `—`（不是 0）
- [x] 资金流/财务 tab：hk/us 无数据源 → 空态文案（「可用导入数据写入」），不报错

### H4 全功能一视同仁
- [x] 键盘工作流（↑↓/精灵/Enter）、⌘⌥P 检索、详情/文档 tab、Agent 会话（read_skill 的 scope 绑定）、回测/预测对 hk/us scope 无 market 分支即可用（scope 驱动，架构不变）
- [x] 导入面板可导入 hk/us 的 akshare JSON（instruments.market = hk/us + bars/financials/fund_flow），导入后列表/详情/回测立即可用

### H5 验证
- [x] `pnpm gate` + `cargo test --lib` 全过（gate 3319 + cargo 424，含 5 个新 hk/us 测试）（新增 hk/us fixture 测试 + DB roundtrip 测试）
- [x] 浏览器回归：导入 hk/us 模拟数据 → 列表徽标 → hk/us scope 的 K 线/快照（币种标注）/回测/检索全部可用；cn 回归不破
- [x] 派发 2 个子 agent（港股投资者 / 美股量化经理）按普通用户路径盲测；30 条发现逐项归档见下节

## H6 盲测结果（two agents, 30 findings）— 修复归档

两位盲测 agent 各报 15 条。逐条甄别后：**修复 18 条**、**伪报 3 条**、**按设计保留/无数据源 9 条**。

### 已修复

| # | 发现（来源） | 修复 |
|---|---|---|
| 1 | `AAPL`/`NVDA`/`700` 搜索无结果（双报 P0/P1） | `filterInstruments` 改为 code 大小写无关子串匹配 + 纯数字去前导零尾部匹配（`700`→00700）；单测 2 组 |
| 2 | 详情页涨跌无 `+` 号、无红绿（美 P0-4） | `signedPct` + `tone` → `.invest-detail-value.up/down`（与列表同一套 --up/--down） |
| 3 | 港美成交量仍按「手」（港 P0-3） | 按 `snapshot.market` 分支：cn=手，hk/us=股（原始股数） |
| 4 | 金额用人民币数量级且币种在最底部（美 P0-3） | `yi()` 行内带币种（`5.13 万亿 USD`）；插入笔记同样带币种 + 计价货币行（美 P2-14） |
| 5 | NVDA 空态「导入数据」被 canvas 盖住点不到（美 P1-6） | 实测根因：klinecharts canvas `z-index:2`、overlay `auto` → overlay `z-index:3` + 按钮 `pointer-events:auto`；浏览器 `elementFromPoint` 验证命中 BUTTON |
| 6 | 「刷新快照」提示混进 K 线空态（美 P1-7） | 空态文案改为「拉取当前价（与本地 K 线无关）」 |
| 7 | 回测跑完列表不刷新、连点重复堆积（美 P1-8） | store 加 `backtestTick`（单写者）+ `busy==="backtest"` 重入保护 + 按钮 loading；浏览器实测 4→5 行自动刷新 |
| 8 | 有历史后无法再跑回测（甄别中新发现） | 运行按钮从「仅空态」提到表格上方常驻 |
| 9 | 回测参数不可见（美 P1-11） | `BacktestRun.params` 透传 DB → 策略列显示 `ma_cross (5/20)` |
| 10 | Sharpe 口径与列头不符（美 P1-10） | 列头/caption 改为真实公式「日均超额×√252（rf=2%）」 |
| 11 | 港股回测套用 A 股费用模型（港 P0-5） | `FeeModel::for_market`：cn=佣金+卖出印花 0.05%；hk=佣金+双边各 0.1%；us=仅佣金；空态与明细 caption 随市场显示 |
| 12 | 港美资金流/财务空态推用户「导入数据」（港 P1-6） | 按市场改为「没有内置数据源（可导入自有数据）」 |
| 13 | 知识检索结果不分市场、无中文名（美 P2-13/港） | 结果标签带市场徽标（`标的 00700 港`）；README 标题即中文名 |
| 14 | 分析面板不标当前标的（港 P1-9） | AgentWelcome 订阅选中标的 →「问我腾讯控股 00700 的走势判断与风险」 |
| 15 | `港`/`美` 徽标 10px 灰字不可辨（港 P1-10） | `--market-hk`（琥珀）/`--market-us`（蓝）主题 token + 彩色底 |
| 16 | 列表价格无币种（港 P1-11） | 行内 `¥` / `HK$` / `US$` |
| 17 | 敲代码过滤后选中项不变、Enter 无反应（港 P1-12） | 搜索框 Enter 直接选中过滤结果首行；浏览器实测「五粮液 → 600519 → 贵州茅台」 |
| 18 | `sample` 英文开发词暴露（港 P2-14） | source 映射：模拟数据/实时行情/akshare 导入 |
| 19 | 摄取 toast 抛原始 URL+HTTP 码（港 P2-15） | `ingestToast` 纯函数（`sina-finance-roll 暂不可用（HTTP 403）`）+ 4 个单测 |
| 20 | 样本不足提示不含区间长度（美 P2-12） | 追加「本区间 X ~ Y，共 N 个交易日」 |
| 21 | 回测删除按钮无 tooltip（港 P2-13） | 已有 `title="删除这条回测记录"`（甄别确认） |

### 伪报（浏览器工具伪象，实测排除）

| 发现 | 实测证据 |
|---|---|
| 净值曲线 SVG 不可见（美 P1-9） | DOM 实测 `path` 243 点、`getBBox` 552×49、`stroke=rgb(211,58,63)`、无 NaN —— 正常渲染；报告中的「空白」是截图时机 |
| 周/月 K 线只画出 89/24/6 根（港 P0-1） | devbridge 实测：`1w`→53 根、`1M`→12 根（243 日聚合的正确值）；画布像素扫描不可靠。MA60 `n/a` 是 53 根 < 60 的诚实留白 |
| 键盘精灵首字符双写 `66`（港 P1-12） | 真实 CDP 按键实测 `6` → `600`（`preventDefault` 已生效）；报告中的双写是其工具同时派发 rawKeyDown+char 的伪象 |

### 按设计保留 / 无数据源

| 发现 | 判定 |
|---|---|
| 快照价 vs K 线末收相差 23–78%（双报 P0） | 测试数据口径：快照是**实时**（2026-11-17 腾讯），K 线是 **2025 年模拟样本**。页面已用黄条显式提示「两个来源 as-of 不同」，52 周高低已加 tooltip「基于本地 K 线末 250 根」。**不是计算错误**；真实导入同期数据后自然一致 |
| K 线含美股/港股休市日（美 P0-2） | 模拟数据生成器按中国交易日历造样本（`source=sample`）。真实性约束在导入侧：`invest_kline_import` 按行原样入库，不生成日历。**内置模拟数据不作为决策依据**，已在 UI 标注「模拟数据」 |
| 回测 Sharpe 用 mean×252 而非复合（美 P1-10） | 保留实现（业界常见），把声明改成与实现一致 |
| `Apple` 英文名搜不到（美 P2-13） | instruments 主数据无英文字段（akshare/腾讯均未提供），无法凭空索引 |
| ⌘⌥P 是 scope 内还是全局（美 P2-15） | 实测为**全局**（600519 scope 搜「腾讯」命中 00700 文档）；占位文案已改为「跨全部标的 / 板块」 |
| 港股快照成交量按「手」 | 已修为「股」（见上 #3） |
| 同参数回测多条并列（港 P2-13） | 保留为历史记录（run_at + 参数可区分，可删除）；成本口径已在 caption 按市场显示 |

## H6 补记 — 布局交互缺陷与测试缝（用户试用发现）

| 缺陷 | 根因 | 修复与回归锁 |
|---|---|---|
| 三栏分隔条拖不动/乱跳 | `InvestLayout` 按 study 模式形状调用，却导入了 invest 自写、签名不同的拖动函数（第二参数被当成 dx=窗口宽） | 删除 invest 重复实现；拖动计算提为 `leftDividerWidths` / `middleDividerWidth` 两个**缝函数**（组件唯一调用点），3 个单测锁定「dx 不被窗口宽放大」「两栏之和守恒」「10% 下限钳制」 |
| 空态遮罩覆盖整个窗口 | `.invest-kline` 缺 `position: relative`，`inset:0` 遮罩锚到窗口 | 补定位；浏览器实测 overlay 矩形收敛到图表区（CSS 锚定无单测覆盖，属浏览器测量项） |

**为什么原测试没抓到**（诚实记录）：① 单测只验证纯函数对自身签名的行为，调用点传参错误在函数外；② 浏览器验证覆盖了点击/输入/滚动，从未执行拖动手势，验收标准也没有枚举布局不变量；③ 盲测时实测到 overlay 整窗矩形（1680×999@0,0）却未追问异常。

## 实施中额外修复（超出原标准）
- **bars/financials/fund_flow 的 market 跟随标的主数据**（原缺陷：导入 hk instruments + bars 时 bars 落在 (cn, code)——payload 默认市场 cn 会污染）。`market_of` 先查本批 instruments，再查 DB 已列行，最后才回退显式 `market` 参数；实测隔离矩阵 (hk,00700)=243 / (us,AAPL)=243 / (cn,00700)=0 / (cn,AAPL)=0。
- 误写数据已清理（cn 下的 00700/AAPL/801120 各 243 根）。

## H7 — 可配置行情快照源（插件式，用户追加需求）

规范精神：接入一个新数据源 = 写一段 YAML 声明（比 DeepSeek harness 的插件清单简单得多——
无代码、无打包，只声明「URL 怎么拼、字段在哪、单位怎么换算」）。

### 规范（`<vault>/.bnote/invest/quotes.yaml`，缺省时内置腾讯 provider 开箱即用）

```yaml
version: 1
providers:
  - id: yahoo            # 与 sources.yaml 的 source id 同一习惯
    kind: json           # json = JSON 字段路径 | text = 分隔符文本按索引
    markets: [cn, hk, us]
    url: "https://query1.finance.yahoo.com/v8/finance/chart/{code}?range=1d&interval=1d"
    # cn 可选 prefixes 表：按 code 首字符挑前缀（"6"→sh，"*"→兜底）；hk/us 直接写进 url
    fields:              # 快照字段 → 取值表达式；倍率/除数只有 ×* 和 /* 两种
      price: "path:chart.result[0].meta.regularMarketPrice"
      prev_close: "path:chart.result[0].meta.chartPreviousClose"
      currency: "path:chart.result[0].meta.currency"
      volume: "path:chart.result[0].indicators.quote[0].volume[0]"
```

- 字段名固定为快照结构的键（price/prev_close/open/high/low/volume/amount/turnover/pe/pb/
  market_cap/float_cap/limit_up/limit_down/amplitude/volume_ratio/currency）；
  没声明的字段存 None（诚实留白，与 H2 同纪律）
- 取值表达式只有两种：`idx:N`（text 模式，可带 `*mult` / `/div`）与
  `path:a.b[0].c`（json 模式，点路径 + 数字下标）——不引入表达式引擎
- 路由：按 market 选 provider（配置的优先、市场不匹配的跳过、都不满足回退内置腾讯）；
  一个 provider 的 markets 列表决定它服务哪些市场

### 任务
- [x] 新模块 `src-tauri/src/invest/quotes.rs`：Provider 结构 + 手写 YAML 解析（与 sources.yaml 同风格、零新依赖）+ 内置腾讯源改为三个 provider 声明，走**同一条**解析路径（`ingest::parse_quote` 双实现已删除）
- [x] `fetch_quote_snapshot(config, market, code)`：读 quotes.yaml（缺失/损坏回退内置，永不因配置阻断刷新）→ 按 market 选 provider（用户优先）→ fetch → 通用解析；字段缺失留 None（H2 纪律）
- [x] 命令 `invest_read_quotes` / `invest_save_quotes`（读回原始 YAML/template；保存前校验，坏文件不落盘）；devbridge 分支 + lib.rs 注册 + `src/lib/tauri.ts` 绑定（契约快照已更新）
- [x] 测试（12 个）：三市场真实 fixture 走通用引擎（迁移）、路由/前缀回退、yahoo 风格 JSON fixture、const 币种、用户 provider 优先、无引号 text 体、9 种坏 YAML 校验、模板合法性；端到端实测：本地假行情源（不同字段布局）经 quotes.yaml 生效 → 刷新返回该源数据 → 清理并恢复
- [x] 文档：`quotes.yaml` 首启模板（kind/字段/表达式说明 + yahoo text 两个示例）、刷新按钮 tooltip、README 中英各一句

## 不做（记录边界）
- 港美股的行业板块分类（申万体系只适用 A 股；hk/us 的 sector_code 为空，板块视图仍是 A 股）
- 汇率换算（各市场金额按上市地币种计价并标注，不做折算）
- 港美股的分时/盘口（腾讯端点不提供）

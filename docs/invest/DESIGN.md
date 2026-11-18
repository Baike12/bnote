# 投资模式（Invest Mode）设计

> 状态：定稿 v1（实现中的唯一设计依据）。后续轮次的改进台账见
> [TODOS-v2.md](./TODOS-v2.md)（盲测改进，含未完成项）与
> [TODOS-v3.md](./TODOS-v3.md)（港美股与已归档的盲测发现）。v1 实施台账已完成并移除，
> 历史见 git。

## 0. 目标与用户故事

用户按 `⌘⌥I` 进入投资模式（再次按下退出）。三栏布局（左：标的/板块面板；中：K 线 + 当前标的详情；右：笔记）：

- **左栏**：A 股标的列表（自选 + 搜索），可切换到板块视图（申万行业分类）。
- **中栏**：上半 K 线图（klinecharts 9.x，与 hoshi 同款），下半详情 Tab（行情快照 / 资讯 / 资金流 / 简况 / 财务 / 事件 / 知识）。聚焦中栏时按 `⌘⌥→/⌘⌥←`（`invest.next/prev-instrument`）切换标的。
- **右栏**：笔记编辑器（复用 EditorPane / CodeMirror），顶部是当前标的的文档 Tab 组，一个标的的全部文档（分析结论、Agent 报告、事件沉淀、Skill 记忆摘录）在此切换。
- **Agent 面板**：中栏被聚焦切换到 Agent 列（与 study/code 的 `mainColumn` 机制一致）时显示，对当前标的做 AI 分析；复用现有 agent 基建，会话与工具按标的隔离。

标的与板块都支持：网络信息摄取（YAML 配置源 + 处理方式）→ 沉淀为本地文档 → 进入本体（知识库 FTS + 知识图谱实体/关系）→ Agent 可检索。每个标的/板块有一个 **Skill**（策略文档 + 记忆文档，双文件），用于预测走势；预测用历史数据回放验证，错了就由 Agent 反思修订 Skill 并版本化。回测引擎把 Skill 产生的信号变成可量化的净值/指标，回测结果反哺 Skill 迭代。

## 1. 参考项目对照（本地已拉取/已有）

| 参考 | 采纳什么 | 位置 |
|---|---|---|
| hoshi | 三栏两级嵌套布局、详情 Tab 清单（行情/资讯/资金流/简况/财务）、K 线用 klinecharts、volume 量纲约定（存股、CN 展示手=÷100）、prepare+read 两段式数据契约 | `../hoshi` |
| SkillOpt | Skill=自由 Markdown + 受保护区块；优化循环 rollout→reflect→bounded edit→gate（严格变好才接受）；SKILL/MEMORY 双文档 | `../SkillOpt` |
| WeKnora | 双平面存储（关系库元数据 + FTS 检索平面）、chunk 链表/父子/context_header、SQLite WAL+单连接+CJK bigram、实体-关系-mentions 三表 | `../WeKnora` |
| backtrader | 事件驱动回测模型：feed→strategy(信号)→broker(撮合/持仓)→analyzer(Sharpe/Drawdown/Returns/TradeAnalyzer) | `../backtrader` |
| NVIDIA auto-ontology | 语义目录模型：实体/指标/关系/lineage/provenance | `../AutoOntology` |
| OpenViking | 上下文即虚拟文件系统：目录带摘要、agent 先扫摘要再读全文（`viking://` 思想落到本地文件夹） | `../OpenViking` |

## 2. 总体架构

```
┌─ InvestLayout（mode="invest"）────────────────────────────────────────────┐
│ InstrumentList        KlineChart + DetailTabs            EditorPane       │
│ (A股/板块)            (klinecharts)   (行情/资讯/资金流/  (文档Tab组)      │
│                                        简况/财务/事件/知识)                 │
│        ↑ AgentPanel（mainColumn 切换后占中栏，分析当前标的）                │
└──────────────────────────────────────────────────────────────────────────┘
        │ src/invest/store.ts (Zustand)          │ src/lib/tauri.ts investApi
┌───────▼────────────── Rust 后端 ───────────────▼──────────────────────────┐
│ invest/db.rs   SQLite(<vault>/.bnote/invest/invest.db, WAL)               │
│   行情/标的/板块/事件/文档索引/FTS/实体/关系/预测/回测                            │
│ invest/instruments.rs  invest/kline.rs  invest/sectors.rs  invest/docs.rs │
│ invest/ingest.rs (YAML源→抓取→处理→落盘→FTS→实体)  invest/skill.rs         │
│ invest/forecast.rs (Skill回放打分)  invest/backtest.rs (事件驱动回测)        │
│ commands/invest.rs  →  lib.rs 注册  →  devbridge.rs 浏览器模式              │
└──────────────────────────────────────────────────────────────────────────┘
```

**性能契约（承 hoshi）**：读取路径只读库/读文件，绝不在请求内抓网。抓取一律走 `invest_ingest_run`（后台、可中断、事件推送进度）或 `invest_kline_import`（显式导入）。

## 3. 数据存储

### 3.1 SQLite（`<vault>/.bnote/invest/invest.db`）

连接：rusqlite（bundled 特性，免系统依赖）。`WAL` + `busy_timeout=5000` + `foreign_keys=on`；AppState 持有 `Mutex<Connection>`（单写多读，本地规模足够），命令线程短锁克隆数据，不持锁做网络/重活（AGENTS.md Rust 规则 5）。

```sql
-- 标的主数据（对应 hoshi stock_master）
CREATE TABLE IF NOT EXISTS instruments (
  code TEXT NOT NULL,            -- 6 位 A 股代码，如 600519
  market TEXT NOT NULL DEFAULT 'cn',
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',   -- 申万一级
  sector_code TEXT,                    -- 关联 sectors.code（申万一级代码）
  sector_sub TEXT,                     -- 申万二级
  kind TEXT NOT NULL DEFAULT 'stock',  -- stock | etf | index
  note TEXT NOT NULL DEFAULT '',       -- 用户一句话备注
  watch INTEGER NOT NULL DEFAULT 0,    -- 自选
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market, code)
);
CREATE INDEX IF NOT EXISTS idx_instruments_industry ON instruments(industry);
CREATE INDEX IF NOT EXISTS idx_instruments_name ON instruments(name);

-- 日 K 线（hoshi volume 量纲：存“股”，展示层 CN ÷100 为“手”）
CREATE TABLE IF NOT EXISTS kline_daily (
  market TEXT NOT NULL, code TEXT NOT NULL, ts TEXT NOT NULL,  -- YYYY-MM-DD
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL, amount REAL,          -- amount 元，可空（新浪源）
  source TEXT NOT NULL,
  PRIMARY KEY (market, code, ts)
);
CREATE INDEX IF NOT EXISTS idx_kline_daily_ts ON kline_daily(market, code, ts DESC);

-- 板块（申万一级行业为默认骨架，业界通行；概念板块可由导入扩充）
CREATE TABLE IF NOT EXISTS sectors (
  code TEXT PRIMARY KEY,        -- 如 801010（申万一级代码）
  name TEXT NOT NULL,           -- 农林牧渔…
  level INTEGER NOT NULL DEFAULT 1,   -- 1=一级 2=二级 3=概念
  parent TEXT,
  summary TEXT NOT NULL DEFAULT ''
);

-- 板块日 K 线（板块指数）
CREATE TABLE IF NOT EXISTS sector_kline_daily (
  code TEXT NOT NULL, ts TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL, amount REAL,
  PRIMARY KEY (code, ts)
);

-- 标的快照（最新行情快照，腾讯源字段）
CREATE TABLE IF NOT EXISTS snapshots (
  market TEXT NOT NULL, code TEXT NOT NULL,
  price REAL, prev_close REAL, open REAL, high REAL, low REAL,
  volume REAL, amount REAL, turnover REAL,      -- 换手率 %
  pe REAL, pb REAL, market_cap REAL, float_cap REAL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (market, code)
);

-- 资金流（新浪 moneyflow 字段，近 N 日）
CREATE TABLE IF NOT EXISTS fund_flow (
  market TEXT NOT NULL, code TEXT NOT NULL, date TEXT NOT NULL,
  close REAL, change_ratio REAL, turnover REAL,
  net_amount REAL, net_ratio REAL, main_net REAL, main_ratio REAL,
  PRIMARY KEY (market, code, date)
);

-- 财务摘要（hoshi 15 指标精选，报告期维度）
CREATE TABLE IF NOT EXISTS financials (
  market TEXT NOT NULL, code TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL, fiscal_period TEXT NOT NULL,  -- Q1/H1/Q3/FY
  revenue REAL, revenue_yoy REAL, net_profit REAL, net_profit_yoy REAL,
  deduct_profit REAL, op_cashflow REAL, eps REAL,
  gross_margin REAL, net_margin REAL, roe REAL, roa REAL,
  debt_ratio REAL, current_ratio REAL,
  data TEXT,                                   -- 其余扩展字段 JSON
  PRIMARY KEY (market, code, fiscal_year, fiscal_period)
);

-- 事件流（摄取管线沉淀的结构化事件，行情相关的一切“最近发生的事”）
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,          -- 'stock:600519' | 'sector:801010' | 'market'
  date TEXT NOT NULL,
  kind TEXT NOT NULL,           -- news | announcement | report | flow | macro | manual
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  sentiment TEXT,               -- bull | bear | neutral（处理管线判定）
  dedup_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(scope, dedup_hash)
);
CREATE INDEX IF NOT EXISTS idx_events_scope_date ON events(scope, date DESC);

-- 文档（本地 Markdown 的索引；文本文件本体在文件夹里，这是索引）
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path TEXT NOT NULL UNIQUE,   -- .bnote/invest/ 下相对路径
  scope TEXT NOT NULL,             -- 'stock:600519' | 'sector:801010' | 'portfolio' | 'market'
  kind TEXT NOT NULL,              -- analysis | event | feed | note | skill_memory | backtest
  title TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0
);

-- 检索平面：FTS5（contentless + CJK bigram，承 WeKnora）
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, body, content='', contentless_delete=1, tokenize='unicode61'
);

-- 本体：实体 / 关系 / 提及（承 WeKnora“节点挂 chunk”+ auto-ontology 语义目录）
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- instrument | sector | company | person | event | concept | policy
  scope TEXT,                     -- 主归属 scope（如 stock:600519）
  description TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, type)
);
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id INTEGER NOT NULL REFERENCES entities(id),
  dst_id INTEGER NOT NULL REFERENCES entities(id),
  type TEXT NOT NULL,             -- belongs_to | upstream | downstream | competitor | holder | impact_bull | impact_bear | peer
  weight REAL NOT NULL DEFAULT 1.0,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT,
  UNIQUE(src_id, dst_id, type)
);
CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  doc_id INTEGER NOT NULL REFERENCES docs(id),
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (entity_id, doc_id)
);

-- 预测记录（Skill 回放/实盘预测的每一次输出）
CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  as_of TEXT NOT NULL,            -- 用截至 as_of 的数据
  target_date TEXT NOT NULL,      -- 预测的目标交易日
  direction TEXT NOT NULL,        -- up | down | flat
  expected_move REAL,             -- 预期涨跌幅（小数）
  confidence REAL NOT NULL,       -- 0..1
  rationale TEXT NOT NULL DEFAULT '',
  actual_direction TEXT, actual_move REAL,   -- 兑现后回填
  score REAL,                     -- 打分（方向命中 1/0 + 幅度误差 soft 分）
  mode TEXT NOT NULL DEFAULT 'replay',       -- replay | live
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forecasts_scope ON forecasts(scope, target_date DESC);

-- 回测运行记录
CREATE TABLE IF NOT EXISTS backtests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  skill_version TEXT,
  strategy TEXT NOT NULL,         -- 'skill_signal' | 'ma_cross' | ...
  params TEXT NOT NULL DEFAULT '{}',
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  metrics TEXT NOT NULL,          -- JSON: total_return/annual/sharpe/max_drawdown/win_rate/trades…
  equity TEXT NOT NULL,           -- JSON: [{date, equity}] 净值曲线
  created_at INTEGER NOT NULL
);
```

### 3.2 本地文件夹（文本是 source of truth，承 OpenViking 的“目录带摘要”）

```
<vault>/.bnote/invest/
├── invest.db                  # 上述 SQLite
├── sources.yaml               # 信息源与处理方式配置（用户/Agent 可编辑）
├── sectors.yaml               # 板块骨架（默认内置申万一级，可覆盖）
├── feed/<YYYY-MM-DD>/         # 每日热点沉淀（每源一个 md，frontmatter 带 scope/来源）
├── stocks/<code>/             # 标的文档目录
│   ├── README.md              # 标的卡：名称/行业/一句话/文档目录摘要（agent 先扫这个）
│   ├── analysis.md            # 用户/Agent 的分析结论（时间倒序追加）
│   ├── events.md              # 该标的的事件时间线（摄取管线追加）
│   └── ...
├── sectors/<code>/            # 板块文档目录（README.md / analysis.md / events.md）
├── skills/
│   ├── stock/<code>/          # per 标的 skill（作用域隔离的根）
│   │   ├── SKILL.md           # 策略规则（可验证、带阈值）
│   │   ├── MEMORY.md          # 历史事实/事件日历/已证伪假设
│   │   └── versions/vNNN-*.md # 版本化快照（gate 通过才成为 current）
│   ├── sector/<code>/
│   └── portfolio/<id>/
└── backtests/<id>.md          # 回测报告（人类可读，metrics 落库）
```

## 4. Skill 系统设计（承 SkillOpt）

### 4.1 SKILL.md 格式

```markdown
---
name: 贵州茅台预测技能
scope: stock:600519
version: 3
updated: 2026-11-17
horizon: 5          # 预测 horizon（交易日）
---
# 贵州茅台 走势预测技能

## 市场状态假设
- （当前适用的大盘/板块环境判断）

## 信号 → 方向规则
- 每条必须具体可验证：指标、阈值、方向。例：
  - 当 5 日均线向下且放量(量比>1.2)时 → 未来 5 日看跌，置信度 0.6
  - 当主力资金连续 3 日净流入且板块热度上升时 → 看涨，置信度 0.55

## 仓位与风控
- 止损/仓位建议规则

## 已知失效模式
- （由反思生成：什么情况下这套规则错得最惨）

## 输出契约
- 必须输出 JSON：{"direction":"up|down|flat","expected_move":0.03,"confidence":0.6,"rationale":"…"}

<!-- INVEST:LEARNED START -->
<!-- 预测验证循环追加的规则（gate 通过才写入）；与上文冲突时写显式 OVERRIDE -->
<!-- INVEST:LEARNED END -->
```

### 4.2 MEMORY.md（与 SKILL 平行的第二份可编辑文档）

标的历史事实、事件日历、已证伪假设、跨周期教训。同一套有界编辑 + gate 更新（SkillOpt 的 skill/memory 双文档纪律）。

### 4.3 作用域隔离（用户硬性要求）

- Skill 只在对应作用域可见：`invest_read_skill(scope)` 只接受 `stock:<code>` / `sector:<code>` / `portfolio:<id>`，其它作用域的 skill 目录物理上读不到（路径拼接以 scope 为准，不接受任意路径穿越）。
- agent 的 `Skill` 工具在 invest 模式下只挂当前标的/板块的 skill 根；coding/creative/study 三个 agent 的 mode root 是各自目录，不含 `invest/skills/`，天然不可见。
- 目录命名即权限边界：`skills/stock/`、`skills/sector/`、`skills/portfolio/` 各自独立，agent 工具的白名单里没有跨作用域读取。

### 4.4 验证循环（walk-forward，SkillOpt 没有的部分我们自己加）

1. **回放（replay）**：`invest_forecast_run`。给定 scope + 截止日 T0 + horizon：取截至 T0 的 K 线/资金流/事件/Skill，生成预测（Agent 或规则模板）；实际数据到位后打分。
   - **hard**：方向命中（up/down 正确 = 1；flat 与 |move|<1% = 1）
   - **soft**：`max(0, 1 - |predicted_move - actual_move| / 0.10)`（10% 满分尺度）
   - **score** = 0.7·hard + 0.3·soft（对应 SkillOpt mixed gate）
2. **反思（reflect）**：把错误样本（score 低于阈值的预测）连同当时的数据喂给 Agent，产出**有界编辑**（add/replace/delete，锚点定位，不重写全文；必须具体可验证）。
3. **门控（gate）**：新版本 skill 在**紧随其后的验证窗口**上回放（walk-forward：训练窗 → 验证窗，按时间切分，杜绝未来函数）；score 严格提升才接受为 current，否则进 rejected 记录（留档避免重复无效编辑）。
4. **版本化**：`versions/vNNN-<gate结果>.md`，`invest_skill_revisions` 由 docs 表的 kind=skill_versions 承载 + SKILL.md frontmatter version 自增。

## 5. 信息源 YAML（`sources.yaml`）

```yaml
# 信息源与处理配置。用户手编，Agent 也可通过 invest_save_sources 更新。
version: 1
defaults:
  max_items_per_run: 20
  timeout_secs: 20
sources:
  - id: cls-telegraph          # 财联社电报（示例）
    kind: rss                  # rss | html | json | api（kind 决定抓取器）
    url: https://www.cls.cn/nodeapi/telegraphList
    scope: market              # market | sector:<code> | stock:<code>
    keywords: ["AI", "半导体"]  # 标题过滤（可选）
    handler: extract-and-tag   # 处理方式（见 handlers）
    schedule: daily            # daily | manual
  - id: eastmoney-sector-news
    kind: html
    url: https://finance.eastmoney.com/c/cywjh.html
    scope: sector:801710       # 半导体
    handler: extract-and-tag
handlers:
  extract-and-tag:             # 默认处理链：正文抽取 → 摘要 → 打标签 → 落盘 → 入库
    steps: [extract, summarize, tag, store]
    tag_prompt_ref: prompts/tag.md   # 可自定义的处理提示词（引用文件）
```

- 抓取器实现：`rss`（XML 解析）、`html`（CSS 选择器配置 + 正文抽取，bnote 已有 scraper 依赖）、`json`（字段映射配置）、`api`（预置适配：东财/新浪常用端点）。
- 处理链 steps 可组合：`extract`（正文去噪）、`summarize`（可选，Agent/无 LLM 时截断）、`tag`（事件 kind/sentiment 判定）、`store`（写 `feed/<date>/` + events 表 + docs FTS + 实体抽取）。
- **Agent 参与点**：`tag` 与 `summarize` 步骤若配置了 prompt，则由 agent 会话执行（invest agent 的工具 `run_ingest_handler`）；无模型配置时降级为规则处理（关键词+截断），管线永不因缺模型而失败。

## 6. 回测引擎（承 backtrader 模型）

纯 Rust 实现，无外部依赖：

```
Feed(kline_daily 窗口) → Strategy(逐 bar 产生 Signal{Buy/Sell, size}) 
  → Broker(现金/持仓/撮合[次日开盘价成交/滑点/手续费]) → Equity 曲线
  → Analyzers(总收益/年化/Sharpe/最大回撤/胜率/交易列表)
```

- 策略接口：`fn on_bar(&mut self, ctx: &BarContext) -> Vec<Signal>`。内置两种：
  - `ma_cross`（快慢均线交叉，业界最常用基准策略）
  - `skill_signal`（读取 forecasts 表中该 scope 的已兑现预测，按方向开平仓——Skill 与回测的结合点）
- 撮合约定（A 股惯例）：T 日信号 T+1 开盘成交；手续费万 2.5 + 印花税 0.05%（卖出）；最小 100 股整数手。
- 指标：total_return、annual_return、sharpe（r_free=2%）、max_drawdown、win_rate、profit_factor、trade count。
- 结果：metrics + equity 落 `backtests` 表，报告渲染为 `backtests/<id>.md`。

## 7. Agent 集成

- 新增 `AgentMode::Invest`（`<vault>/.bnote/agents/invest/`），defs.rs 新增 `invest` 定义：工具集 = Read/Write/Edit/LS/Glob/Grep + invest 专属工具（见下）。
- invest 专属工具（注册到现有 agent 工具层，仅 invest 定义可用）：
  - `read_kline(code, from, to)` — 读 K 线窗口
  - `read_instrument_profile(code)` — 快照+财务+板块归属
  - `search_events(scope, days)` — 事件流检索
  - `search_knowledge(query)` — FTS + 图一跳检索（本体查询）
  - `read_skill(scope)` / `write_skill_section(scope, anchor, content)` — Skill 读写（作用域锁定当前标的）
  - `run_backtest(scope, strategy, params)` — 回测
  - `list_scope_docs(scope)` — OpenViking 式“先扫摘要”：返回文档目录 + README 摘要
- SYSTEM_PROMPT：投资分析助手（数据驱动、给出方向+置信度+理由、引用事件与知识、承认不确定性）。
- AgentPanel 复用：invest 模式下 `mode="invest"`，session 作用域目录 `.bnote/agents/invest/`，material 语义映射到 `stocks/<code>/`（会话记录存 `.bnote/invest/stocks/<code>/sessions/`）。

## 8. 快捷键

| 键 | 命令 | 区域 |
|---|---|---|
| ⌘⌥I | `view.toggle-invest-mode` 进入/退出投资模式 | global |
| ⌘⌥→ / ⌘⌥← | `invest.next/prev-instrument` 切换标的 | invest（聚焦中栏时）+ reading 区 |
| ⌘⌥↓ / ⌘⌥↑ | `invest.next/prev-doc` 标的文档 Tab 切换 | invest |
| ⌘⌥S | `invest.toggle-sector-view` 标的/板块视图切换 | invest |
| ⌘1 / ⌘2 / ⌘3 | `invest.kline-period-day/week/month` 日/周/月 K 切换 | invest |
| ⌘⌥R | `invest.focus-market` 中栏切回行情(K 线 + 详情) | invest |

新增 `KeyRegion "invest"`（K 线/详情/列表面板聚焦时生效），继承 notes 编辑键的机制不适用（右栏就是 notes 区本身），只放 invest 专属命令 + 全局命令。

## 9. 数据获取（本地优先，无外部服务依赖）

1. **导入路径（主）**：`invest_import_data`（JSON/CSV：标的列表、日 K、财务、板块），格式与 akshare 导出对齐（`scripts/invest-akshare-export.py` 提供生成脚本，用户本地跑 akshare 后导入）；支持增量。
2. **直连路径（辅）**：Rust reqwest 直抓公开 HTTP 端点（腾讯 `qt.gtimg.cn` 快照、新浪 K 线/资金流），无需 Python 服务；失败静默降级到本地数据。
3. **摄取路径（热点）**：第 5 节管线。

## 10. 前端结构

```
src/invest/
├── types.ts            # 与后端对齐的全部类型
├── store.ts            # Zustand：视图状态/当前标的/列表/文档 Tab/加载态（单写者）
├── klineModel.ts       # K 线纯逻辑：数据映射/周期合成(周月)/可见窗口/指标(MA/MACD)
├── instrumentFiles.ts  # scope ↔ 文档目录映射、文档 Tab 模型、README 摘要
├── sectors.ts          # 申万分类常量 + 板块辅助
├── skillModel.ts       # SKILL/MEMORY frontmatter 解析、版本号、受保护区块
├── sourcesConfig.ts    # sources.yaml 的 TS 侧解析/校验/序列化
├── forecastModel.ts    # 预测打分（hard/soft/score）纯逻辑
└── backtestModel.ts    # 回测参数/指标类型与展示数据整形
src/components/invest/
├── InvestLayout.tsx    # 三栏两级嵌套（复用 splitDrag）
├── InstrumentList.tsx  # 左栏（自选/全部/搜索/板块切换）
├── KlinePane.tsx       # klinecharts 封装
├── DetailTabs.tsx      # 下半详情 Tab（行情/资讯/资金流/简况/财务/事件/知识）
├── DocTabs.tsx         # 右栏顶部文档 Tab 组
└── (Sector 复用同一组组件，scope 换成 sector:<code>)
```

状态纪律（AGENTS.md）：store 单写者；K 线数据请求带 generation 防竞态（承 study/pdfRenderQueue 模式）；异步回调写回前校验当前标的。

## 11. 测试与验收

- 纯逻辑单测：klineModel（周期合成/指标/可见窗口）、skillModel（解析/版本/区块）、forecastModel（打分）、sourcesConfig（解析校验）、sectors（映射）。
- 集成测试（fake IPC）：store 流程（进模式→选标的→切换→文档 Tab→摄取→事件入流）。
- Rust 单测：db 迁移幂等、kline 区间查询、YAML 解析、ingest 处理链（本地 fixture）、skill 作用域隔离（越权路径拒绝）、forecast 打分、backtest 指标（已知数据集对拍）、FTS 检索、图谱一跳。
- 浏览器验收（devbridge/harness）：进入模式、三栏布局、切换标的、K 线交互、文档切换、Agent 面板、板块视图、导入数据、摄取冒烟、回测冒烟。

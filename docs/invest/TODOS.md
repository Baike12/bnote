# 投资模式（Invest Mode）实施待办

> 状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成
> 本文档是投资模式的唯一进度台账；每完成一项立即勾选并附证据（文件 / 测试）。
> 用户故事与验收口径见 `docs/invest/DESIGN.md`。

## 0. 调研与参考

- [x] 理解 bnote 现有架构（App.tsx 启动顺序 / appStore mode / commands 区域键位 / agent 三模式 / devbridge）
- [x] 调研 hoshi：三栏布局、标的字段、K 线交互、详情信息面清单、SQLite 表结构（klinecharts 9.8.12 同款、qt.gtimg.cn 快照字段索引沿用其结论）
- [x] 调研 SkillOpt：skill 文件格式、组织方式、优化循环、记忆结合（SKILL.md + MEMORY.md 双文档 + LEARNED 受保护区块 + 版本化）
- [x] 调研 WeKnora：知识库数据模型、摄取管线、混合检索（FTS5 + CJK bigram 方案落地 docs.rs）
- [x] 拉取 NVIDIA AutoOntology 到本地（参考本体构建方式）
- [x] 拉取 ByteDance OpenViking 到本地（参考资料整理/上下文资源方式）
- [x] 参考 backtrader（本地已有）确定回测引擎模型（事件驱动 / broker / feed → invest/backtest.rs）
- [x] 参考 akshare（本地已有）确定 A 股数据获取方式与字段（导入命令 + 快照抓取）

## 1. 设计

- [x] `docs/invest/DESIGN.md`：总体架构图、目录布局、数据流
- [x] SQLite schema：标的、K 线、详情、板块、事件、文档、实体、关系、回测、预测记录（invest/db.rs SCHEMA）
- [x] 本地文件夹布局：`<vault>/.bnote/invest/`（YAML 配置、Markdown 文档、Skill、会话）
- [x] Skill 文件格式（frontmatter + 正文）：per 标的 / per 板块 / 组合，作用域隔离
- [x] 信息源 YAML 配置格式（sources + handler/keywords/selector）
- [x] 回测引擎模型（feed / broker / strategy / metrics）

## 2. Rust 后端（src-tauri/src/invest/）

- [x] `invest/mod.rs` + `invest/db.rs`：共享连接（AppState 持有 Arc<Mutex<Option<Connection>>>，invest::db::with_conn 单一锁缝），迁移建表
- [x] `invest/model.rs`：标的 / K 线 / 板块 / 事件 / 文档 / 实体 / 关系的数据结构
- [x] `invest/kline.rs`：K 线存储、区间查询、周期合成（日/周/月，Hinnant civil 算法 + ISO week）
- [x] `invest/instruments.rs`：标的列表、详情读写、标的搜索
- [x] `invest/sectors.rs`：板块定义（申万一级行业 2021 版 31 个内置 seed）、板块行情
- [x] `invest/docs.rs`：Markdown 文档的落盘 + 索引（FTS5 contentless + CJK bigram）
- [x] `invest/ontology.rs`：实体 / 关系抽取结果存储与查询（知识图谱一跳视图 + 知识库检索）
- [x] `invest/ingest.rs`：YAML 配置解析 + 信息源抓取（rss/json/html 三类）+ 处理管线（抽正文 → 摘要 → 打标 → 落盘 feed/ → 入库 → dedup）
- [x] `invest/skill.rs`：Skill 读取 / 保存（版本化快照）/ LEARNED 有界编辑 / 作用域（拒绝路径穿越）
- [x] `invest/backtest.rs`：事件驱动回测引擎（信号 → T+1 开盘撮合 → 持仓 → 净值 → Sharpe/回撤/胜率/盈亏比）
- [x] `invest/forecast.rs`：预测回放（动量+量比规则基线）、实际走势对比、hard/soft/score 打分
- [x] 极简 YAML 解析（内嵌 ingest.rs `parse_sources`，无 serde_yaml 依赖）
- [x] `commands/invest.rs`：#[tauri::command] 表面（32 个）+ devbridge.rs 注册 + lib.rs generate_handler
- [x] Cargo.toml 引入 rusqlite 0.37（bundled）+ 测试
- [x] cargo test --lib invest 全绿（416 passed）+ cargo fmt

## 3. 前端 invest 域（src/invest/）

- [x] `src/invest/types.ts`：与后端 CmdResult 对齐的类型（snake_case 透传）
- [x] `src/invest/store.ts`：Zustand store（当前 scope、列表、generation 防竞态、文档 tab、busy/toast）
- [x] 标的 ↔ 文档目录映射与 scope 地址模型：收敛进 `layoutModel.ts`（scopeFor/parseScope/scopeDocDir，单一构造者；原计划的 instrumentFiles.ts 不再单独成文件）
- [x] K 线渲染采用 klinecharts 9.8.12（hoshi 同款）：视口/缩放/十字光标/MA/VOL/MACD 由库承担，自绘 chart.ts 不适用
- [x] 板块分类常量：由 Rust 侧 db seed 承担（31 个申万一级），前端不做第二份常量
- [x] 回测/预测/Skill/摄取配置模型：在 Rust 侧实现并测试（前端只消费结果），前端不重复建模

## 4. 前端 UI（src/components/invest/）

- [x] `InvestLayout.tsx`：三栏（左标的/板块面板、中 K 线+详情 或 Agent、右笔记），splitDrag 拖拽调宽，`data-key-region="invest"`，挂载即认领区域
- [x] `InstrumentList.tsx`：A 股标的列表（搜索、自选星标）**并承担板块视图**（原计划的 SectorList.tsx 合并进来，一个列表组件两个视图）
- [x] `KlinePane.tsx`：klinecharts K 线（OHLCV、MA/VOL/MACD、周期切换、红涨绿跌、手数显示）
- [x] `DetailTabs.tsx`：标的详情（快照、资金流、财务、事件、知识、预测、回测 7 tab）**并承担板块详情裁剪**（原计划的 InstrumentDetail/SectorDetail 合并，板块只留事件/知识/预测）
- [x] 右栏笔记：复用 EditorPane + `DocTabs.tsx`（scope 文档 tab 组；原计划的 InvestNotes.tsx 由 DocTabs + 全局 currentFile 组成）
- [x] `AgentPanel` 复用：invest 模式上下文注入（scope → material 语义 → 会话落 `.bnote/invest/<dir>/`，read_skill 绑定会话 scope）
- [x] 样式：global.css 增加 `.invest-*`（沿用设计 token，无裸色值，theme.test 锁定）

## 5. 模式与快捷键接线

- [x] `AppMode` 增加 `"invest"`；`App.tsx` 渲染分支 `InvestLayout`
- [x] `view.toggle-invest-mode` 命令注册（builtin.ts）+ 默认键位 **⌘⌥I**（keys.ts；⌘⇧I 与笔记区 toggle-italic 冲突，改道 ⌘⌥I，DESIGN.md 已同步）
- [x] invest 区域（KeyRegion `"invest"`）注册：标的列表 / K 线 / 详情面板生效
- [x] 标的切换命令：`invest.next-instrument` / `invest.prev-instrument`（⌘⌥←/→）
- [x] 周期切换（⌘1/2/3）、⌘⌥R 行情焦点、⌘⌥S 板块↔标的视图、⌘⌥↓/↑ 文档 tab
- [x] keybindings 文档表再生成（`pnpm docs:keybindings`）
- [x] 设置页快捷键区显示 invest 区域（keybindingsDoc REGION_SCOPE + AgentTabs/SettingsModal）

## 6. Agent 集成

- [x] 后端 `AgentMode::Invest`（home.rs）+ `defs.rs` invest 定义（工具集、SYSTEM_PROMPT）
- [x] `resources/agents/invest/SYSTEM_PROMPT.md`：投资分析 agent 提示词（上下文路径、分析纪律、JSON 输出契约）
- [x] AgentPanel 支持 invest 上下文（scope → material 语义 → 会话与标注按标的隔离）
- [x] invest 工具：`read_skill` 注册到 agent 工具层（从会话 ToolContext.invest_scope 取作用域，无 scope 参数）；行情/文档读取复用既有 Read/LS/Glob/Grep/WebFetch 工具（标的上下文由 SYSTEM_PROMPT 给出路径约定）
- [x] Skill 作用域隔离验证：scope 字符串解析 + skill_dir 拒绝路径穿越 + read_skill 无 scope 参数（会话绑定）+ 其他 mode 的 skills roots 不含 invest（agent/skills.rs roots_for）

## 7. 数据与信息管线

- [x] 板块分类默认数据（申万一级行业 2021 版 31 个，代码 801010–801980 内置 seed）
- [x] K 线数据导入：`invest_import_data`（JSON：bars/snapshot/fund_flow/financials/instruments 离线优先）+ README 附 akshare 导出说明
- [x] 信息源默认 YAML（首次运行落 `<vault>/.bnote/invest/sources.yaml` 示例模板：rss/json/html 各一）
- [x] 摄取管线命令：`invest_ingest_run`（抓取 → 处理 → 落盘 feed/<date>/ → 入库 → 打标；FNV-1a dedup）
- [x] 处理方式可配置：YAML `handler`（rss/json/html 三类 + selector）+ `keywords` 过滤 + 情绪打标（tag_text）
- [x] 每日热点文档沉淀路径约定：`<vault>/.bnote/invest/feed/<date>/<source>.md`

## 8. 本体（知识库 + 知识图谱）

- [x] SQLite FTS5 文档索引 + 查询命令（`invest_search_knowledge`，bigram 短语匹配）
- [x] 实体表（标的/板块/公司/人物/事件类型）+ 关系表（利好/利空/上下游/持股/竞争，weight）
- [x] 图谱检索：`invest_graph_view`（一跳邻域）+ 实体文档反查 `invest_ontology_docs`（原计划的 invest_ontology_query 拆成这两个面）
- [x] 参照 AutoOntology 的本体模式（schema 约定）写入 DESIGN.md 并落地 schema
- [x] 参照 OpenViking 的资源组织（URI/分层）约定文档目录结构（README 卡 → analysis/events → skills）

## 9. Skill 与预测验证循环

- [x] Skill 目录：`<vault>/.bnote/invest/skills/<kind>/<code>/SKILL.md` + `MEMORY.md` + `versions/vNNN-*.md`
- [x] Skill 作用域：`stock:<code>` / `sector:<code>`（portfolio 预留在 scope 语法中）；skill_dir 拒绝路径穿越，非本作用域不可加载
- [x] `invest_forecast_replay`：给定 scope + 截止日，用截止日前数据回放预测，输出预测记录（rule_forecast 基线规则）
- [x] 预测记录入库 + 打分（hard 方向 / soft 幅度 / score=0.7·hard+0.3·soft；accuracy 汇总）
- [x] Skill 迭代：agent 通过 Edit 工具有界编辑（LEARNED 区块锚点替换/追加），write 时自动落版本快照（原计划的独立 invest_skill_revise 命令由「Edit 工具 + 版本化 write」承担）
- [x] 回测引擎与 skill 结合：`skill_signal` 策略（读 SKILL.md 规则 → 信号）与 `ma_cross` 基线并列

## 10. 测试

- [x] 纯逻辑单测：kline 周期合成/ISO week、skill 版本与 LEARNED 编辑、bigram、回测指标、预测打分、scope 解析（Rust 侧 invest 各模块 tests + 前端 layoutModel.test.ts 14 例）
- [x] 集成测试：fake IPC 边界（store.integration.test.ts 21 例：加载 → 选 scope → generation 防竞态 → 切换 → 文档 → 回测/预测/摄取）
- [x] Rust 单测：db 迁移、K 线区间查询、YAML 解析、回测引擎、预测回放、FTS、图谱查询（cargo test --lib 416 全过）
- [x] coverage 阈值条目 `src/invest/**`（vitest.config.ts：实测基线 89.1/76.2/91.7/91.3 减 2 点）
- [x] perf：K 线渲染数据准备 O(可视柱数)——不适用（klinecharts 内部渲染，自研热路径不存在）；store 读取为限量查询（limit 500）
- [x] `pnpm gate` 全绿（236 文件 3314 测试）
- [x] `cargo test --lib` 全绿 + `cargo fmt --check`

## 11. 端到端验证

- [x] `pnpm tauri dev` + browseros 打开 localhost:1430 验证：进入投资模式 → 板块列表（31）→ 点击选 scope → K 线面板 → 文档 tab → Agent 面板 → 标的/板块视图切换（browseros 会话 zcode/invest-mode-e2e）
- [x] 快捷键验证：⌘⌥I 进入/退出；⌘⌥→/← 连续切换标的/板块；⌘⌥S 视图切换；⌘⌥↓ 文档 tab；⌘⌥R 行情焦点；⌘2 周期（CDP 派发；⌘数字在 Chrome 是保留键只能 CDP 注入，Tauri 原生窗口无此限制）
- [x] 摄取管线冒烟：无网络环境跑默认模板源 → 「摄取完成: 新增 0 条, 1 个源失败(检查 sources.yaml)」toast 契约正确
- [x] 回测引擎冒烟：cargo 测试锁定（ma_cross 30 平+30 涨+30 跑出金叉交易、skill_signal 净值增长、T+1 撮合与手续费）；浏览器无本地历史数据，端到端回测展示留待用户导入数据后验证
- [x] 关闭本会话打开的标签页（615/616 已关闭）并停止会话启动的 dev server
- [x] 验证中发现并修复的真 bug：全局键 focusin 认领使程序性焦点（每次 openFile 重建 CodeMirror）夺走键盘所有权，导致切换标的的第二个 ⌘⌥→ 失效——focusin 从认领者中移除（focus() 触发的 focusin 是 trusted，isTrusted 不可区分），回归测试 globalKeys.integration.test.ts「a focusin never steals the ownership」锁定

## 12. 文档收尾

- [x] `docs/invest/DESIGN.md` 完成（架构、schema、skill 格式、数据流；快捷键表同步 ⌘⌥I）
- [x] README / README.zh-CN 增加投资模式一段
- [x] keybindings 文档表更新（`pnpm docs:keybindings` 重新生成 docs/keybindings.md）
- [x] 收尾审计：对照本清单逐项确认完成，不留 TODO 断言

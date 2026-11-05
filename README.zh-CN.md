<p align="center">
  <img src="./app-icon.png" width="104" alt="bnote app icon" />
</p>

<h1 align="center">bnote</h1>

<p align="center">
  面向 macOS 的本地优先 Markdown 笔记应用。<br />
  <strong>Tauri 2 · React 19 · CodeMirror 6 · Rust</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="CodeMirror 6" src="https://img.shields.io/badge/CodeMirror-6-B873F6?style=flat-square" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111111" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust&logoColor=white" />
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat-square" />
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/Baike12/bnote?style=flat-square&logo=github" />
  <img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/Baike12/bnote?style=flat-square" />
</p>

> **bnote** 把「笔记 + 论文/网页阅读 + 代码仓库 + 编码 Agent」放进同一个窗口。仓库就是磁盘上的普通文件夹，笔记就是普通 Markdown：可以用 Git 管理、用任何编辑器打开、随时带走。常用能力原生内置，不依赖插件生态，也没有 Electron。

---

## 核心特性

| 领域 | 能力 |
| --- | --- |
| **本地优先** | Vault 是普通文件夹，笔记是普通 Markdown；可被 Git、iCloud、Dropbox 或任意编辑器直接读写。 |
| **四种模式** | 笔记 / 学习 / 代码 / 项目，互斥的全屏模式，各自有独立的布局、键位区域与宽度偏好。 |
| **实时渲染** | 光标所在行保留源码，其余区域按 Obsidian 风格渲染；只处理可视区域，长文档仍然流畅。 |
| **公式与片段** | KaTeX 行内/块级公式；220+ 内置 LaTeX 快捷片段，支持占位符、正则捕获、视觉模式包裹与仓库级自定义。 |
| **Vim 与输入法** | 原生 Vim 模式与 vimrc 映射；macOS 下随 insert/normal 自动切换输入法，公式与代码块保持英文。 |
| **区域化快捷键** | 同一个键在「通用 / 笔记区 / 阅读区 / Agent 面板 / 代码区 / 项目区」绑不同命令；全部命令可搜索、改键、解绑。 |
| **学习模式** | 三栏：左问 agent、中读 PDF / 网页 / 微信读书、右记笔记；批注、阅读位置、历史按材料持久化。 |
| **选中翻译** | 单词查内置 ECDICT（59k 条目，离线）；句子走可配置的模型 API（OpenAI 兼容 / DeepSeek / GLM / Qwen / Anthropic / Ollama）。 |
| **代码模式** | 独立的三栏（agent \| 代码 \| 笔记）：文件树、tree-sitter 高亮、LSP 跳转与补全、git 差异、集成终端。 |
| **编码 Agent** | 工具、权限、计划模式、hooks、输出风格、自动记忆、提示词历史按 Claude Code 的结构实现；运行时落在 `~/.bnote`。 |
| **项目管理** | 每个项目是一份 Markdown 待办清单，看板横向排列，待办可拖动、可直接发送到今日日记。 |
| **日记与待办** | 跨文件待办双向同步到今日日记；未发送的完成项自动记录；当天改动汇总为「今日足迹」。 |
| **画布与附件** | Excalidraw 画布以文件保存并导出预览图，回到笔记自动插入；兼容 Obsidian `.excalidraw.md`。 |
| **Python** | 一篇笔记的全部 python 块当作一个 `.py` 运行，流式输出、可中止；ty 类型检查与 uv 环境管理。 |
| **专注模式** | 番茄钟 + 伪全屏 + 硬锁：时间未到不能退出、不能切应用，重启后继续计时。 |

## 快速开始

```bash
git clone https://github.com/Baike12/bnote.git
cd bnote
pnpm install
pnpm tauri dev
```

首次启动后选择一个 Vault 文件夹即可开始使用；代码模式不需要 vault，直接选一个仓库。

### 环境要求

- macOS
- Node.js 20+
- pnpm
- Rust stable
- Xcode Command Line Tools

可选：`uv`（Python 环境）、`ty`（Python 类型检查）、Ollama 或其他模型服务（句子翻译 / Agent）。

### 构建

```bash
pnpm tauri build
```

产物为 `.app` / `.dmg`，由 Tauri 生成。

### 测试与检查

```bash
pnpm gate                                            # lint + typecheck + 格式检查 + 单元测试
cargo test --workspace --manifest-path src-tauri/Cargo.toml   # Rust 测试(应用 + pdf2md)
cargo check --workspace --manifest-path src-tauri/Cargo.toml  # Rust 编译检查
cargo fmt --manifest-path src-tauri/Cargo.toml --check        # Rust 格式检查
```

PDF 转换器的夹具与质量门禁在 `tests/data/pdfs/`（`src-tauri/crates/pdf2md/tests/quality_gate.rs`）。

## 四种模式

| 模式 | 布局 | 进入方式 |
| --- | --- | --- |
| **笔记** | 侧栏 + 编辑器 | 默认 |
| **学习** | Agent \| 内容栏 \| 笔记 | `Cmd+Shift+S` |
| **代码** | Agent \| 代码项目 \| 笔记 | 命令面板（默认不绑键，见下） |
| **项目** | 项目列表 \| 看板 \| 日记 | `Cmd+Shift+P` |

- 四种模式同时只有一种生效；切换模式不会重建 CodeMirror 实例，滚动位置、折叠状态、装饰都保留。
- 学习模式和代码模式是三栏结构，两条分隔条可拖动，前两栏宽度按像素持久化（分别存在 `studyAgentWidth` / `studyContentWidth` 与 `codeAgentWidth` / `codeContentWidth`），第三栏吃掉剩余宽度；窗口变窄时 CSS 收窄前两栏，不改写你的偏好。
- **代码模式默认没有快捷键**：`Cmd+Shift+C` 是「插入代码块」。需要快捷键的话，在 `keybindings.json` 的 `global` 段把 `view.toggle-code-mode` 绑到任意键上。

## 编辑器

### 实时渲染

与 Obsidian 一致：光标所在行保持源码，其余区域直接渲染（`src/editor/livePreview.ts`）。

- 标题、粗体、斜体、删除线、引用块、Callout、分割线、列表、转义符、行内代码与围栏代码块
- 代码块按语言高亮，语言包按需加载
- 行内公式 `$...$` 与公式块 `$$...$$` 用 KaTeX 渲染；编辑公式时保留源码，公式块还在下方实时预览（行内公式编辑时源码后面紧跟一份渲染副本，光标离开即只留渲染）
- 任务列表 `- [ ]` / `- [x]` 可直接点击；完成后写入 `✅ 日期`，再次点击可取消
- Callout 用 `:::` 围栏书写，标题栏出现在渲染块上；`Cmd+Shift+B` 无选区时插入空块 / 跳转 / 回跳，有选区时把选区放到标题块下，并以标题文本为锚点在原文与块之间跳转
- `[[target|alias]]` 内部链接可点击跳转；外部链接交给系统浏览器
- `![alt](path)` 与 `![[image.png]]` 按「相对路径 → Vault 根目录 → 文件名」逐级解析，只渲染视口内的行
- Excalidraw 嵌入显示自动导出的 PNG，点击回到画布继续编辑
- 重新打开笔记时恢复上次的光标与滚动位置

### 公式与 LaTeX 片段

- 内置 220+ 片段：`Tab` 展开、输入即展开、占位符镜像、正则捕获、Visual 模式包裹、正文/公式/代码上下文识别
- 括号自动放大、矩阵快捷键、Tabout、括号配对高亮、双美元符删除、片段空白清理
- Vault 中存在 `.bnote/snippets.js` 时**完全取代**内置片段；保存后热加载，加载失败会在界面里给出原因
- 设置中可以逐项开关 LaTeX Suite 行为，无需重启

### Vim 与输入法

- `normal` / `insert` / `visual` 三种模式；支持 `map`、`noremap`、`nnoremap`、`imap`、`vmap` 等常见 vimrc 映射与 `jj` 键序列
- `:w`、`:wq`、`:x`、`:q`、`:noh` 等命令可用；`:Bnote <命令 id>` 可把任意 bnote 命令映射成 Vim 键
- `o` / `O` 新建行保留缩进；视觉模式、跳转列表、剪贴板与像素级垂直运动均为原生实现
- macOS 下可配置 insert / normal 使用的输入法：进入 insert 切中文，回到 normal / visual 切英文；光标在公式或代码块内时保持英文
- 输入法切换走进程内 Carbon TIS（毫秒级、后台线程，已是目标输入源时直接跳过），并限定在 bnote 内：窗口失焦恢复原输入源，重新聚焦再套用
- 仓库级映射写在 `.bnote/vimrc`，全局映射写在应用数据目录的 `vimrc`

### 命令、导航与工作区

- **命令面板**：模糊搜索全部命令；新增功能只需注册一个 `CommandDef`（`src/commands/registry.ts`）
- **快速跳转**：按文件名或文件夹名搜索，空格分隔多词按 AND 匹配；空输入显示最近打开列表
- **插入链接**：光标处补全笔记；当前行已有链接时，同一个快捷键改为跳转；重名笔记自动写成 Vault 相对路径
- **链接回跳**：沿内部链接的跳转历史逐层返回，不影响普通文件打开
- **快速添加**：预设「名称 + 目标文件夹」命令，一键创建笔记；不存在的子目录与重名文件自动处理
- **快速待办**：一个输入框，Enter 把待办放进今日日记待办区最前，不切换当前笔记
- **标题操作**：循环正文 → H1 → H2 → H3 → H4；`Cmd+1..6` 直接设置层级，可自动生成 `1 / 1.1 / 1.1.2` 编号
- **快捷键自定义**：按区域搜索、筛选、录入、解绑、恢复默认；冲突自动移除旧绑定，一个命令可绑定多个键
- **文件管理**：一次平铺遍历建立文件/目录/资产索引（`list_files`），展开状态只影响可见行；支持新建、重命名、删除、右键菜单与最近仓库切换
- **写作体验**：打字机模式、编辑区字号调节、停止输入后自动保存、深浅主题

## 学习模式

学习模式是**三栏**：**Agent（左）+ 内容（中）+ 笔记（右）**。两条分隔条都可拖动，宽度按像素持久化；三栏常驻挂载，切换材料、翻页都不重建编辑器。左栏默认是学习助手，`Cmd+Shift+G` 切到创作模式。

### PDF

- 导入的 PDF 复制进材料目录 `.bnote/materials/pdfs/<拼音目录>/`，与批注、会话放在一起；不做 Markdown 转换
- pdf.js 渲染，支持书签大纲、缩放、文本选择、护眼底色
- **批注**：亮黄色高亮 + 亮蓝色文字批注，整页比例坐标存盘 —— 缩放、裁剪、DPR 变化都不影响位置；右侧留白区展示批注内容
- **阅读位置**：记录「第几页 + 页内偏移」，重排后仍从同一处继续读
- **截图入助手**：截取当前可见页面（canvas 合成，无需系统截图权限），直接作为附件进入助手输入框
- 历史下拉里所有打开过的 PDF 可一键回到

### 网页与微信读书

- 网页在**原生子 webview**中打开，不是 iframe：`X-Frame-Options` / CSP `frame-ancestors` 都拦不住；滚动、尺寸随内容栏同步
- **批注**：高亮与文字批注按「原文片段 + 前后 40 字上下文 + 偏移」定位，广告和懒加载不会让批注错位；按网址存进 `.bnote/web-annotations/<host>-<hash>.json`，页面内另有 localStorage 兜底
- **阅读位置**：网页记录可滚动高度的比例，重开回到同一段文字
- **按步长翻页**：`PageUp` / `PageDown` 按设置的比例滚动，并对齐到文字行；页面上半屏有渐变提示
- **页面缩放**：顶部 `− / 读数 / +` 控件，或 `Cmd+=` / `Cmd+-` / `Cmd+0`；浏览器级缩放，文字重排、整页一起放大（50%–300%）
- **微信读书适配**：铺满阅读区、目录左停靠常驻；SPA 路由变化会被追踪，最近读的书进入历史

### 选中翻译

- **单词**（恰好一个英文 token）：只查内置 ECDICT 词典，59,137 条常用词，压缩后约 1.5 MB 编译进二进制，首次查询一次性解压到内存，不落盘
- **句子/短语**（两个及以上 token）：走设置中配置的模型 API；单词未收录时**不会**回落到模型，而是提示选中更多词
- 支持协议：OpenAI 兼容、DeepSeek、GLM、Qwen、Anthropic、Ollama（默认 `http://127.0.0.1:11434`，请求 `/api/chat`）
- 思考模式按协议发送 `think` / `thinking.type` / `enable_thinking`；默认关闭，避免模型只返回思考内容
- API Key 与请求都留在 Rust 侧（`translate.json`），网页拿不到密钥；网页预览里句子请求 600 ms 节流
- 设置页有「测试连接」，用未保存的表单值发一条固定句子
- Ollama 等本地服务由你自己启动，bnote 只做 HTTP 调用，不会拉起进程

### 学习助手与创作模式

- 学习助手是**纯问答**：不注册工具，围绕当前 PDF / 网页回答；支持 Anthropic Messages 与 OpenAI 兼容协议，SSE 流式回复
- **按材料保存会话**：一份 PDF / 一个网址的会话落在该材料的 `sessions/<会话>.jsonl`，首行是元数据（标题 + 模型配置快照）；切换材料自动切回它的会话
- 支持从任意一条消息**分叉**出辅助会话、主/辅会话来回切换、历史会话抽屉
- 页脚显示上下文占用（最近一次请求的 input + output，对照设置的上下文窗口）
- 支持粘贴截图、选择图片作为消息附件
- **创作模式**（`Cmd+Shift+G`）：同一个面板换成创作助手定义，带读写文件、bash、技能、MCP 与 HTML 预览工具，产出文章或 HTML 并在面板里实时预览
- 自定义指令写在 Vault 的 `.bnote/AGENTS.md`（旧的 `.bnote/agent.md` 仍会被读取）

## 代码模式

代码模式是**独立的一种模式**，与 vault 无关：左边问 agent、中间写代码、右边照旧记笔记，三栏宽度单独持久化。

### 文件树与编辑器

- **文件树**：后端扫一遍（尊重 `.gitignore`），前端折成树；展开目录不再碰磁盘。git 状态用字母标在文件右边（M/A/D/?/R），语言图标按扩展名给
- **语法高亮**：TypeScript / Rust / Go / Python 用专门的 tree-sitter 语法包（增量解析），其余语言退回通用集合；语法包按需动态载入
- **图片**：位图走 asset 协议直接渲染，SVG 仍按文本打开
- **文件树操作**：`Cmd+Shift+E` 聚焦文件树（展开到当前文件，`↑↓` / `→←` / `Enter` / `Esc`），`Cmd+B` 显示 / 隐藏，宽度可拖

### 语言服务器

- 按语言起一个 LSP 进程，走标准 `Content-Length` 帧 JSON-RPC。内置默认覆盖 ts / rust / go / python；可在设置里改启动命令，也可在项目内放 `.bnote/lsp.json` 再盖一层（跟着仓库走，团队共享）
- **跳转与提示**：跳转到定义（F12）/ 类型定义（`Cmd+F12`）/ 实现 / 引用（`Shift+F12`）/ 重命名（F2）、悬停签名、代码提示（`Ctrl+Space`）、工作区符号
- 补全在 `.` / `::` 之后自动触发；`F8` / `Shift+F8` 在当前问题列表中前后跳
- Python 项目自动注入 venv 的 `VIRTUAL_ENV` 与 `PATH`

### git 与终端

- **git**：状态、暂存/取消暂存、差异视图（统一 / 并排两种看法，并排按最长公共子序列配对，改过的那一行左右对齐）
- **集成终端**：Rust 侧 `portable-pty` + 前端 xterm，全宽多标签抽屉，`Ctrl+\`` 开关；会话只重挂不重建，抽屉拖高只写 CSS 变量

### 编码 Agent

- 中栏打开仓库后，左栏 agent 自动切到 coding 定义：会话以仓库根为 workdir（相对路径与 bash 都锚在这里），tasks / 历史 / 记忆都记在这个项目名下
- 工具全开：读写文件、glob / grep、bash（可后台、可 kill）、todo、子代理派发、技能、MCP、计划模式、向用户提问
- 项目根就是沙箱边界：项目根内可读写、根外一律拒绝（相对路径会做词法规范化再 canonicalize，符号链接指向根外也挡得住）
- 会话记录写在 `~/.bnote/projects/<项目键>/<会话>.jsonl`，Vault 里不会出现代码项目的材料目录

## 项目管理

- 布局：**项目列表 | 看板 | 日记**，两侧分隔条可拖
- 一个项目 = `<vault>/.bnote/projects/<项目名>.md` 里的一份待办清单；用 Markdown 是为了能用 Vim 改、能被勾选、能被跨文件待办同步认领
- 看板是真多列：当前列居中且可编辑（CodeMirror，支持 Vim），其余列是纯 DOM 预览，点一下切过去；切换项目只换文档，不重建编辑器
- 待办可在列间拖动（带着子待办一起走）；列头显示项目名与未完成数量
- 新建 / 删除：`Cmd+Shift+N` 新建，`Cmd+Backspace` 移到废纸篓（只在项目区生效），右键与列头 `⋯` 菜单同款操作
- `Cmd+Shift+J` 把当前待办插到今日日记待办区**最前**（笔记区同一个键是加到末尾）

## 日记、待办与今日足迹

- 任意笔记里的待办可发送到今日日记（默认 `Daily/YYYY-MM-DD.md`，目录与文件自动创建）
- 发送后两侧持续同步：完成状态、子待办增删改都会双向镜像；日记里已有同文条目会直接认领，避免重复
- 未显式发送的待办在勾选后也会记录到当天日记，取消完成时自动清理
- 日记末尾提供「今日足迹」：按源文件汇总当天新增或修改的非待办内容，点击可跳回原文
- 新建日记时，上一篇日记里未完成的待办会跟随过来
- 待办映射保存在 `.bnote/daily-links.json`，足迹基线保存在 `.bnote/daily-footprints.json`

## 画布、附件与 Python

### 画布与附件

- 通过命令面板打开 Excalidraw 画布；画布有独立键位，切换文件时先保存收尾
- 新建画布保存为 `<name>.excalidraw`，同时导出同名 PNG 供 Markdown 预览
- 兼容 Obsidian Excalidraw 插件的 `.excalidraw.md`（含 `compressed-json`）
- 回到来源笔记时，新画布以 `![[...]]` 插入原光标位置
- 图片、PDF 等媒体文件进入 Vault 资产索引，供 Markdown 引用解析

### Python

- 一篇笔记中所有 `python` 围栏代码块按行号对齐，组合成一个虚拟 `.py` 文件运行
- `Cmd+Enter` 运行当前笔记；stdout/stderr 流式进入底部面板，可停止，显示退出码与耗时；单次运行 300 秒超时
- 基于 `ty` 的补全、Hover 与诊断，可在命令面板开关
- 可为当前项目创建或同步 `uv` 环境（`uv init --bare` + `uv sync`），日志复用运行面板

## Agent

Agent 按 Claude Code 的结构实现：定义与提示词编译进二进制。每种模式拥有自己的配置——默认在 `<仓库>/.bnote/agents/<模式>/{settings.json, AGENTS.md, skills/, output-styles/}`，跟着笔记仓库走；会话记录等运行状态仍在 `~/.bnote`。

### 三种模式、三套范围

| 模式 | 模型 | MCP | 技能 | 指令 |
| --- | --- | --- | --- | --- |
| 编码 | 共用 | 自己的 `mcpServers` | 模式目录 + 项目 `.agents/skills` + `~/.agents/skills` | 模式目录，再叠加代码仓库层级 |
| 创作 | 共用 | 自己的 `mcpServers` | 只读模式目录 | 只读模式目录 |
| 学习 | 共用 | 无（不注册工具） | 无 | 只读模式目录 |

模型、端点与 API Key 是机器级配置（一台机器一把钥匙），存在 `~/.bnote/agent.json`；同一个文件还保存每种模式可选的 `agent_roots` 路径覆盖。

### 模型与协议

- 支持 Anthropic Messages、OpenAI 兼容、DeepSeek、GLM、Qwen、Ollama 与自定义端点；SSE 流式输出
- 模型配置在 `~/.bnote/agent.json`（协议、Base URL、模型、API Key、上下文窗口）；旧版应用数据目录里的 `agent.json` 首次启动时自动迁移
- API Key 只在 Rust 侧使用，不进入任何网页上下文

### 指令文件（AGENTS.md）

- **每种模式**读自己的 `<仓库>/.bnote/agents/<模式>/AGENTS.md` 与 `rules/*.md`（首次打开仓库时会从旧的 `~/.bnote` 与 `.bnote/AGENTS.md` 位置复制一次）
- **编码会话**再读代码仓库从根到工作目录的 `AGENTS.md` / `CLAUDE.md` / `.bnote/AGENTS.md` / `.bnote/rules/*.md` / `AGENTS.local.md`
- **学习与创作会话**不读取任何代码仓库的指令文件
- 支持 `@import`（最多 5 层，跳过代码块与注释），`settings.instructionsExcludes` 用 glob 排除
- 读文件时，如果该文件目录到项目根之间还有没加载过的 `AGENTS.md`，会作为 system-reminder 补进下一轮对话

### 工具、权限与计划模式

- **工具**：`read_file` / `write_file` / `edit_file` / `list_files` / `glob` / `grep` / `bash`（含 `bash_output`、`bash_kill`）、`todo`、`task`、`skill`、`mcp`、`task_*`、`ask_user_question`、`send_message`、`EnterPlanMode` / `ExitPlanMode`
- **子代理**：`general-purpose`（全工具）、`explore`（只读）、`plan`（只读计划）、`fork`（继承当前上下文），可并行、可后台，记录落在 `~/.bnote/projects/<项目键>/<会话>/subagents/`
- **权限四档**（盾牌菜单）：变更前确认 / 自主模式 / 完全访问 / 计划模式；设置文件里的 `permissions.allow / ask / deny` 规则先于档位判定，支持 `Bash(git push:*)`、路径 glob 这类写法
- **计划模式**：只读调研，写文件与有副作用的命令一律拒绝；`ExitPlanMode` 把计划写进 `~/.bnote/plans/<slug>.md` 并弹批准卡，批准后才恢复原档位
- **上下文**：超长会话自动压缩（带熔断），大工具结果落盘只回一条引用，Anthropic 的系统提示分静态/动态两块并给静态块加 `cache_control`

### 设置分层、hooks 与输出风格

- **逐层合并**：模式的 `settings.json`，再叠加（仅编码）`<代码项目>/.bnote/settings.json` 与 `settings.local.json`；数组拼接去重、对象深合并、标量后者覆盖。字段：`mcpServers`、`disabledMcpServers`、`skillDirs`、`disabledSkills`、`env`、`permissions`、`hooks`、`outputStyle`、`instructionsExcludes`、`cleanupPeriodDays`、`plansDirectory`、`autoMemoryEnabled`、`autoMemoryDirectory`
- **MCP 按模式隔离**：服务器列表写在本模式的 `settings.json`；设置页的开关写进 `disabledMcpServers`，停用但不删除配置
- **hooks**：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit`、`SessionStart`、`Stop`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`。`sh -c` 执行，stdin 收 JSON，默认 60 秒超时；可返回 `permissionDecision`、`additionalContext`、`updatedInput`，非零退出可以拦住工具
- **输出风格**：内置 default / Explanatory / Learning，自定义文件放 `<模式目录>/output-styles/*.md` 与（编码）`<代码项目>/.bnote/output-styles/*.md`（frontmatter：`name` / `description` / `keep-coding-instructions`）；`settings.outputStyle` 选中后注入动态段
- **设置页随模式变化**：`设置 → Agent` 在编码模式是 `模型 | MCP | 技能 | AGENTS.md | 高级`，创作模式是 `模型 | MCP | 技能 | AGENTS.md`，学习模式只有 `模型 | AGENTS.md`。每个页面直接读写真实文件（配置目录与路径覆盖、settings.json 编辑器与解析状态、逐个 MCP 开关）；弹窗高度固定，内容多了滚动而不是改变窗口大小

### 记忆、历史与技能

- **自动记忆**：`~/.bnote/projects/<项目键>/memory/MEMORY.md` 是唯一索引，一条记忆一个文件，`[[name]]` 互链；编码会话每轮注入索引与记忆行为提示
- **提示词历史**：每次发送追加 `~/.bnote/history.jsonl`；输入框为空时按 `↑` 召回本项目的历史提示词，`↓` 往回走，发送后清空
- **技能**：编码模式扫描 `<仓库>/.bnote/agents/coding/skills/`、`<代码项目>/.agents/skills/`、`~/.agents/skills/`（Agent Skills 约定）与 `skillDirs`；创作模式只扫描自己的目录；同名技能保留优先级最高的一份，设置页按来源分组展示

### `~/.bnote` 布局

```text
~/.bnote/
├── agent.json            协议 / 模型 / API Key / 各模式目录覆盖
├── history.jsonl         提示词历史
├── plans/<slug>.md       计划模式的产出
├── tasks/<list>/         待办的落盘状态
└── projects/<项目键>/
    ├── memory/MEMORY.md  自动记忆索引
    ├── <会话>.jsonl      编码会话记录
    └── <会话>/           subagents/ 与 tool-results/

<仓库>/.bnote/agents/<模式>/
├── settings.json         MCP、技能目录、权限、hooks、输出风格
├── AGENTS.md             该模式的指令
├── rules/*.md
├── skills/<name>/SKILL.md
└── output-styles/*.md
```

## 专注模式

- 状态栏芯片点一下即开始；命令面板里是 `focus.pomodoro-start`（`Cmd+Alt+T`，取第一个时长）
- **一段专注就是一段连续时间**：没有休息段、没有暂停、不能提前结束，只有「开始」
- 开始 = 伪全屏（层级 25，盖住菜单栏，跨越 Space）+ 硬锁 + 起表，三者同时成立；硬锁需要辅助功能权限，拿不到权限就不开始，并在提示里指向系统设置
- 硬锁吞掉 `Cmd+Tab` / `Cmd+Space` / `Ctrl+↑` / `Cmd+Q`，应用菜单键（`Cmd+M` / `Cmd+H` / `Cmd+W`）仍然可用
- 时长最多配置三个，运行中不能改；重启应用后计时与锁一起恢复
- 时间到自动解锁、还原窗口层级；运行的实例在倒计时写进窗口标题

## 快捷键

每个操作都是一条命令：命令面板（`Cmd+P`）可搜到、可绑键、可改绑。默认键位表从 keymap 生成，不在本文件手写：**[docs/keybindings.md](docs/keybindings.md)**。

- **按区域区分**：同一把键因焦点不同而含义不同——`global` / `notes` / `reading` / `agent` / `project` / `code`。在助手面板 `Cmd+[` 是回到上层会话，在笔记区是回退到上一次链接跳转。
- **改绑**：设置 → 快捷键可按区域录制新键、解绑、恢复默认；覆盖写进 `<vault>/.bnote/keybindings.json`，随仓库走，也可以手改。
- **故意不绑**：`view.toggle-code-mode` 没有默认键（`Cmd+Shift+C` 是插入代码块）；`app.quit` 也不绑，避免误按 `Cmd+Q` 退出应用（专注模式硬锁期间本来也会吞掉它）。

## 数据与配置

### 应用数据目录

`~/Library/Application Support/com.bnote.app/`

| 文件 | 用途 |
| --- | --- |
| `config.json` | 最近仓库、上次文件、设置、光标位置、窗口几何、代码项目 |
| `keybindings.json` | 全局快捷键覆盖（按区域分组） |
| `vimrc` | 全局 Vim 映射 |
| `translate.json` | 句子翻译：协议、Base URL、模型、API Key、思考开关、超时 |

### Agent 运行时（`~/.bnote`）

| 路径 | 用途 |
| --- | --- |
| `agent.json` | 协议、Base URL、模型、API Key、上下文窗口，以及各模式可选的 `agent_roots` |
| `history.jsonl` | 提示词历史（输入框 `↑` 召回） |
| `plans/` | 计划模式的计划文件 |
| `tasks/<list>/` | 后台任务列表的落盘状态 |
| `projects/<项目键>/` | 每个项目：`memory/`、会话 `.jsonl`、子代理与工具结果 |

设置项 `BNOTE_HOME` 可以把整个目录挪到别处。

### Vault 内配置

| 路径 | 用途 |
| --- | --- |
| `.bnote/keybindings.json` | 仓库级快捷键覆盖（按 `global` / `notes` / `reading` / `agent` / `project` / `code` 分区） |
| `.bnote/vimrc` | 仓库级 Vim 映射（优先于全局） |
| `.bnote/snippets.js` | 仓库级 LaTeX 片段；存在时取代内置片段 |
| `.bnote/agents/<模式>/` | 该模式的配置目录：`settings.json`、`AGENTS.md`、`skills/`、`rules/`、`output-styles/` |
| `.bnote/settings.json`、`.bnote/settings.local.json` | 代码项目的 agent 设置（叠加在编码模式目录之上） |
| `.agents/skills/` | 代码项目的技能（Agent Skills 约定） |
| `.bnote/lsp.json` | 语言服务器启动命令（跟着仓库走） |
| `.bnote/projects/<项目名>.md` | 项目待办清单 |
| `.bnote/materials/index.json` | 材料登记表：材料身份 → 目录名 |
| `.bnote/materials/pdfs/<目录>/` | PDF 原文、`annotations.json`、`sessions/*.jsonl` |
| `.bnote/materials/webpages/<目录>/` | 网页材料的会话记录 |
| `.bnote/materials/wxreads/<目录>/` | 微信读书材料的会话记录 |
| `.bnote/web-annotations/<host>-<hash>.json` | 按网址保存的网页批注 |
| `.bnote/read-positions.json` | 阅读位置（PDF 页码 + 页内比例；网页滚动比例） |
| `.bnote/daily-links.json` | 跨文件待办同步映射 |
| `.bnote/daily-footprints.json` | 今日足迹基线 |

## 架构与性能

```text
src/                        前端：React 19 + CodeMirror 6 + Zustand
  editor/                   实时渲染、KaTeX、LaTeX 片段、Vim、打字机、输入法跟随
  commands/                 命令注册中心、区域化键位、内置命令、键序
  components/               视图层：应用外壳与设置，以及按域分的视图目录
                            （agent / study / code / daily / projects / focus / python）
  study/                    材料目录、PDF/网页批注、阅读位置、微信读书、网页运行时、缩放
  code/                     文件树、编辑器、LSP 客户端、git 差异、问题面板、终端
  projects/                 项目看板模型、拖动、发送到日记
  focus/                    番茄钟状态机与专注锁
  daily/  footprint/        跨文件待办模型与同步引擎、今日足迹 diff 与渲染
  python/                   代码块提取、运行面板、类型检查客户端
  dev/                      浏览器调试入口与 harness

src-tauri/src/              Rust 后端
  commands/                 vault/files/config/materials/agent/python/ime/translate/focus/term
  agent/                    Provider、会话、工具、子代理、home、instructions、settings、hooks、output_style
  code/ lsp/               项目树缓存、git、共享 LSP 传输
  python/                   运行器、ty LSP 桥、uv 环境
  dict.rs / translate.rs    ECDICT 词典与选词分类、翻译请求
  devbridge.rs              浏览器模式的 IPC 桥（127.0.0.1:1439）

tests/data/pdfs/            PDF 转换夹具与质量门禁
scripts/                    dev-signing setup
```

几条贯穿实现的原则：

- **文件系统是唯一事实**：笔记、批注、会话都落在磁盘（Vault 或 `~/.bnote`），Rust 侧文件操作走 `spawn_blocking`，不阻塞 UI
- **单一写入者**：同一份状态只有一个写入者；异步回调（measure、watcher、流式事件）先自证仍对应当前状态，过期即丢弃
- **Vault watcher**：基于 FSEvents 的朴素 watcher + 手写去抖，静默 300 ms 后发送 `vault-changed`，避免大仓库启动时的全树扫描
- **只处理可视区域**：实时渲染仅遍历视口内的语法树；性能敏感路径由 [`src/editor/perf.gate.test.ts`](src/editor/perf.gate.test.ts) 与 [`src/code/perf.gate.test.ts`](src/code/perf.gate.test.ts) 锁定量级
- **原生能力留在 Rust**：文件读写、网页预览（原生子 webview）、翻译与模型请求都由 Rust 发起；API 密钥不进入任何网页上下文

## 开发与门禁

- **前端**：`pnpm dev` 启动 Vite；`pnpm tauri dev` 启动完整应用。`pnpm gate` = `eslint` + `tsc --noEmit` + `prettier --check` + `vitest`，是「改动完成」的定义
- **真实后端调试**：`pnpm tauri dev` 运行时，浏览器打开 `http://localhost:1430/` 即为真应用（`devbridge` 补上 Tauri IPC，连真 vault、真文件树、真 watcher）
- **纯前端 harness**：`http://localhost:1430/harness.html` 挂载带全部扩展的编辑器 + 内存假仓库，用于确定性 DOM 断言与几何测量
- **设计约束与调试协议**：见 [`AGENTS.md`](AGENTS.md) 与 [`DEBUG.md`](DEBUG.md)

## Roadmap

- 多标签页
- 全库全文搜索
- 知识图谱 / 图形视图
- 更完整的 vimrc：`<leader>` 前缀与更多 `:set` 选项

## License 与致谢

本项目采用 [MIT License](LICENSE)。

内置词库来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT），生成参数与来源 commit 记录在 `src-tauri/resources/ecdict_common.json`。同时感谢 [Tauri](https://tauri.app/)、[CodeMirror](https://codemirror.net/)、[KaTeX](https://katex.org/)、[pdf.js](https://mozilla.github.io/pdf.js/)、[Excalidraw](https://excalidraw.com/)、[xterm.js](https://xtermjs.org/) 等开源项目。

<p align="center">
  <img src="./app-icon.png" width="104" alt="bnote app icon" />
</p>

<h1 align="center">bnote</h1>

<p align="center">
  面向 macOS 的本地优先 Markdown 笔记应用。<br />
  <strong>Tauri 2 · React 19 · CodeMirror 6 · Rust</strong>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
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

> **bnote** 把「笔记 + 论文/网页阅读 + 学习助手」放进同一个窗口。仓库就是磁盘上的普通文件夹，笔记就是普通 Markdown：可以用 Git 管理、用任何编辑器打开、随时带走。常用能力原生内置，不依赖插件生态，也没有 Electron。

---

## 目录

- [核心特性](#核心特性)
- [编辑器](#编辑器)
- [学习模式](#学习模式)
- [日记、待办与今日足迹](#日记待办与今日足迹)
- [画布、附件与 Python](#画布附件与-python)
- [默认快捷键](#默认快捷键)
- [快速开始](#快速开始)
- [数据与配置](#数据与配置)
- [架构与性能](#架构与性能)
- [开发与门禁](#开发与门禁)
- [Roadmap](#roadmap)
- [License 与致谢](#license-与致谢)

## 核心特性

| 领域 | 能力 |
| --- | --- |
| **本地优先** | Vault 是普通文件夹，笔记是普通 Markdown；可被 Git、iCloud、Dropbox 或任意编辑器直接读写。 |
| **实时渲染** | 光标所在行保留源码，其余区域按 Obsidian 风格渲染；只处理可视区域，长文档仍然流畅。 |
| **公式与片段** | KaTeX 行内/块级公式；220+ 内置 LaTeX 快捷片段，支持占位符、正则捕获、视觉模式包裹与仓库级自定义。 |
| **Vim 与输入法** | 原生 Vim 模式与 vimrc 映射；macOS 下随 insert/normal 自动切换输入法，公式与代码块保持英文。 |
| **区域化快捷键** | 同一个键在「通用 / 笔记区 / 阅读区 / Agent 面板」可以绑不同命令；全部命令可搜索、改键、解绑。 |
| **学习模式** | 中栏阅读 PDF / 网页 / 微信读书，右栏记笔记或与学习助手对话；批注、阅读位置、历史按材料持久化。 |
| **选中翻译** | 单词查内置 ECDICT（59k 条目，离线）；句子走可配置的模型 API（OpenAI 兼容 / DeepSeek / GLM / Qwen / Anthropic / Ollama）。 |
| **日记与待办** | 跨文件待办双向同步到今日日记；未发送的完成项自动记录；当天改动汇总为「今日足迹」。 |
| **画布与附件** | Excalidraw 画布以文件保存并导出预览图，回到笔记自动插入；兼容 Obsidian `.excalidraw.md`。 |
| **Python** | 一篇笔记的全部 python 块当作一个 `.py` 运行，流式输出、可中止；ty 类型检查与 uv 环境管理。 |

## 编辑器

### 实时渲染

与 Obsidian 一致：光标所在行保持源码，其余区域直接渲染（`src/editor/livePreview.ts`）。

- 标题、粗体、斜体、删除线、引用块、Callout、分割线、列表、转义符、行内代码与围栏代码块
- 代码块按语言高亮，语言包按需加载
- 行内公式 `$...$` 与公式块 `$$...$$` 用 KaTeX 渲染；编辑公式时保留源码，并在下方实时预览
- 任务列表 `- [ ]` / `- [x]` 可直接点击；完成后写入 `✅ 日期`，再次点击可取消
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

学习模式是两栏布局：**内容栏（左）+ 右栏（笔记 / 学习助手页签）**。分隔条可拖动，内容栏宽度按像素持久化；右栏两个页签常驻挂载，切换页签不重建编辑器。

### PDF

- 导入的 PDF 复制进材料目录 `.bnote/materials/pdfs/<拼音目录>/`，与批注、会话放在一起；不做 Markdown 转换
- pdf.js 渲染，支持书签大纲、缩放、文本选择、护眼底色
- **批注**：亮黄色高亮 + 亮蓝色文字批注，整页比例坐标存盘 —— 缩放、裁剪、DPR 变化都不影响位置；右侧留白区展示批注内容
- **阅读位置**：记录「第几页 + 页内偏移」，重排后仍从同一处继续读
- **截图入助手**：截取当前可见页面（canvas 合成，无需系统截图权限），直接作为附件进入学习助手输入框
- 历史下拉里所有打开过的 PDF 可一键回到

### 网页与微信读书

- 网页在**原生子 webview**中打开，不是 iframe：`X-Frame-Options` / CSP `frame-ancestors` 都拦不住；滚动、尺寸随内容栏同步
- **批注**：高亮与文字批注按「原文片段 + 前后 40 字上下文 + 偏移」定位，广告和懒加载不会让批注错位；按网址存进 `.bnote/web-annotations/<host>-<hash>.json`，页面内另有 localStorage 兜底
- **阅读位置**：网页记录可滚动高度的比例，重开回到同一段文字
- **按步长翻页**：`PageUp` / `PageDown` 按设置的比例滚动，并对齐到文字行；页面上半屏有渐变提示
- **页面缩放**：顶部 `− / 读数 / +` 控件，或 `⌘=` / `⌘-` / `⌘0`；浏览器级缩放，文字重排、整页一起放大（50%–300%）
- **微信读书适配**：铺满阅读区、目录左停靠常驻；SPA 路由变化会被追踪，最近读的书进入历史

### 选中翻译

- **单词**（恰好一个英文 token）：只查内置 ECDICT 词典，59,137 条常用词，压缩后约 1.5 MB 编译进二进制，首次查询一次性解压到内存，不落盘
- **句子/短语**（两个及以上 token）：走设置中配置的模型 API；单词未收录时**不会**回落到模型，而是提示选中更多词
- 支持协议：OpenAI 兼容、DeepSeek、GLM、Qwen、Anthropic、Ollama（默认 `http://127.0.0.1:11434`，请求 `/api/chat`）
- 思考模式按协议发送 `think` / `thinking.type` / `enable_thinking`；默认关闭，避免模型只返回思考内容
- API Key 与请求都留在 Rust 侧（`translate.json`），网页拿不到密钥；网页预览里句子请求 600 ms 节流
- 设置页有「测试连接」，用未保存的表单值发一条固定句子
- Ollama 等本地服务由你自己启动，bnote 只做 HTTP 调用，不会拉起进程

### 学习助手

- 支持 Anthropic Messages 与 OpenAI 兼容协议，SSE 流式回复
- **按材料保存会话**：一份 PDF / 一个网址的会话落在该材料的 `sessions/<会话>.jsonl`，首行是元数据（标题 + 模型配置快照）；切换材料自动切回它的会话
- 支持从任意一条消息**分叉**出辅助会话、主/辅会话来回切换、历史会话抽屉
- 页脚显示上下文占用（最近一次请求的 input + output，对照设置的上下文窗口）
- 支持粘贴截图、选择图片作为消息附件
- 自定义指令写在 `.bnote/agent.md`，会拼进系统提示
- 当前学习助手是**纯问答**：不注册工具（文件系统 / MCP 工具未启用），模型只凭自身知识回答

## 日记、待办与今日足迹

- 任意笔记里的待办可发送到今日日记（默认 `Daily/YYYY-MM-DD.md`，目录与文件自动创建）
- 发送后两侧持续同步：完成状态、子待办增删改都会双向镜像；日记里已有同文条目会直接认领，避免重复
- 未显式发送的待办在勾选后也会记录到当天日记，取消完成时自动清理
- 日记末尾提供「今日足迹」：按源文件汇总当天新增或修改的非待办内容，点击可跳回原文
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

## 默认快捷键

> 以下为 macOS 默认值。所有命令都能在 `设置 → 快捷键` 中按区域改绑或解绑，以设置页实际显示为准。

### 工作区与导航

| 快捷键 | 功能 |
| --- | --- |
| `Cmd+P` | 命令面板 |
| `Cmd+O` | 快速跳转到文件 |
| `Cmd+N` / `Cmd+S` | 新建 / 保存笔记 |
| `Cmd+Shift+A` | 快速添加文件 |
| `Cmd+Shift+K` | 快速待办：添加到今日日记最前 |
| `Cmd+Shift+O` | 打开今日日记；在日记内再次按下跳回 |
| `Cmd+Shift+R` | 切换到最近打开的仓库 |
| `Cmd+,` | 打开设置 |
| `Cmd+\` | 显示 / 隐藏侧边栏 |
| `Cmd+I` | 聚焦侧边栏 |
| `Cmd+[` | 回退到上一次链接跳转 |
| `Cmd+T` | 跳到文档头部疑问待办 / 返回原位置 |
| `Cmd+Shift+S` | 进入 / 退出学习模式 |

### 编辑

| 快捷键 | 功能 |
| --- | --- |
| `Cmd+M` / `Cmd+Shift+M` | 插入公式块 / 行内公式 |
| `Cmd+Shift+C` / `` Cmd+` `` | 插入代码块 / 行内代码 |
| `Cmd+Shift+B` | 插入 Callout |
| `Cmd+Shift+H` | 插入分割线 |
| `Cmd+K` | 插入内部链接；当前行已有链接时跳转 |
| `Cmd+B` / `Cmd+Shift+I` / `Cmd+Shift+D` | 粗体 / 斜体 / 删除线 |
| `Cmd+J` / `Cmd+1..6` | 循环标题层级 / 设置 N 级标题 |
| `Cmd+L` | 切换当前行待办状态 |
| `Cmd+Shift+J` | 待办发送到今日日记并建立同步 |
| `Cmd+;` / `Cmd+Shift+;` | 无序 / 有序列表 |
| `Cmd+Enter` | 运行当前笔记的 Python 代码 |
| `Cmd+E` | 切换实时渲染 / 源码模式 |
| `Cmd+Shift+V` / `Cmd+Shift+T` / `Cmd+Shift+L` | 切换 Vim / 打字机 / LaTeX 片段 |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | 放大 / 缩小 / 重置编辑区字号（全局；阅读区打开网页时让给网页缩放） |

### 学习模式与阅读区

| 快捷键 | 功能 |
| --- | --- |
| `PageUp` / `PageDown` | 上一页 / 下一页（固定键，不受改绑影响） |
| `Cmd+Shift+E` | 截取阅读区可见内容到学习助手 |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | 网页放大 / 缩小 / 回到 100%（网页打开时） |
| `Cmd+Shift+U` | 切换右栏 笔记 / 学习助手 |
| `Cmd+Shift+Y` | 学习助手：主会话 / 辅助会话切换 |
| `Cmd+Shift+N` | 学习助手：新建会话 |
| `Cmd+Shift+F` | 学习助手：从当前会话分叉 |
| `Cmd+Shift+H` | 学习助手：打开历史会话列表 |
| `Cmd+[` | 学习助手：从分叉会话返回上一条 |
| `Cmd+Option+A` / `Cmd+Option+N` / `Cmd+Option+R` | 聚焦 学习助手 / 笔记区 / 阅读区 |

> 学习助手的 `⌘⇧N` / `⌘⇧F` / `⌘⇧H` / `⌘⇧Y` 与 `⌘[` 只在焦点位于助手面板时生效；`⌘[` 在笔记区是链接回跳。

## 快速开始

```bash
git clone https://github.com/Baike12/bnote.git
cd bnote
pnpm install
pnpm tauri dev
```

首次启动后选择一个 Vault 文件夹即可开始使用。

### 环境要求

- macOS
- Node.js 20+
- pnpm
- Rust stable
- Xcode Command Line Tools

可选：`uv`（Python 环境）、`ty`（Python 类型检查）、Ollama 或其他模型服务（句子翻译 / 学习助手）。

### 构建

```bash
pnpm tauri build
```

产物为 `.app` / `.dmg`，由 Tauri 生成。

### 测试与检查

```bash
pnpm gate                                            # lint + typecheck + 单元测试
cargo test --manifest-path src-tauri/Cargo.toml      # Rust 测试
cargo check --manifest-path src-tauri/Cargo.toml     # Rust 编译检查
```

## 数据与配置

### 应用数据目录

`~/Library/Application Support/com.bnote.app/`

| 文件 | 用途 |
| --- | --- |
| `config.json` | 最近仓库、上次文件、设置、光标位置、窗口几何 |
| `keybindings.json` | 全局快捷键覆盖（按区域分组） |
| `vimrc` | 全局 Vim 映射 |
| `agent.json` | 学习助手：协议、Base URL、模型、API Key、上下文窗口 |
| `translate.json` | 句子翻译：协议、Base URL、模型、API Key、思考开关、超时 |

### Vault 内配置

| 路径 | 用途 |
| --- | --- |
| `.bnote/keybindings.json` | 仓库级快捷键覆盖 |
| `.bnote/vimrc` | 仓库级 Vim 映射（优先于全局） |
| `.bnote/snippets.js` | 仓库级 LaTeX 片段；存在时取代内置片段 |
| `.bnote/agent.md` | 学习助手的仓库级自定义指令 |
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
  components/               侧栏、编辑器、学习模式、PDF 阅读器、Agent 面板、设置
  study/                    材料目录、PDF/网页批注、阅读位置、微信读书、网页运行时、缩放
  daily/  footprint/        跨文件待办模型与同步引擎、今日足迹 diff 与渲染
  python/                   代码块提取、运行面板、类型检查客户端
  dev/                      浏览器调试入口与 harness

src-tauri/src/              Rust 后端
  commands/                 vault/files/config/materials/agent/python/ime/translate
  agent/                    Provider（Anthropic + OpenAI 兼容）、SSE 流式、会话
  python/                   运行器、ty LSP 桥、uv 环境
  dict.rs                   ECDICT 词典（二进制资产 + 二分查找）
  translate.rs              选词分类与翻译请求
  devbridge.rs              浏览器模式的 IPC 桥（127.0.0.1:1439）

scripts/build-dict.py       从固定 commit 的 ECDICT 生成词库资产
```

几条贯穿实现的原则：

- **文件系统是唯一事实**：笔记、批注、会话都落在 Vault 里，Rust 侧文件操作走 `spawn_blocking`，不阻塞 UI
- **单一写入者**：同一份状态只有一个写入者；异步回调（measure、watcher、流式事件）先自证仍对应当前状态，过期即丢弃
- **Vault watcher**：基于 FSEvents 的朴素 watcher + 手写去抖，静默 300 ms 后发送 `vault-changed`，避免大仓库启动时的全树扫描
- **只处理可视区域**：实时渲染仅遍历视口内的语法树；性能敏感路径由 [`src/editor/perf.gate.test.ts`](src/editor/perf.gate.test.ts) 锁定量级（约 900 行混合文档，10 倍级回归必被拦下）
- **原生能力留在 Rust**：文件读写、网页预览（原生子 webview）、翻译与模型请求都由 Rust 发起；API 密钥不进入任何网页上下文

## 开发与门禁

- **前端**：`pnpm dev` 启动 Vite；`pnpm tauri dev` 启动完整应用。`pnpm gate` = `eslint` + `tsc --noEmit` + `vitest`，是「改动完成」的定义
- **真实后端调试**：`pnpm tauri dev` 运行时，浏览器打开 `http://localhost:1430/` 即为真应用（`devbridge` 补上 Tauri IPC，连真 vault、真文件树、真 watcher）
- **纯前端 harness**：`http://localhost:1430/harness.html` 挂载带全部扩展的编辑器 + 内存假仓库，用于确定性 DOM 断言与几何测量
- **设计约束与调试协议**：见 [`AGENTS.md`](AGENTS.md)

## Roadmap

- 多标签页
- 全库全文搜索
- 知识图谱 / 图形视图
- 更完整的 vimrc：`<leader>` 前缀与更多 `:set` 选项

## License 与致谢

本项目采用 [MIT License](LICENSE)。

内置词库来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT），生成参数与来源 commit 记录在 `src-tauri/resources/ecdict_common.json`。同时感谢 [Tauri](https://tauri.app/)、[CodeMirror](https://codemirror.net/)、[KaTeX](https://katex.org/)、[pdf.js](https://mozilla.github.io/pdf.js/)、[Excalidraw](https://excalidraw.com/) 等开源项目。

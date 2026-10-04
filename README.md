<p align="center">
  <img src="./app-icon.png" width="104" alt="bnote app icon" />
</p>

<h1 align="center">bnote</h1>

<p align="center">
  本地优先的 Markdown 笔记应用，使用 <strong>Tauri 2 + CodeMirror 6</strong> 构建。<br />
  文件留在磁盘，核心编辑体验对标 Obsidian；没有 Electron，常用能力原生内置。
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="CodeMirror 6" src="https://img.shields.io/badge/CodeMirror-6-B873F6?style=flat-square" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111111" />
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/Baike12/bnote?style=flat-square&logo=github" />
  <img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/Baike12/bnote?style=flat-square" />
</p>

> bnote 是一款面向 macOS 的本地优先 Markdown 笔记应用。实时渲染、KaTeX 公式、LaTeX 快捷片段、Vim、输入法自动切换、日记待办同步、Excalidraw 画布、学习模式与 Python 执行都直接内置，仓库仍是普通文件夹，笔记仍是普通 Markdown。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **本地优先** | Vault 就是磁盘上的普通文件夹，Markdown 文件可被 Git、iCloud、Dropbox 或任意编辑器直接使用。 |
| **实时渲染** | 光标所在行保留源码，其余区域按 Obsidian 风格渲染；只处理可视区域，长文档仍然流畅。 |
| **公式与片段** | KaTeX 行内/块级公式，LaTeX 快捷片段支持自动展开、占位符镜像、正则捕获、视觉模式包裹与仓库级自定义。 |
| **Vim 与输入法** | 原生 Vim 模式、vimrc 映射；macOS 下可随 insert/normal 模式自动切换输入法，公式和代码块可保持英文。 |
| **日记与待办** | 跨文件待办双向同步到今日日记；当天非待办改动自动汇总为“今日足迹”。 |
| **画布与附件** | 图片惰性加载；Excalidraw 画布以文件形式保存，回到笔记时自动插入预览图和源文件链接。 |
| **学习模式** | 左侧 Agent、中间 PDF / 网页、右侧笔记的三栏工作区；支持 PDF 转 Markdown、MCP 工具与自定义 Skill 目录。 |
| **Python 工作流** | 把一篇笔记里的 Python 代码块按一个 `.py` 文件运行，流式输出、可中止、支持 ty 类型检查与 uv 环境。 |
| **快速工作流** | 命令面板、快速跳转、内部链接补全与回跳、快速添加、最近仓库切换、全量快捷键自定义。 |

## 功能详解

### 实时渲染

与 Obsidian 一致：光标所在行保持源码，其余区域直接渲染。

- 标题、粗体、斜体、删除线、引用块、Callout、分割线、列表、转义符、行内代码与围栏代码块
- 代码块按语言高亮，语言包按需加载
- 行内公式 `$...$` 与公式块 `$$...$$` 使用 KaTeX 渲染；编辑公式时保留源码，并在下方实时预览结果
- 任务列表 `- [ ]` / `- [x]` 可直接点击；完成后自动写入 `✅ 日期`，再次点击可取消
- `[[target|alias]]` 内部链接可点击跳转，`[text](url)` 外部链接交给系统浏览器打开
- 支持 `![alt](path)` 与 `![[image.png]]` 图片嵌入，按相对路径、Vault 根目录和文件名逐级解析，并在可视区域内惰性加载
- Excalidraw 的 `.excalidraw` / `.excalidraw.md` 文件嵌入时显示自动导出的 PNG，点击可回到画布继续编辑
- 再次打开笔记时自动恢复上次的光标与滚动位置

渲染引擎位于 [`src/editor/livePreview.ts`](src/editor/livePreview.ts)，只遍历可视区域的语法树，并缓存 KaTeX HTML。

### 公式与 LaTeX 片段

- 内置 200+ 片段，支持 `Tab` 展开、输入即展开、占位符镜像、正则捕获、Visual 模式包裹和正文/公式/代码上下文识别
- 支持括号自动放大、矩阵快捷键、Tabout、括号配对高亮、双美元符删除、片段空白清理等 LaTeX Suite 行为
- Vault 中存在 `.bnote/snippets.js` 时，它会完全取代内置片段；保存后自动热加载，加载失败会在界面中给出原因
- 设置中可以逐项调整 LaTeX Suite 特性，无需重启应用

### Vim 与输入法

- `normal` / `insert` / `visual` 三种模式，支持 `map`、`noremap`、`nnoremap`、`imap`、`vmap` 等常见 vimrc 映射和 `jj` 这类键序列
- `:w`、`:wq`、`:x`、`:q`、`:noh` 等命令可直接使用；`:Bnote <命令id>` 可把任意 bnote 命令映射成 Vim 键
- `o` / `O` 新建行会保留缩进；视觉模式、跳转列表、剪贴板和像素级垂直运动都做了原生适配
- macOS 下可在 `设置 → 输入法` 中配置 insert / normal 使用的输入法；公式与代码块可保持英文输入
- 快速跳转打开时可自动切到英文输入法，窗口失焦后恢复原输入法；切换通过 Carbon TIS 完成，不启动额外进程

### 编辑与导航

- **命令面板**：模糊搜索全部命令；新功能只需注册一个 `CommandDef`
- **快速跳转**：按文件名或文件夹名搜索，空格分隔多词按 AND 匹配；空输入显示最近打开列表
- **插入链接**：在光标处补全笔记。当前行已有链接时，同一个快捷键改为跳转到那篇笔记；重名笔记自动写成 Vault 相对路径
- **链接回跳**：沿着内部链接跳转历史逐层返回，不影响普通文件打开
- **快速添加**：预设“名称 + 目标文件夹”命令，一键创建笔记；不存在的子目录和重名文件会自动处理
- **标题操作**：`Cmd+J` 循环正文 → H1 → H2 → H3 → H4 → 正文；`Cmd+1..6` 直接设置层级，可自动生成 `1 / 1.1 / 1.1.2` 编号
- **快捷键自定义**：搜索、筛选、录入、解绑、恢复默认；冲突会自动移除旧绑定，并支持一个命令绑定多个键
- **文件管理**：文件树按目录懒加载，支持新建、重命名、删除、右键菜单和最近仓库切换
- **写作体验**：打字机模式、编辑区字号调节、停止输入后自动保存

### 日记、待办与今日足迹

- 任意笔记中的待办行可发送到今日日记（默认 `Daily/YYYY-MM-DD.md`，目录和文件会自动创建）
- 发送后两侧持续同步：完成状态、子待办增删改都会双向镜像；日记中已有同文条目时会直接认领，避免重复
- 未显式发送的待办在勾选后也会记录到当天日记，取消完成时自动清理
- 日记末尾提供“今日足迹”：按源文件汇总当天新增或修改的非待办内容，并可点击跳回原文
- 待办映射保存在 `.bnote/daily-links.json`，足迹基线保存在 `.bnote/daily-footprints.json`，重启后仍可恢复

### 画布与附件

- 通过命令面板打开 Excalidraw 画布；画布拥有独立的键盘交互，切换文件时会先保存并收尾当前会话
- 新建画布保存为 `<name>.excalidraw`，同时导出同名 PNG 供 Markdown 预览
- 兼容 Obsidian Excalidraw 插件的 `.excalidraw.md` 文件，包括 `compressed-json` 格式
- 点击笔记中的画布预览可继续编辑；回到来源笔记时，新画布会以 `![[...]]` 插入原光标位置
- 图片和 PDF 等媒体文件会进入 Vault 资产索引，供 Markdown 引用解析

### 学习模式与 Agent

- 三栏布局：左侧与 Agent 对话，中间阅读 PDF / Markdown / 网页，右侧编辑当前笔记；栏宽可拖动并持久化
- 拖入 PDF 后转换为 Markdown 和图表资产，转换结果保存在 Vault 的 `pdfs/` 目录
- 网页在原生子 WebView 中打开，滚动和尺寸随中间栏同步
- Agent 支持 Anthropic 与 OpenAI 兼容协议，可接入 OpenAI、DeepSeek、Grok、Ollama 等服务
- 支持 MCP 服务器和额外 Skill 目录；工具调用与流式回复直接显示在聊天面板中

### Python

- 一篇笔记中的所有 `python` 围栏代码块会按行号对齐，组合成一个虚拟 `.py` 文件运行
- `Cmd+Enter` 运行当前笔记，输出流式进入底部面板，可清空、停止，并显示退出码与耗时
- 支持基于 `ty` 的补全、Hover 与诊断；Python 代码块在编辑器中保留 Markdown 行号映射
- 可为当前项目创建或同步 `uv` 环境，日志复用运行面板显示

## 默认快捷键

> 以下为 macOS 默认值。所有命令都可以在 `设置 → 快捷键` 中重新绑定或解绑；冲突以实际设置页显示为准。

### 工作区

| 快捷键 | 功能 |
| --- | --- |
| `Cmd+P` | 命令面板 |
| `Cmd+N` / `Cmd+S` | 新建 / 保存笔记 |
| `Cmd+Shift+A` | 快速添加文件 |
| `Cmd+Shift+O` | 打开今日日记；在日记内再次按下可跳回 |
| `Cmd+Shift+R` | 切换到最近打开的仓库 |
| `Cmd+,` | 打开设置 |
| `Cmd+Shift+S` | 进入 / 退出学习模式 |
| `Cmd+Enter` | 运行当前笔记中的 Python 代码 |

### 导航

| 快捷键 | 功能 |
| --- | --- |
| `Cmd+[` | 回退到上一次链接跳转 |
| `Cmd+\\` | 收起 / 展开侧边栏，并在展开时聚焦当前文件 |
| `Cmd+I` | 聚焦侧边栏 |
| `Cmd+T` | 跳到文档头部疑问待办 / 返回原位置 |
| `Cmd+O` | 快速跳转到文件（如被自定义绑定占用，可在设置中调整） |

### 编辑

| 快捷键 | 功能 |
| --- | --- |
| `Cmd+M` / `Cmd+Shift+M` | 插入公式块 / 行内公式 |
| `Cmd+Shift+C` / `` Cmd+` `` | 插入代码块 / 行内代码 |
| `Cmd+Shift+B` | 插入 Callout |
| `Cmd+Shift+H` | 插入分割线 |
| `Cmd+K` | 插入内部链接；当前行已有链接时跳转 |
| `Cmd+B` / `Cmd+Shift+I` / `Cmd+Shift+D` | 粗体 / 斜体 / 删除线 |
| `Cmd+J` | 循环切换标题层级 |
| `Cmd+1..6` | 设置为 N 级标题 |
| `Cmd+L` | 切换待办状态 |
| `Cmd+Shift+J` | 将当前待办发送到今日日记并建立同步 |
| `Cmd+;` / `Cmd+Shift+;` | 切换无序 / 有序列表 |
| `Cmd+E` | 切换实时渲染 |
| `Cmd+Shift+V` / `Cmd+Shift+T` / `Cmd+Shift+L` | 切换 Vim / 打字机模式 / LaTeX 片段 |
| `Cmd+0` / `Cmd+-` / `Cmd+=` | 重置 / 缩小 / 放大编辑区字号 |

## 快速开始

```bash
git clone https://github.com/Baike12/bnote.git
cd bnote
pnpm install
pnpm tauri dev
```

首次启动后选择一个 Vault 文件夹即可开始使用。开发模式会启动 Vite 与 Tauri；浏览器调试页与测试 Harness 的说明见 [`AGENTS.md`](AGENTS.md)。

### 环境要求

- macOS
- Node.js 20+
- pnpm
- Rust stable
- Xcode Command Line Tools

### 构建

```bash
pnpm tauri build
```

构建产物为 `.app` / `.dmg`，由 Tauri 生成。

## 配置与数据

| 文件 | 位置 | 用途 |
| --- | --- | --- |
| `config.json` | `~/Library/Application Support/com.bnote.app/` | 最近仓库、上次文件、设置、光标位置 |
| `keybindings.json` | `~/Library/Application Support/com.bnote.app/` | 全局快捷键覆盖 |
| `vimrc` | `~/Library/Application Support/com.bnote.app/` | 全局 Vim 映射 |
| `.bnote/vimrc` | Vault 内 | 仓库级 Vim 映射 |
| `.bnote/snippets.js` | Vault 内 | 仓库级 LaTeX 片段；存在时取代内置片段 |
| `.bnote/keybindings.json` | Vault 内 | 仓库级快捷键覆盖 |
| `.bnote/daily-links.json` | Vault 内 | 跨文件待办同步映射 |
| `.bnote/daily-footprints.json` | Vault 内 | 今日足迹基线 |
| `.bnote/skills/` | Vault 内 | 学习模式 Agent 的仓库级 Skill |

## 架构

```text
src/                        前端：React 19 + CodeMirror 6 + Zustand
  editor/                   实时渲染、公式扫描、LaTeX 片段、Vim、打字机
  commands/                 命令注册中心、内置命令、快捷键与键序
  components/               侧边栏、快速跳转、设置、画布、学习模式等
  daily/                    跨文件待办模型、同步引擎与日记打开逻辑
  footprint/                今日足迹的 diff、存储、渲染与 widget
  python/                   Python 代码块提取、运行面板与 LSP 客户端
  state/appStore.ts         设置、打开文件、仓库树与应用级状态

src-tauri/                  Rust 后端
  src/commands/             Vault、文件、配置、Python、Agent、输入法命令
  src/agent/                Provider、MCP、Skill、会话与工具循环
  src/python/               Python runner、ty LSP、uv 环境
  src/state.rs              Vault watcher 与前端事件
```

性能设计：

- 文件树按目录懒加载，展开时才执行 `read_dir`
- 快速跳转使用独立扁平索引，不遍历文件树
- 文件操作通过 `spawn_blocking` 执行，避免阻塞 UI
- 原生文件系统 watcher 配合 300ms 去抖
- 实时渲染只覆盖可视区域，并缓存 KaTeX HTML
- 性能敏感路径由 [`src/editor/perf.gate.test.ts`](src/editor/perf.gate.test.ts) 设置量级门禁

## 开发与测试

```bash
pnpm dev             # 仅启动 Vite
pnpm tauri dev       # 启动完整桌面应用
pnpm gate            # lint + typecheck + unit tests
cargo check --manifest-path src-tauri/Cargo.toml
```

前端测试使用 Vitest。几何与手感相关的改动还需要在浏览器 Harness 中用 DOM 断言和真实像素测量验证，不能只依赖无 DOM 单测。

## Roadmap

- 多标签页
- 全库全文搜索
- 知识图谱 / 图形视图
- 更完整的 vimrc：`<leader>` 前缀与更多 `:set` 选项

## License

当前仓库尚未包含 License 文件；在添加明确许可证前，默认保留全部权利。

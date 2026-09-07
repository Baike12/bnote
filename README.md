# bnote

一个用 **Tauri 2 + CodeMirror 6** 实现的本地优先 Markdown 笔记应用，对标 Obsidian 的核心编辑体验，同时内置 Vim、打字机模式、LaTeX 快捷片段与可配置快捷键。没有 Electron，包体与内存占用远小于 Obsidian；没有插件系统，常用能力原生内置。

![stack](https://img.shields.io/badge/Tauri-2-blue) ![editor](https://img.shields.io/badge/editor-CodeMirror%206-purple)

## 核心特性

### 1. 实时渲染（Live Preview）

与 Obsidian 一致：**只有光标所在的行（或公式块/代码块）保持源码，其余区域直接渲染**。

- 标题（`#` 隐藏、按级别缩放）、粗体/斜体/删除线（标记符隐藏）
- 行内代码、围栏代码块（光标不在块内时隐藏围栏行，代码保留语法高亮，语言懒加载）
- 行内公式 `$…$` 与公式块 `$$…$$`（KaTeX 渲染，带 HTML 缓存；光标进入块内自动回到源码）
- 公式实时预览：光标在公式内编辑时保留源码（`$$`/命令/括号分色高亮），下方实时显示渲染结果；未闭合的 `$$` 块也照常渲染（设置 → 编辑器可关）
- 引用块、分割线、列表标记、转义符
- 任务列表 `- [ ]` / `- [x]` 渲染为可点击勾选框（点击直接改源码，完成后整行置灰）
- 外部链接 `[text](url)` 点击打开浏览器；内部链接 `[[target|alias]]` 点击跳转笔记

实现位于 `src/editor/livePreview.ts`：一个 CodeMirror 6 ViewPlugin 只遍历**可视区域**的语法树并生成 Decoration，配合 KaTeX 渲染缓存，长文档滚动/输入依然流畅。

### 2. LaTeX 快捷片段（移植自 obsidian-latex-suite）

无需插件系统，`obsidian-latex-suite` 的片段引擎与默认片段库（希腊字母、分数、积分、矩阵环境、上下标自动补全等 130+ 条）已内置：

- 非自动片段：输入触发串后按 `Tab` 展开（如 `//` → `\frac{}{}`、`dm` + Tab → 公式块）
- 自动片段（`A` 选项）：输入即展开（如 `sr` → `^{2}`、`@a` → `\alpha`）
- 占位符：`$0` `$1`…、`${0:默认文本}`（支持镜像占位符，`beg` + Tab 展开的 `\begin{}…\end{}` 两端同步）
- 正则片段与捕获组引用 `[[0]]`（如 `x3` → `x_{3}`）
- Visual 片段：选中文字后按键（如选中后按 `S` → `\sqrt{…}`）
- 模式感知：`m/n/M/t/T/c/C` 限制片段只在行内公式/公式块/正文/代码块中生效

自定义：在仓库下放 `.bnote/snippets.js`（格式与 latex-suite 兼容），设置 → 公式片段 中编辑保存即时生效。

### 3. 原生 Vim 模式 + vimrc

- 基于 `@replit/codemirror-vim`，支持 normal / insert / visual 模式
- vimrc：`设置 → Vim` 中编辑全局 vimrc（存于应用数据目录），或放 `<vault>/.bnote/vimrc`（叠加在全局之上）
- 支持 `map/nmap/imap/vmap/nnoremap/inoremap/unmap`（含键序列映射如 `imap jj <Esc>`）
- `:w` `:wq` `:x` `:q` `:q!` `:noh`，以及 `:Bnote <命令id>` 映射到任意 bnote 命令（如 `nmap <C-b> :Bnote nav.toggle-sidebar<CR>`）
- `<C-x>` `<D-x>` `<M-x>` `<S-x>` `<Esc>` 等按键记法自动转换

### 3.1 输入法跟随 Vim 模式（macOS）

进入 insert 自动切到中文输入法，回到 normal/visual 切回英文（`设置 → 输入法`，可各自选择输入法）。

- 应用内直调 Carbon TIS 框架，**不启动外部进程、不抢焦点**，单次切换 1–5ms（对比 Obsidian 插件 shell-out macism 的 ~150ms+）
- 已激活目标输入法时零开销跳过；光标在公式内进入 insert 保持英文，避免输入法干扰公式
- macOS 26 (Tahoe) 的 TIS API 强制主线程调用，实现里统一派发主线程；CJK 切换竞态自动验证重试，仍失败回退 `macism` CLI 并提示一次

### 4. 打字机模式

光标所在行始终垂直居中（`设置 → 编辑器` 或 `Cmd+Shift+T` 切换）。

### 5. 可配置快捷键 + 命令系统

- 所有能力都是注册到 Command Registry 的命令（`src/commands/`），新命令 = 一个 `CommandDef`，自动出现在命令面板与快捷键设置中
- `设置 → 快捷键`：搜索 + 全部/已分配/未分配筛选，点击行录入新快捷键（冲突自动移除原绑定）、解绑、恢复默认，Obsidian 同款交互
- 覆盖保存在 `keybindings.json`（应用数据目录），支持 `null` 解绑与一命令多键
- 默认键位：`Cmd+O` 快速跳转、`Cmd+P` 命令面板、`Cmd+N` 新建、`Cmd+Shift+A` 快速添加文件、`Cmd+S` 保存、`Cmd+M` 公式块、`Cmd+J` 设为/取消标题、`Cmd+E` 实时渲染开关、`Cmd+\` 侧边栏、`Cmd+L` 切换当前行待办状态（`- [ ]` → `- [x] ✅ 日期` → 还原普通行）……
- 标题行上 `Tab` 升一级 / `Shift+Tab` 降一级（1–5 级钳制）；普通行用 `Cmd+J` 先设为标题

## 开发

```bash
pnpm install
pnpm tauri dev     # 开发（Rust 增量编译）
pnpm tauri build   # 打包 .app / .dmg
```

要求：Node 20+、pnpm、Rust stable、Xcode CLT（macOS）。

## 配置文件位置

| 文件 | 位置 |
| --- | --- |
| 应用配置（上次仓库/文件、设置） | `~/Library/Application Support/com.bnote.app/config.json` |
| 快捷键覆盖 | `~/Library/Application Support/com.bnote.app/keybindings.json` |
| 全局 vimrc | `~/Library/Application Support/com.bnote.app/vimrc` |
| 仓库级配置 | `<vault>/.bnote/{vimrc, snippets.js, keybindings.json}` |

## 架构

```
src/                      # 前端（React + CodeMirror 6）
  editor/
    setup.ts              # 编辑器组装（Compartment 切换 vim/打字机/实时渲染）
    livePreview.ts        # 实时渲染装饰引擎（核心）
    mathScan.ts           # $…$ / $$…$$ 区域扫描
    context.ts            # 光标上下文（公式/代码/\text{}），供片段引擎复用
    snippets/             # latex-suite 片段引擎移植 + 默认片段库
    vim/                  # vim 集成 + vimrc 解析
    markdown.ts widgets.ts typewriter.ts ops.ts
  commands/               # 命令注册中心、内置命令、快捷键配置
  app/actions.ts          # 应用级操作（打开仓库、笔记 CRUD、设置应用）
  state/appStore.ts       # zustand 全局状态
  components/             # 侧边栏、快速跳转、命令面板、设置面板等
src-tauri/                # Rust 后端
  src/commands/{vault,files,config}.rs
                          # vault 管理、文件命令（路径白名单校验）、配置持久化
  notify-debouncer-full    # vault 文件监听 → vault-changed 事件
```

**性能设计**（打开大仓库实测优化）：
- 文件树**懒加载**：`read_tree` 只读根层，目录展开时按需 `read_dir`，超大仓库秒开；快速跳转与 wikilink 用独立的高性能 `list_files` 扁平扫描
- 所有文件系统命令跑在 `spawn_blocking`，**永不阻塞 UI 主线程**
- 文件夹选择用 dialog 插件前端异步 API（同步命令里调 `blocking_pick_folder` 会死锁主线程）
- watcher 用原生 notify（FSEvents 注册 O(1)）+ 自实现 300ms 去抖，避开 notify-debouncer-full 的全量 file-id 初始扫描
- 实时渲染装饰只覆盖可视区、KaTeX HTML 缓存、数学区域按文档版本记忆化

## 调试

前端暴露了 `window.__bnote` 诊断接口（view / math regions / 光标上下文 / snippet 会话 / 块级装饰），配合浏览器 DevTools 或 Playwright 可直接检查渲染引擎内部状态。

## 当前限制（Roadmap）

- 图片（本地路径）暂不内联渲染，仅显示为链接
- 片段暂不支持函数式替换（`replacement: (match) => …`）与 `autoEnlargeBrackets`
- vimrc 暂不支持 `<leader>` 前缀与 `set` 选项
- 无多标签页、全局搜索、图形视图（架构已预留）

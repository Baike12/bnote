# bnote

本地优先的 Markdown 笔记应用，**Tauri 2 + CodeMirror 6** 实现，对标 Obsidian 的核心编辑体验。没有 Electron、没有插件系统，常用能力原生内置：实时渲染、KaTeX 公式、LaTeX 快捷片段、Vim 模式、输入法自动切换、可配置快捷键。

![stack](https://img.shields.io/badge/Tauri-2-blue) ![editor](https://img.shields.io/badge/editor-CodeMirror%206-purple) ![platform](https://img.shields.io/badge/platform-macOS-lightgrey)

## 特性

### 实时渲染

与 Obsidian 一致：光标所在行保持源码，其余区域直接渲染。

- 标题（标记符隐藏、按级别缩放）、粗体/斜体/删除线、引用块、分割线、列表、转义符、行内代码与围栏代码块（语言高亮，语言按需懒加载）
- 行内公式 `$…$` 与公式块 `$$…$$`（KaTeX）；光标进入块内自动回到源码，编辑时下方实时预览渲染结果，未闭合的 `$$` 也照常渲染
- 任务列表 `- [ ]` / `- [x]` 渲染为可点击勾选框；勾选完成自动在行尾记下 `✅ 日期`，点击可取消
- 内部链接 `[[target|alias]]` 点击跳转笔记，外部链接 `[text](url)` 点击用系统浏览器打开
- 再次打开笔记时自动回到上次的光标与滚动位置

渲染引擎（`src/editor/livePreview.ts`）只遍历**可视区域**的语法树，配合 KaTeX 缓存，长文档依然流畅。

### 编辑能力

- **Vim 模式 + vimrc**：normal / insert / visual；`设置 → Vim` 编辑全局 vimrc（`map/nnoremap/imap/…` 与键序列如 `jj`）；`:w :wq :x :q :noh`，`:Bnote <命令id>` 把任意命令映射成 vim 键（如 `nmap <C-b> :Bnote nav.toggle-sidebar<CR>`）；`o`/`O` 新行保留缩进
- **输入法自动跟随（macOS）**：vim insert 切中文、normal/visual 切英文（各自可配置）；打开快速跳转（`Cmd+O`）自动切英文便于输入文件名，窗口失焦时还原你的原输入法。应用内直调 Carbon TIS，不启动进程、不抢焦点，单次切换 1–5ms
- **打字机模式**：光标行垂直居中，专注书写
- **标题操作**：`Cmd+J` 设为 / 取消标题；标题行 `Tab` 升一级、`Shift+Tab` 降一级（1–5 级）；开启"标题自动编号"后按层级重排 `1 / 1.1 / 1.2`
- **LaTeX 快捷片段**（移植自 obsidian-latex-suite）：130+ 内置片段，`Tab` 展开（`//` → `\frac{}{}`）、输入即展开（`sr` → `^{2}`、`@a` → `\alpha`）、占位符镜像同步、正则捕获、Visual 模式选中后按键包裹（选中按 `S` → `\sqrt{…}`）、公式/代码/正文模式感知；仓库下放 `.bnote/snippets.js` 即可自定义

### 工作流

- **命令面板（`Cmd+P`）**：模糊搜索全部命令，新命令只需注册一个 `CommandDef`
- **快速跳转（`Cmd+O`）**：按文件名或**文件夹名**搜索（空格分隔多词 AND，如 `工作 周报`）；空输入显示最近打开列表
- **快速添加（`Cmd+Shift+A`）**：一键在指定文件夹创建新笔记，对标 Obsidian QuickAdd。在 `设置 → 快速添加` 里预设若干"命令"（名称 + 目标文件夹，支持 `a/b` 子路径，不存在自动创建、重名自动加序号），弹窗里选定即可，文件夹与文件名输入都有路径建议
- **快捷键自定义**：`设置 → 快捷键` 搜索、筛选、点击录入（冲突自动移除原绑定）、解绑、恢复默认，Obsidian 同款交互；覆盖保存于 `keybindings.json`，支持解绑与一命令多键

## 默认快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Cmd+P` | 命令面板 |
| `Cmd+O` | 快速跳转到文件 |
| `Cmd+Shift+A` | 快速添加文件 |
| `Cmd+N` / `Cmd+S` | 新建 / 保存 |
| `Cmd+,` | 打开设置 |
| `Cmd+\` | 收起 / 展开侧边栏 |
| `Cmd+I` | 聚焦侧边栏 |
| `Cmd+T` | 跳到文档头部疑问待办 / 返回原位置 |
| `Cmd+M` / `Cmd+Shift+M` | 插入公式块 / 行内公式 |
| `Cmd+Shift+C` / `` Cmd+` `` | 插入代码块 / 行内代码 |
| `Cmd+K` | 插入内部链接 |
| `Cmd+B` / `Cmd+Shift+I` / `Cmd+Shift+D` | 粗体 / 斜体 / 删除线 |
| `Cmd+J` | 设为 / 取消标题 |
| `Cmd+1..6` | 设为 N 级标题 |
| `Cmd+L` | 切换待办（`- [ ]` → `- [x] ✅ 日期` → 还原） |
| `Cmd+;` / `Cmd+Shift+;` | 无序 / 有序列表切换（含任务框的行保留选框） |
| `Cmd+E` | 实时渲染开关 |
| `Cmd+Shift+V` / `Cmd+Shift+T` | Vim / 打字机模式开关 |

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
src/                    # 前端：React + CodeMirror 6
  editor/               # 编辑器：实时渲染、公式扫描、片段引擎、vim、打字机
  commands/             # 命令注册中心、内置命令、快捷键与键序
  components/           # 侧边栏、快速跳转、快速添加、命令面板、设置等
  state/appStore.ts     # zustand 全局状态（设置、打开文件、仓库树）
src-tauri/              # Rust 后端
  src/commands/         # vault / 文件 / 配置命令（路径白名单校验）
  src/state.rs          # vault watcher → vault-changed 事件
```

性能设计：文件树懒加载（展开目录才 `read_dir`）、快速跳转用独立扁平扫描、文件命令全部 `spawn_blocking` 不阻塞 UI、watcher 原生 FSEvents + 300ms 去抖、实时渲染只覆盖可视区并缓存 KaTeX HTML。

## 调试

前端暴露 `window.__bnote` 诊断接口（view / store / 块级装饰），配合浏览器 DevTools 可直接检查编辑器内部状态；编辑器开发用 `harness.html`（暴露 `__loadDoc`、`__toggleTodo` 等测试钩子）。

## Roadmap

- 图片内联渲染（当前本地图片显示为链接）
- 片段函数式替换 `replacement: (match) => …` 与 `autoEnlargeBrackets`
- vimrc `<leader>` 前缀与 `set` 选项
- 多标签页、全局搜索、图形视图（架构已预留）

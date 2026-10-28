# DEBUG.md — bnote 调试与验证方式

本文件是 [AGENTS.md](./AGENTS.md) 的从属文档,规定**默认必须遵守**的调试与验证协议;改前端逻辑、量性能、复现 bug 时按这里走。

改前端逻辑后**不构建、不部署**(由用户决定,历史上明确过"只调试不构建")。验证在浏览器里做,不抢焦点、不动用户的鼠标键盘;严禁 computer-use / 整屏截图(会占用用户桌面)。驱动一律用**会话内的浏览器**(ZCode 应用内浏览器,走 control-browser 技能那套):自己开标签页(`tabs.new()`)、用 `playwright.evaluate` 读 DOM/量几何;截图偶发拼接伪影,只当参考,**以 DOM 断言和磁盘字节为准**。不许另起 playwright-cli 或别的浏览器工具;用完关掉自己开的标签页,dev server 若是本会话起的就停掉。

## 两条回路

1. **直连真后端(首选)**:`pnpm tauri dev` 跑着时,浏览器打开 `http://localhost:1430/` 就是真应用——和 Tauri 窗口加载的是同一份构建(`devUrl`),缺的 `window.__TAURI_INTERNALS__` 由 `src/dev/browserMode.ts` 用官方 `@tauri-apps/api/mocks` 补上,IPC 指向 `src-tauri/src/devbridge.rs` 在 `127.0.0.1:1439` 上的 debug 口。真 vault、真文件树、真图片(`/__dev/asset` 顶替 `asset://`)、真 watcher(后端事件经 SSE 推给标签页)。
   - **真 vault 在 `/Users/baike3/Documents/baike`**:用户的真实笔记库(日记在 `Daily/YYYY-MM-DD.md`,同步映射在 `.bnote/daily-links.json`)。排查"某某功能把文件写坏了"这类问题就直读这里的文件——磁盘字节比屏幕现象可靠,`diff` 一下就能分清"这次操作写的"和"本来就有的"。
   - **LaTeX 快捷键的参考实现是 Obsidian 那份插件的源码**:`/Users/baike3/Documents/baike/.obsidian/plugins/obsidian-vim-input-auto-switch/`——目录名和内容不符,它 manifest 里的 id 是 `obsidian-latex-suite`(v1.9.4,作者的魔改版:并入 vim 输入法自动切换)。`main.js` 是打包产物但变量名基本保留,改 `src/editor/snippets/` 里任何语义之前先对着它核一遍;用户实际在用的片段配置在该目录的 `data.json`(`snippets` 字段,214 条),bnote 仓库级片段 `.bnote/snippets.js` 就是它的移植。
   - **公式片段的实际生效定义在 vault 里**:`/Users/baike3/Documents/baike/.bnote/snippets.js`(214 条,移植自上面那份 data.json)——该文件存在即**完全取代**内置片段集(`src/editor/snippets/default-snippets.ts`),不是叠加;改快捷键直接编辑它,保存热加载,字段语义说明在文件头。
   - **只有一份后端实现**:`devbridge.rs::dispatch` 把 `{cmd,args}` 转给同一个 `#[tauri::command]`;加命令就在那张 match 表里加分支,不要在 JS 侧另写实现。
   - **别把 `/__dev` 放进 Vite 的 `server.proxy`**:代理会缓冲无法预知长度的响应,SSE 一个字节都不转发(实测经 1430 为 0 字节)。
   - **浏览器里没有**:原生子 webview(四个 `*_study_preview*`、`open_study_url`)、以及 dialog / opener / clipboard 这些 `plugin:*` 命令(`dispatch` 里没有 → `UNKNOWN_COMMAND`)。这几类只能逻辑层验证,**平台行为留待用户部署后实测,并在总结里说明**。**IME 三个命令有 devbridge 桩**(`list_input_sources` 返回 `[]`、`set_input_source` 立即返回),调用链能走通但 TIS 一行都不执行——所以「切模式卡顿」那类主线程开销在浏览器里**量不到**,只能读 `src-tauri/src/commands/ime.rs` 的实测数据(`cargo test --lib probe_switch_sources -- --nocapture`)。
   - 浏览器里编辑会写进真 vault,跟用户的窗口共用同一份文件——**同一时刻只允许一方在写**。

2. **harness(纯前端、假数据)**:`http://localhost:1430/harness.html`,不需要 Tauri,挂载带全部真实扩展的编辑器 + 内存假仓库,适合确定性断言。钩子:`__view`、`__loadDoc(text)`、`__loadFileDoc(text, path?)`、`__setCursor(line, col)`/`__cursor()`、`__store`/`__api`/`__actions`、`__mountSidebar(entries)`/`__unmountSidebar()`(真卸载,重挂载类场景必用)/`__mountStudyLayout()`;新钩子加在 `src/dev/harness.ts`,模式照抄。起 dev server 前先探测 1430(`harness.html` 返回 200 就直接用,别重复起服务——`strictPort: true`,端口被占会让 `pnpm dev` 退出);HMR 自动生效,改完无需重启。

## 必踩的坑

- `evaluate()` 的沙箱不支持动态 import:要测任意 TS 模块就注入 module script 从 vite 加载真源码,把结果挂到 `window` 再读回。
- CodeMirror 只渲染视口,长文档里 `querySelectorAll(".cw-image")` 会是 0;且 live preview 只在光标**不在**该行时才把图片源码换成 widget——先把光标移到目标行下方再量。
- 图片的 `naturalWidth` 是懒加载 + 异步解码,量之前等 1s 左右,否则读到 0。
- 图标资产必须用浏览器 canvas 栅格化(`toDataURL` 存文件);`qlmanage -t -s N` 会铺**白色不透明背景**,只能目检构图。图标数值用 python PIL 量像素,别目测。
- **harness 的 vim 只走到 `reconfigureVim(view,true,[])`**:store 里的 `settings.vim` 仍是默认 `false`,setup.ts 里那条按 `settings.vim` 自门控的光标冲刷监听器因此整条早退——量 vim 相关开销前先 `__setVim(true)`,否则量到的是少了强制回流的假数据(2026-09 第一次测量就踩了)。同理 `__vimKeys`/`__typeChar` 绕过引擎自己的 inputHandler:同一任务里连发键、或 `__typeChar` 之后紧跟 `<Esc>`,引擎记账会失步(第一个 Esc 被吞、`A` 不动光标),每个键一个 rAF 任务复测才可信。**挂载即 normal 模式**(`__vimMode()` = `"normal"`):走真实 keydown 通道的按键先被引擎解释——Enter 是 `j`(下行,不换行),测"打字/回车"这类文本编辑流程前先 `__setVim(false)`(置后 `__vimMode()` = null),且要在**刚 reload 的页面**上调(被先前实验改过状态的页面会坏:`__setCursor` 抛 `Cannot read properties of undefined`)。

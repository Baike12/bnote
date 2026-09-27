# AGENTS.md — bnote 代理工作约定

**绝对禁止 `git push`**:本仓库只允许本地提交(`git commit`),任何情况下都不许推送到远端——这台机器是公司的,公司禁止把代码推到 GitHub。

## 性能是生命线

bnote 的核心是**手感**:编辑、滚动、光标移动、渲染都不许有可感知的卡顿,也不许有竞争。

- **不许卡顿**:动任何热路径(输入事务、装饰重建、updateListener、measure 周期、滚动)之前,先算清"每次输入/每帧跑几次、读几次布局、会不会强制同步 reflow"。要引入 O(文档长度) 的全量计算,先证明它必要。
- **不许竞争**:同一份状态只允许一个写入者。异步回调(requestMeasure、rAF、setTimeout、微任务、IPC、文件 watcher)拿到结果后必须自证"我还是针对当前这份状态"(比对引用/版本号/文档长度),过期就放弃,不许盲写。
- **用测量说话**:性能问题用确定性测量定位(逐帧记录 DOM/布局/光标位置、事务次数、measure 次数),不许用"看起来还行""应该很快"下结论。

## 修 bug:从第一性原理出发,禁止补丁式修改

出现 bug 时**禁止打补丁**(加特判、加兜底分支、加延时或重试、把症状压住、在调用点加例外)。必须走完这条链:

1. **复现并量化**:用最小可复现输入 + 逐帧/逐事务证据定位到具体代码路径,能说清"哪一行、为什么会这样"。
2. **找到根本原因**:从数据流、时序、几何模型的第一性原理解释现象,而不是从症状倒推一个刚好能盖住它的改动。
3. **按根本原因改**:优先改模型——收敛成唯一的几何来源、唯一的写入者、明确的时序契约——而不是在每个调用点加例外。**该重构就重构**:宁可一次改对,也不要留下互相抵消的补丁。
4. **收尾必须能回答**:为什么同类问题不会再从别的入口复现?答不上来,就说明还没改到根本原因。

## 调试与验证方式(默认必须遵守)

改前端逻辑后**不构建、不部署**(由用户决定,历史上明确过"只调试不构建")。验证在浏览器里做,不抢焦点、不动用户的鼠标键盘;严禁 computer-use / 整屏截图(会占用用户桌面)。驱动一律用**会话内的浏览器**(ZCode 应用内浏览器,走 control-browser 技能那套):自己开标签页(`tabs.new()`)、用 `playwright.evaluate` 读 DOM/量几何;截图偶发拼接伪影,只当参考,**以 DOM 断言和磁盘字节为准**。不许另起 playwright-cli 或别的浏览器工具;用完关掉自己开的标签页,dev server 若是本会话起的就停掉。

**两条回路**

1. **直连真后端(首选)**:`pnpm tauri dev` 跑着时,浏览器打开 `http://localhost:1430/` 就是真应用——和 Tauri 窗口加载的是同一份构建(`devUrl`),缺的 `window.__TAURI_INTERNALS__` 由 `src/dev/browserMode.ts` 用官方 `@tauri-apps/api/mocks` 补上,IPC 指向 `src-tauri/src/devbridge.rs` 在 `127.0.0.1:1439` 上的 debug 口。真 vault、真文件树、真图片(`/__dev/asset` 顶替 `asset://`)、真 watcher(后端事件经 SSE 推给标签页)。
   - **真 vault 在 `/Users/baike3/Documents/baike`**:用户的真实笔记库(日记在 `Daily/YYYY-MM-DD.md`,同步映射在 `.bnote/daily-links.json`)。排查"某某功能把文件写坏了"这类问题就直读这里的文件——磁盘字节比屏幕现象可靠,`diff` 一下就能分清"这次操作写的"和"本来就有的"。
   - **LaTeX 快捷键的参考实现是 Obsidian 那份插件的源码**:`/Users/baike3/Documents/baike/.obsidian/plugins/obsidian-vim-input-auto-switch/`——目录名和内容不符,它 manifest 里的 id 是 `obsidian-latex-suite`(v1.9.4,作者的魔改版:并入 vim 输入法自动切换)。`main.js` 是打包产物但变量名基本保留,改 `src/editor/snippets/` 里任何语义之前先对着它核一遍;用户实际在用的片段配置在该目录的 `data.json`(`snippets` 字段,214 条),bnote 仓库级片段 `.bnote/snippets.js` 就是它的移植。
   - **只有一份后端实现**:`devbridge.rs::dispatch` 把 `{cmd,args}` 转给同一个 `#[tauri::command]`;加命令就在那张 match 表里加分支,不要在 JS 侧另写实现。
   - **别把 `/__dev` 放进 Vite 的 `server.proxy`**:代理会缓冲无法预知长度的响应,SSE 一个字节都不转发(实测经 1430 为 0 字节)。
   - **浏览器里没有**:原生子 webview(四个 `*_study_preview*`、`open_study_url`)、以及 dialog / opener / clipboard 这些 `plugin:*` 命令(`dispatch` 里没有 → `UNKNOWN_COMMAND`)。这几类只能逻辑层验证,**平台行为留待用户部署后实测,并在总结里说明**。**IME 三个命令有 devbridge 桩**(`list_input_sources` 返回 `[]`、`set_input_source` 立即返回),调用链能走通但 TIS 一行都不执行——所以「切模式卡顿」那类主线程开销在浏览器里**量不到**,只能读 `src-tauri/src/commands/ime.rs` 的实测数据(`cargo test --lib probe_switch_sources -- --nocapture`)。
   - 浏览器里编辑会写进真 vault,跟用户的窗口共用同一份文件——**同一时刻只允许一方在写**。

2. **harness(纯前端、假数据)**:`http://localhost:1430/harness.html`,不需要 Tauri,挂载带全部真实扩展的编辑器 + 内存假仓库,适合确定性断言。钩子:`__view`、`__loadDoc(text)`、`__loadFileDoc(text, path?)`、`__setCursor(line, col)`/`__cursor()`、`__store`/`__api`/`__actions`、`__mountSidebar(entries)`/`__unmountSidebar()`(真卸载,重挂载类场景必用)/`__mountStudyLayout()`;新钩子加在 `src/dev/harness.ts`,模式照抄。起 dev server 前先探测 1430(`harness.html` 返回 200 就直接用,别重复起服务——`strictPort: true`,端口被占会让 `pnpm dev` 退出);HMR 自动生效,改完无需重启。

**四个必踩的坑**

- `evaluate()` 的沙箱不支持动态 import:要测任意 TS 模块就注入 module script 从 vite 加载真源码,把结果挂到 `window` 再读回。
- CodeMirror 只渲染视口,长文档里 `querySelectorAll(".cw-image")` 会是 0;且 live preview 只在光标**不在**该行时才把图片源码换成 widget——先把光标移到目标行下方再量。
- 图片的 `naturalWidth` 是懒加载 + 异步解码,量之前等 1s 左右,否则读到 0。
- 图标资产必须用浏览器 canvas 栅格化(`toDataURL` 存文件);`qlmanage -t -s N` 会铺**白色不透明背景**,只能目检构图。图标数值用 python PIL 量像素,别目测。
- **harness 的 vim 只走到 `reconfigureVim(view,true,[])`**:store 里的 `settings.vim` 仍是默认 `false`,setup.ts 里那条按 `settings.vim` 自门控的光标冲刷监听器因此整条早退——量 vim 相关开销前先 `__setVim(true)`,否则量到的是少了强制回流的假数据(2026-09 第一次测量就踩了)。同理 `__vimKeys`/`__typeChar` 绕过引擎自己的 inputHandler:同一任务里连发键、或 `__typeChar` 之后紧跟 `<Esc>`,引擎记账会失步(第一个 Esc 被吞、`A` 不动光标),每个键一个 rAF 任务复测才可信。

## 测试门禁(每次改动必须通过)

收尾前必须跑 **`pnpm gate`** 并通过(= `pnpm lint` + `pnpm typecheck` + `pnpm test`,秒级)。这是"改动完成"的定义之一,与"修 bug 要给出证据"同级。

- **测试写根因,不写症状**:修 bug/改模型时,把根因固化成回归测试放在被测模块旁(`*.test.ts`,vitest node 环境)。范例:`src/editor/motionClamp.test.ts`(隐藏行步进模型)、`src/editor/vim/verticalMotion.test.ts`(vim 运动控制流+记账,用确定性假几何)、`src/editor/livePreview.activity.test.ts`(标记 token 活动规则)。
- **功能完成即建门禁**:所有功能完成之后都要建立充分测试和门禁,以确保日后的其他修改不会导致功能回退——纯逻辑单测锁住行为与不变量(正常流/边界/幂等/双向与解链这类规则),性能敏感路径再加量级门禁;没有测试与门禁的功能不算完成(范例:`src/daily/` 跨文件待办同步,模型/链接/引擎三层各有测试 + perf.gate 有每键开销门禁)。
- **几何/手感改动,门禁之外仍须浏览器测量**:无 DOM 测试只能锁控制流和不变量;真实像素行为(隐藏前缀零宽、widget 命中偏向、视觉锚稳定性)只有浏览器能证明——按上面"调试与验证方式"走 harness 测量,修复前后用同一协议对比。
- **性能门禁,量级回归必拦**:性能是 bnote 的生命线。`src/editor/perf.gate.test.ts` 锁全部高频操作的量级(装饰构建/每击输入/光标移动/toggleList/vim j-k 像素锚定运动/bullet-ordered-todo 列表换行/公式块与代码块的插入和输入——公式输入含 KaTeX 每击渲染,~900 行混合文档);预算按本机实测中位数放大 ~6-10 倍标定——10 倍级回归(意外全文扫描、装饰失稳、解析歧义翻转)必被拦下,机器抖动不误报。动性能敏感路径后先在浏览器实测修复前后对比(同一协议、同一文档),再用门禁锁量级;预算要随实测更新,不许拍脑袋放宽。
- **lint error 拦门禁,warning 不拦但会积累**:新增 warning 要有理由(如引擎适配层的 any 断言、dev 桥的 console.log)。
- **Rust 侧改动**在 `src-tauri` 下跑 `cargo check`,不进 pnpm gate(前端迭代不该付 Rust 编译成本)。

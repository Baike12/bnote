# AGENTS.md — bnote 代理工作约定

## 调试与验证方式(默认必须遵守)

改动前端逻辑后,**不构建、不部署**(是否构建由用户决定,历史上明确过"只调试不构建")。验证一律走下面的浏览器调试回路——它在 ZCode 内置浏览器面板里运行,不抢焦点、不动用户的鼠标键盘,严禁用 computer-use 做这类验证(会占用用户桌面、影响其手头工作)。

### 基础设施

- **vite dev server**:端口 1430(`pnpm dev`)。启动前先探测是否已在跑(别的会话可能开着):`curl -s -o /dev/null -w "%{http_code}" http://localhost:1430/harness.html`,返回 200 就直接用,不要重复起服务(1430 被 占用会使 `pnpm dev` 报错退出)。HMR 自动生效,改完代码无需重启。
- **编辑器 harness**:`http://localhost:1430/harness.html`(`harness.html` + `src/dev/harness.ts`),在纯浏览器环境挂载带全部真实扩展(CodeMirror、livePreview、vim、公式渲染、global.css)的编辑器实例,不需要 Tauri。暴露的钩子:
  - `__view` — EditorView 实例(读 `__view.state.doc.toString()`、selection 等)
  - `__loadDoc(text)` — 替换整个文档
  - `__setCursor(line, col)` / `__cursor()` — 设置/读取光标
  - `__toggleTodo()` — 直接调用 ops.toggleTodo(新增调试钩子也加在 `src/dev/harness.ts`,模式照抄)

### 驱动方式

全部通过 `mcp__node_repl__js`(browser-use 的 `agent.browsers` API,先加载 `browser-use:control-browser` 技能,bootstrap + `getForUrl("http://localhost:1430/...")`)。每次 `js` 调用都是全新内核:先 bootstrap,再 `tabs.list()` 找已有标签,找不到才 `tabs.new()`;用完 `tab.close()`。

典型回路:

1. **编辑器行为验证(确定性断言,优先用这个)**:`evaluate()` 里 `__loadDoc` 造测试文档 → `__setCursor` → 调用被测钩子 → 读回 `__view.state.doc.toString()` 逐行断言。截图只留给"看渲染效果"(颜色、布局、字形),看到关键状态时用 `nodeRepl.emitImage(await tab.screenshot())`。
2. **纯函数 / 任意 TS 模块**:`evaluate()` 的沙箱**不支持动态 import**,改为向页面注入 module script,从 vite 加载真实源码模块,把结果挂到 `window`,再一次 `evaluate` 读回:
   ```js
   const s = document.createElement("script");
   s.type = "module";
   s.textContent = `const m = await import("/src/lib/fuzzy.ts");
                    window.__result = { ...测试... }; window.__ready = true;`;
   document.head.appendChild(s);
   ```
3. **完整 App 级交互**(侧边栏、弹窗):dev server 根路径 `http://localhost:1430/` 就是完整应用,可用 playwright locator 点击驱动;但打开仓库依赖 Tauri 对话框,浏览器里没有 vault。
4. **图标 / SVG**:最终资产必须用浏览器 canvas 栅格化(把 SVG 画进 1024 canvas,`toDataURL` 读回 base64 存文件)——`qlmanage -t -s N` 渲染快但会铺**白色不透明背景**,只能用来目检构图,不能当最终 PNG。图标数值(对齐、留边)用 python PIL 对渲染结果做像素测量,别靠目测。

### 边界

- `src-tauri` 的能力(`setInputSource`/TIS、dialog、文件 watcher)在浏览器里不存在:涉及系统输入法、原生对话框的功能只能逻辑层在浏览器验证,平台行为留待用户部署后实测,并在总结里明确说明这一点。
- 验证完关闭自己打开的标签页;dev server 若是本会话起的,结束时停掉。

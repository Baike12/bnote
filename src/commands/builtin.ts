import { openUrl } from "@tauri-apps/plugin-opener";
import { registerCommands, runCommand, type CommandDef } from "./registry";
import { cycleQuickSwitcher } from "@/components/QuickSwitcher";
import { getView } from "@/editor/api";
import {
  cycleHeading,
  insertCallout,
  insertCodeBlock,
  insertHorizontalRule,
  insertInlineCode,
  insertInlineMath,
  insertMathBlock,
  jumpHeaderTodos,
  toggleHeading,
  toggleList,
  toggleTodo,
  toggleWrap,
} from "@/editor/ops";
import { setSearchQuery, SearchQuery } from "@codemirror/search";
import { configureLivePreview } from "@/editor/livePreview";
import { renumberHeadings } from "@/editor/numbering";
import * as actions from "@/app/actions";
import { openNewDrawing, openDrawingFile, finalizeDrawingSession } from "@/app/drawing";
import { useAppStore, toggleProjectsMode, toggleStudyMode } from "@/state/appStore";
import { focusAdjacentProject } from "@/projects/store";
import { isProjectPath } from "@/projects/model";
import { sendTodoWithToast } from "@/projects/send";
import { documentPath } from "@/editor/docPath";
import { ensureLinks } from "@/daily/links";
import { sendTodoToDaily } from "@/daily/engine";
import { openTodayDailyNote } from "@/daily/open";
import { runtimeDeps } from "@/daily/runtime";
import { createUvEnvForCurrentProject, runCurrentNote, stopRun } from "@/python/run";
import { resetLspStateForPath, syncNow } from "@/python/lsp";
import { agentApi, api } from "@/lib/tauri";
import { canFlipPdfPage, flipPdfPage } from "@/study/pdfNav";
import { capturePdfSnapshot, hasPdfSnapshotSource } from "@/study/pdfSnapshot";
import { DEFAULT_WEB_ZOOM, stepWebZoom } from "@/study/webZoom";
import { fileToAgentImage } from "@/study/agentImages";
import { WEREAD_HOME_URL } from "@/study/weread";
import { setActiveKeyRegion } from "./globalKeys";

/** 中栏是否开着网页(缩放键只在这种时候接管 ⌘= / ⌘- / ⌘0)。 */
function hasWebPreview(): boolean {
  return useAppStore.getState().studyContent?.kind === "url";
}

/** 写入者是设置:ContentPane 订阅它,再推给原生子 webview(见 setStudyPreviewZoom)。 */
function applyWebZoom(direction: 1 | -1): void {
  const { settings, patchSettings } = useAppStore.getState();
  patchSettings({ studyWebZoom: stepWebZoom(settings.studyWebZoom, direction) });
}

/**
 * 把焦点交回阅读区;网页在原生子 webview 里时交给它。
 *
 * 同时直接写入键盘归属:网页分支的焦点落在原生子 webview 上,主窗口的
 * pointerdown/focusin 永远收不到,区域归属会一直停在笔记区 / Agent——之后
 * 主窗口接到的按键就按错的区域解析(⌘E 会被笔记区自带的实时预览开关吃掉)。
 * 命令是用户按键的直接结果,它本身就是「最近一次动手」。
 */
function focusReadingPane() {
  const focusPane = () => {
    document
      .querySelector<HTMLElement>('[data-key-region="reading"]')
      ?.focus({ preventScroll: true });
  };
  setActiveKeyRegion("reading");
  if (useAppStore.getState().studyContent?.kind === "url") {
    // 先结束主窗口的编辑态:编辑器(contenteditable)在编辑时,窗口的第一响应者
    // 是它内部的字段编辑器;不 resign 就直接把第一响应者换成原生子 webview 会
    // 被挡下,键盘留在主窗口——之后的按键全部按旧区域解析。
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    // 浏览器模式没有原生视图,命令不存在 → 退回 DOM 占位区(区域判定仍成立)。
    void agentApi.focusStudyPreview().catch(focusPane);
    return;
  }
  focusPane();
}

function withView(fn: (view: NonNullable<ReturnType<typeof getView>>) => void) {
  return () => {
    const view = getView();
    if (!view) {
      useAppStore.getState().showToast("没有活动的编辑器");
      return;
    }
    fn(view);
    view.focus();
  };
}

/** 标题改动后的自动编号收尾：主光标行的标题被摘掉时清掉残留编号，再全文重排。 */
function settleHeadingNumbering(
  view: NonNullable<ReturnType<typeof getView>>,
  lineFrom: number,
  headingRemoved: boolean,
) {
  if (!useAppStore.getState().settings.autoNumberHeadings) return;
  if (headingRemoved) {
    const after = view.state.doc.lineAt(Math.min(lineFrom, view.state.doc.length));
    const m = /^(\d+(?:\.\d+)*[ \t]+)/.exec(after.text);
    if (m) view.dispatch({ changes: { from: after.from, to: after.from + m[1].length, insert: "" } });
  }
  renumberHeadings(view);
}

/** 学习助手面板是否在场:三栏布局里常驻,进入学习模式即可用。 */
function agentPanelActive(): boolean {
  return useAppStore.getState().studyMode;
}

const defs: CommandDef[] = [
  // ---- workspace ----
  {
    id: "workspace.open-vault",
    title: "打开仓库文件夹",
    category: "工作区",
    run: async () => {
      const path = await actions.pickVaultDialog();
      if (path) await actions.openVault(path);
    },
  },
  {
    id: "workspace.switch-recent-vault",
    title: "切换到最近打开的仓库(⌘⇧R)",
    category: "工作区",
    run: () => void actions.switchRecentVault(),
  },
  {
    id: "workspace.open-daily",
    title: "打开今日日记(⌘⇧O,日记内再按跳回)",
    category: "工作区",
    run: () => void openTodayDailyNote(),
  },
  {
    id: "workspace.capture-todo",
    title: "快速待办:添加到今日日记最前(⌘⇧K)",
    category: "工作区",
    run: () => useAppStore.getState().setModal("quicktodo"),
  },
  { id: "workspace.new-note", title: "新建笔记", category: "工作区", run: () => void actions.newNote() },
  {
    id: "workspace.quick-add",
    title: "快速添加文件",
    category: "工作区",
    run: () => useAppStore.getState().setModal("quickadd"),
  },
  {
    id: "workspace.new-folder",
    title: "新建文件夹",
    category: "工作区",
    run: () => void actions.newFolder(),
  },
  {
    id: "workspace.save-note",
    keepsPageFocus: true,
    title: "保存当前笔记",
    category: "工作区",
    run: () => void actions.saveNote(),
  },
  {
    id: "workspace.open-drawing",
    title: "画图:打开画布,回到笔记时插入光标处",
    category: "工作区",
    run: () => void openNewDrawing(),
  },
  {
    id: "workspace.finish-drawing",
    title: "完成画图:回到笔记并插入刚画的图(⌘↩)",
    category: "工作区",
    run: () => {
      if (useAppStore.getState().drawingSession) void finalizeDrawingSession();
    },
  },
  {
    id: "workspace.save-note-and-close",
    title: "保存并关闭窗口",
    category: "工作区",
    run: async () => {
      await actions.saveNote();
      runCommand("workspace.close-window");
    },
  },
  {
    id: "workspace.close-window",
    title: "关闭窗口",
    category: "工作区",
    run: () => {
      import("@tauri-apps/api/window").then((m) => m.getCurrentWindow().close());
    },
  },
  {
    id: "view.toggle-study-mode",
    title: "进入 / 退出学习模式(左问 agent、中看内容、右记笔记)",
    category: "视图",
    run: () => {
      toggleStudyMode();
    },
  },
  {
    id: "view.toggle-projects",
    title: "进入 / 退出项目管理(项目列表、项目待办、日记)",
    category: "视图",
    run: () => {
      toggleProjectsMode();
    },
  },
  // ---- 项目管理(project 区域) ----
  // 组件私有状态通过窗口事件交给视图:命令层不持有卡片轮播的 DOM 与编辑器
  // 实例,只发「把焦点交给谁」的信号(与 agentPanelCommand 同一分工)。
  {
    id: "region.focus-project",
    title: "聚焦项目卡片",
    category: "区域",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:focus-project"));
    },
  },
  {
    id: "project.next",
    title: "下一个项目",
    category: "项目",
    run: () => {
      focusAdjacentProject(1);
    },
  },
  {
    id: "project.prev",
    title: "上一个项目",
    category: "项目",
    run: () => {
      focusAdjacentProject(-1);
    },
  },
  {
    id: "project.new",
    title: "新建项目",
    category: "项目",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:new-project"));
    },
  },
  {
    id: "project.focus-daily",
    title: "聚焦日记区",
    category: "项目",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:focus-daily"));
    },
  },
  {
    id: "project.send-todo",
    title: "把当前待办发送到今日日记最前",
    category: "项目",
    run: withView((v) => {
      const path = documentPath(v.state);
      if (!path || !isProjectPath(path)) {
        useAppStore.getState().showToast("当前不是项目卡片");
        return;
      }
      const line = v.state.doc.lineAt(v.state.selection.main.head).number;
      void sendTodoWithToast({ srcPath: path, line });
    }),
  },
  {
    id: "view.open-weread",
    title: "打开微信读书(书架 / 商城 / 阅读,进学习模式)",
    category: "视图",
    run: () => {
      const store = useAppStore.getState();
      if (!store.studyMode) store.setStudyMode(true);
      store.setStudyContent({ kind: "url", url: WEREAD_HOME_URL, title: "微信读书" });
    },
  },
  // 学习模式翻页(按设置里的步长滚动,默认半屏)。默认 PageUp/PageDown(含
  // 方向键),可在设置里改键;动作由阅读器注册(study/pdfNav.ts),没开
  // PDF/网页或焦点不该被抢时 when 为 false,键原样交给页面。
  //
  // 键位配在阅读区,带修饰键的和弦跨区域生效(keys.ts 的 REGION_FREE_COMMANDS):
  // 在笔记区或 Agent 面板按它同样滚动。翻页**不动焦点**:焦点在哪就留在哪,
  // 笔记区里连按 ⌃J 仍然是继续翻页,打完字也不用再点回编辑器。
  {
    id: "study.pdf-prev-page",
    title: "学习模式上一页(按步长滚动)",
    category: "学习",
    when: canFlipPdfPage,
    run: () => {
      void flipPdfPage(-1);
    },
  },
  {
    id: "study.pdf-next-page",
    title: "学习模式下一页(按步长滚动)",
    category: "学习",
    when: canFlipPdfPage,
    run: () => {
      void flipPdfPage(1);
    },
  },
  {
    id: "study.pdf-snap-to-agent",
    title: "学习模式:截取阅读区可见内容到学习助手(⌘⇧E)",
    category: "学习",
    when: () =>
      useAppStore.getState().studyMode &&
      useAppStore.getState().studyContent?.kind === "pdf" &&
      hasPdfSnapshotSource(),
    // 截图与投递都走前端:页面本来就是 canvas,不需要系统截图权限,也不经过
    // 剪贴板——直接变成附件排进输入框,和手动粘贴截图同一条管道。助手面板
    // 在三栏布局里常驻,不需要先切页签。
    run: async () => {
      const store = useAppStore.getState();
      try {
        const file = await capturePdfSnapshot();
        if (!file) {
          store.showToast("阅读区还没有渲染出页面,稍后再试");
          return;
        }
        const image = await fileToAgentImage(file, file.type);
        store.runAgentPanelCommand("attach-images", [image]);
      } catch (e) {
        store.showToast(`截图失败: ${String(e)}`);
      }
    },
  },
  {
    id: "study.web-zoom-in",
    title: "放大网页(⌘=)",
    category: "学习",
    when: hasWebPreview,
    keepsPageFocus: true,
    run: () => applyWebZoom(1),
  },
  {
    id: "study.web-zoom-out",
    title: "缩小网页(⌘-)",
    category: "学习",
    when: hasWebPreview,
    keepsPageFocus: true,
    run: () => applyWebZoom(-1),
  },
  {
    id: "study.web-zoom-reset",
    title: "网页缩放回到 100%(⌘0)",
    category: "学习",
    when: hasWebPreview,
    keepsPageFocus: true,
    run: () => useAppStore.getState().patchSettings({ studyWebZoom: DEFAULT_WEB_ZOOM }),
  },
  {
    id: "study.agent-switch-session",
    title: "学习助手:切换 主会话/辅助会话(⌘⇧Y)",
    category: "学习",
    run: () => useAppStore.getState().bumpAgentSwitchSessionSignal(),
  },
  // ---- 三个可聚焦区域之间互相切换 ----
  // 同一组命令在多个区域各有一份默认键位(见 commands/keys.ts 的
  // REGION_PLACEMENT):⌘⌥A/N/R = Agent / 笔记区 / 阅读区。网页/微信读书里的
  // 按键由页内运行时经 title 通道转回主窗口(见 study/webAnnotations.ts)。
  {
    id: "region.focus-agent",
    title: "聚焦学习助手输入框",
    category: "区域切换",
    when: () => useAppStore.getState().studyMode,
    run: () => useAppStore.getState().runAgentPanelCommand("focus-input"),
  },
  {
    id: "region.focus-notes",
    title: "聚焦笔记区编辑器",
    category: "区域切换",
    run: () => {
      // 编辑器一直可见(三栏常驻),聚焦后焦点事件会把键盘归属带过来。
      requestAnimationFrame(() => getView()?.focus());
    },
  },
  {
    id: "region.focus-reading",
    title: "切换到阅读区(PDF / 网页)",
    category: "区域切换",
    when: () => useAppStore.getState().studyMode,
    // 中栏一直可见,不需要切页签;只要把焦点从编辑器/输入框交还给阅读区。
    run: focusReadingPane,
  },
  // ---- 学习助手面板内的会话操作 ----
  {
    id: "agent.toggle-creative",
    title: "学习助手:切换创作模式(生成 HTML 实时预览)",
    category: "学习助手",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("toggle-creative"),
  },
  {
    id: "agent.new-session",
    title: "学习助手:新建一个全新会话",
    category: "学习助手",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("new"),
  },
  {
    id: "agent.fork-session",
    title: "学习助手:从当前会话分叉出一个新会话",
    category: "学习助手",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("fork"),
  },
  {
    id: "agent.back-from-fork",
    title: "学习助手:从分叉会话返回上一条会话",
    category: "学习助手",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("back"),
  },
  {
    id: "agent.focus-history",
    title: "学习助手:打开并聚焦历史会话列表",
    category: "学习助手",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("history"),
  },
  {
    id: "workspace.open-settings",
    title: "打开设置",
    category: "工作区",
    run: () => useAppStore.getState().setModal("settings"),
  },

  // ---- navigation ----
  {
    id: "nav.quick-switcher",
    title: "快速跳转到文件",
    category: "导航",
    run: () => {
      const { modal } = useAppStore.getState();
      // Chord repeat while the switcher is open cycles the list (hold ⌘S…).
      if (modal === "switcher") cycleQuickSwitcher(1);
      else useAppStore.getState().setModal("switcher");
    },
  },
  {
    id: "nav.back-link",
    title: "回退到链接跳转前的文件",
    category: "导航",
    run: () => actions.goBackLink(),
  },
  {
    id: "nav.command-palette",
    title: "命令面板",
    category: "导航",
    run: () => useAppStore.getState().setModal("palette"),
  },
  {
    id: "nav.toggle-sidebar",
    title: "显示/隐藏侧边栏",
    category: "导航",
    // ⌘\ 从收起态展开 = 打开 + 把焦点落到当前打开的文件行(走 focusSidebar 的
    // 一次性票据,落到文件行的露出逻辑与 ⌘I 同一条路径);再按就是收起。
    // 顶栏按钮仍用 store.toggleSidebar——鼠标瞄一眼树,不该抢走编辑器焦点。
    run: () => {
      const s = useAppStore.getState();
      if (s.sidebarOpen) s.toggleSidebar();
      else s.focusSidebar();
    },
  },
  {
    id: "nav.focus-sidebar",
    title: "聚焦侧边栏",
    category: "导航",
    run: () => useAppStore.getState().focusSidebar(),
  },
  {
    id: "nav.header-todos",
    title: "跳到头部疑问待办 / 返回原位置",
    category: "导航",
    run: withView((v) => jumpHeaderTodos(v)),
  },

  // ---- editing ----
  { id: "edit.insert-math-block", title: "插入公式块", category: "编辑", run: withView(insertMathBlock) },
  { id: "edit.insert-inline-math", title: "插入行内公式", category: "编辑", run: withView(insertInlineMath) },
  { id: "edit.insert-code-block", title: "插入代码块", category: "编辑", run: withView(insertCodeBlock) },
  { id: "edit.insert-inline-code", title: "插入行内代码", category: "编辑", run: withView(insertInlineCode) },
  {
    id: "edit.insert-callout",
    title: "插入 Callout 块 / 跳到关联块",
    category: "编辑",
    // 三种行止:有选区 = 文末开一个以选中文字为标题的块(原文成锚点,渲染成
    // 下划虚线);光标在锚点上或在块内(有来处)= 跳转/回跳;其余 = 就地开空块。
    run: withView(insertCallout),
  },
  {
    id: "edit.insert-wikilink",
    title: "插入内部链接 / 跳到本行链接",
    category: "编辑",
    // 不走 withView：光标行有链接就跳转，没有就在光标处开补全面板——面板自己管焦点。
    run: () => {
      const view = getView();
      if (!view) {
        useAppStore.getState().showToast("没有活动的编辑器");
        return;
      }
      actions.linkShortcut(view);
    },
  },
  {
    id: "edit.insert-horizontal-rule",
    title: "插入分割线",
    category: "编辑",
    run: withView(insertHorizontalRule),
  },
  { id: "edit.toggle-bold", title: "加粗", category: "编辑", run: withView((v) => toggleWrap(v, "**")) },
  { id: "edit.toggle-italic", title: "斜体", category: "编辑", run: withView((v) => toggleWrap(v, "*")) },
  {
    id: "edit.toggle-strikethrough",
    title: "删除线",
    category: "编辑",
    run: withView((v) => toggleWrap(v, "~~")),
  },
  { id: "edit.toggle-todo", title: "切换当前行待办状态", category: "编辑", run: withView(toggleTodo) },
  {
    id: "edit.todo-to-daily",
    title: "待办发送到今日日记(此后两侧自动保持同步,⌘⇧J)",
    category: "编辑",
    run: withView((v) => {
      void (async () => {
        const vaultRoot = useAppStore.getState().vaultPath;
        if (!vaultRoot) {
          useAppStore.getState().showToast("没有打开仓库");
          return;
        }
        const store = await ensureLinks(vaultRoot);
        await sendTodoToDaily(v, runtimeDeps(), store);
      })().catch((e) => useAppStore.getState().showToast(`发送失败: ${String(e)}`));
    }),
  },
  { id: "edit.toggle-bullet-list", title: "无序列表:切换当前行项目符号", category: "编辑", run: withView((v) => toggleList(v, "bullet")) },
  {
    id: "edit.toggle-numbered-list",
    title: "有序列表:切换当前行编号",
    category: "编辑",
    run: withView((v) => toggleList(v, "numbered")),
  },
  {
    id: "edit.toggle-heading",
    title: "标题层级循环：正文 → H1 → H2 → H3 → H4 → 正文",
    category: "编辑",
    run: withView((v) => {
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const existing = line.text.match(/^(#{1,6})(\s+|$)/);
      // 下一档落在正文（H4 及更深的既有标题）时才需要清残留编号。
      const headingRemoved = !!existing && existing[1].length >= 4;
      cycleHeading(v);
      settleHeadingNumbering(v, line.from, headingRemoved);
    }),
  },
  ...([1, 2, 3, 4, 5, 6] as const).map((level): CommandDef => ({
    id: `edit.heading-${level}`,
    title: `设为 ${level} 级标题`,
    category: "编辑",
    run: withView((v) => {
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const headingRemoved = new RegExp(`^${"#".repeat(level)}(?:\\s|$)`).test(line.text);
      toggleHeading(v, level);
      settleHeadingNumbering(v, line.from, headingRemoved);
    }),
  })),

  // ---- editor toggles ----
  {
    id: "editor.toggle-live-preview",
    keepsPageFocus: true,
    title: "切换实时渲染/源码模式",
    category: "编辑器",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ livePreview: !settings.livePreview });
    },
  },
  {
    id: "editor.toggle-vim",
    keepsPageFocus: true,
    title: "切换 Vim 模式",
    category: "编辑器",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ vim: !settings.vim });
    },
  },
  {
    id: "editor.toggle-typewriter",
    keepsPageFocus: true,
    title: "切换打字机模式",
    category: "编辑器",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ typewriter: !settings.typewriter });
    },
  },
  {
    id: "editor.toggle-snippets",
    keepsPageFocus: true,
    title: "切换 LaTeX 快捷片段",
    category: "编辑器",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ snippets: !settings.snippets });
    },
  },
  {
    id: "editor.clear-search-highlight",
    title: "清除搜索高亮",
    category: "编辑器",
    run: () => {
      const view = getView();
      if (view) view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    },
  },

  // ---- python:markdown 内嵌代码块 ----
  {
    id: "python.run-note",
    title: "Python: 把当前笔记当一个 py 文件运行(⌘↩)",
    category: "Python",
    run: () => void runCurrentNote(),
  },
  {
    id: "python.run-stop",
    title: "Python: 停止当前运行",
    category: "Python",
    run: () => void stopRun(),
  },
  {
    id: "python.toggle-lsp",
    title: "Python: 开/关当前项目的 ty 类型检查(LSP)",
    category: "Python",
    run: async () => {
      const mdPath = useAppStore.getState().currentFile;
      const view = getView();
      if (!mdPath || !view) {
        useAppStore.getState().showToast("没有打开的笔记");
        return;
      }
      try {
        const info = await api.pythonGetInfo(mdPath);
        const next = info.lsp === "ty" ? "off" : "ty";
        await api.pythonSetProjectConfig(mdPath, { lsp: next });
        resetLspStateForPath(mdPath);
        if (next === "ty") syncNow(view);
        const proj = info.projectName || "(vault 根)";
        useAppStore
          .getState()
          .showToast(
            next === "ty"
              ? `项目「${proj}」ty 类型检查已开启`
              : `项目「${proj}」ty 类型检查已关闭`,
          );
      } catch (e) {
        useAppStore.getState().showToast(`切换失败: ${String(e)}`);
      }
    },
  },
  {
    id: "python.create-uv-env",
    title: "Python: 为当前项目创建 uv 环境",
    category: "Python",
    run: () => void createUvEnvForCurrentProject(),
  },
  {
    id: "edit.insert-python-block",
    title: "插入 Python 代码块",
    category: "编辑",
    run: withView((v) => insertCodeBlock(v, "python")),
  },

  // ---- view ----
  {
    id: "view.zoom-in",
    keepsPageFocus: true,
    title: "放大编辑区字号",
    category: "视图",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ fontSize: Math.min(28, settings.fontSize + 1) });
    },
  },
  {
    id: "view.zoom-out",
    keepsPageFocus: true,
    title: "缩小编辑区字号",
    category: "视图",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ fontSize: Math.max(12, settings.fontSize - 1) });
    },
  },
  {
    id: "view.zoom-reset",
    keepsPageFocus: true,
    title: "重置编辑区字号",
    category: "视图",
    run: () => {
      useAppStore.getState().patchSettings({ fontSize: 16 });
    },
  },
];

registerCommands(defs);

// Rendered wikilink / external link clicks from the live preview.
configureLivePreview({
  openWikiLink: (target) => actions.openWikiLink(target),
  openExternalUrl: (url) => {
    void openUrl(url).catch((e) => console.warn("open url failed", e));
  },
  // 点击画图嵌入的预览图:打开画布继续编辑。
  openDrawing: (path) => openDrawingFile(path),
});

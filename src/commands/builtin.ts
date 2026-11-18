import { openUrl } from "@tauri-apps/plugin-opener";
import { registerCommands, runCommand, type CommandDef } from "./registry";
import { setActiveKeyRegion } from "./globalKeys";
import { cycleQuickSwitcher } from "@/lib/switcherSignal";
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
  promoteHeading,
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
import {
  useAppStore,
  toggleCodeMode,
  toggleProjectsMode,
  toggleStudyMode,
  toggleInvestMode,
} from "@/state/appStore";
import { quitApp } from "@/app/quit";
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
import { api } from "@/lib/tauri";
import { canFlipPdfPage, flipPdfPage } from "@/study/pdfNav";
import { useFocusStore } from "@/focus/store";
import { capturePdfSnapshot, hasPdfSnapshotSource } from "@/study/pdfSnapshot";
import { DEFAULT_WEB_ZOOM, stepWebZoom } from "@/study/webZoom";
import { fileToAgentImage } from "@/study/agentImages";
import { WEREAD_HOME_URL } from "@/study/weread";
import { codeCommandDefs, focusCodeContent, quoteCodeSelection } from "@/code/commands";
import { flushPerf } from "@/perf/sink";
import { perfStats, startFullTrace, stopFullTrace } from "@/perf/trace";

/** Whether the middle column has a web page open (only then do the zoom keys take over ⌘= / ⌘- / ⌘0). */
function hasWebPreview(): boolean {
  return useAppStore.getState().studyContent?.kind === "url";
}

/** The writer is the settings: ContentPane subscribes to it and pushes it into the native child webview (see setStudyPreviewZoom). */
function applyWebZoom(direction: 1 | -1): void {
  const { settings, patchSettings } = useAppStore.getState();
  patchSettings({ studyWebZoom: stepWebZoom(settings.studyWebZoom, direction) });
}

/** Whether the current layout mounts the agent panel (the focus target of ⌘⌥A). */
function hasAgentPanel(): boolean {
  const mode = useAppStore.getState().mode;
  // Invest mode mounts the agent panel in the middle column (list | agent-or-market | notes).
  return mode === "study" || mode === "code" || mode === "invest";
}

/**
 * Put the content column back in the middle — and, in code mode, the caret back
 * into the open file.
 *
 * The two layouts differ in what the content column is. Study mode's middle
 * column is a PDF / web page: it is read, not typed into, so the command must
 * not move the keyboard (the notes editor / Agent input keep it exactly where
 * the user left it, and the native web preview does not need a hand-off either
 * — StudyLayout re-reports its bounds on every swap, so the page follows the
 * layout with the first responder untouched). Code mode's content column is a
 * CodeMirror editor, so there the command really does focus it.
 */
function focusContentArea() {
  const store = useAppStore.getState();
  // The middle column follows the explicit switch: the content column comes
  // back to the middle even if the assistant was there.
  store.setMainColumn("content");
  if (store.mode === "code") focusCodeContent();
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

/** Finishing the auto-numbering after a heading change: when the heading on the main cursor line was removed, drop the leftover number, then renumber the whole document. */
function settleHeadingNumbering(
  view: NonNullable<ReturnType<typeof getView>>,
  lineFrom: number,
  headingRemoved: boolean,
) {
  if (!useAppStore.getState().settings.autoNumberHeadings) return;
  if (headingRemoved) {
    const after = view.state.doc.lineAt(Math.min(lineFrom, view.state.doc.length));
    const m = /^(\d+(?:\.\d+)*[ \t]+)/.exec(after.text);
    if (m)
      view.dispatch({ changes: { from: after.from, to: after.from + m[1].length, insert: "" } });
  }
  renumberHeadings(view);
}

/**
 * Whether the assistant panel is there to act on. Both three-column layouts
 * mount it (study and code), so the panel actions — new / fork / back /
 * history / creative — apply in both.
 *
 * This used to be `mode === "study"`, which made ⌘N in code mode fall through
 * to the global "new note": the fork binding existed but its `when` was false,
 * so the dispatcher moved on to the next candidate and created a note
 * (observed).
 */
function agentPanelActive(): boolean {
  return hasAgentPanel();
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
  {
    id: "workspace.new-note",
    title: "新建笔记",
    category: "工作区",
    run: () => void actions.newNote(),
  },
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
  // ---- diagnostics (performance) ----
  {
    id: "diag.perf-start",
    title: "开始详细追踪 2 分钟",
    category: "工作区",
    run: () => {
      startFullTrace(120);
      useAppStore
        .getState()
        .showToast("性能追踪已开始（2 分钟）：慢键、长任务与各阶段耗时会写入 .bnote/perf/");
    },
  },
  {
    id: "diag.perf-stop",
    title: "停止详细追踪并打印汇总",
    category: "工作区",
    run: () => {
      stopFullTrace();
      const stats = perfStats();
      console.table(stats);
      useAppStore
        .getState()
        .showToast(
          stats.length > 0
            ? `性能追踪已停止：最慢阶段 ${stats[0].name} ${stats[0].max}ms`
            : "性能追踪已停止",
        );
    },
  },
  {
    id: "diag.perf-flush",
    title: "立即写入日志文件",
    category: "工作区",
    run: async () => {
      await flushPerf();
      useAppStore.getState().showToast("性能日志已写入 .bnote/perf/");
    },
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
    // The macOS menu carries no ⌘Q key equivalent (see lib.rs::install_menu),
    // so the quit chord lives here with every other binding (⌘Q by default).
    // The native menu's Quit item goes through the same flush-then-destroy path.
    id: "app.quit",
    title: "退出应用",
    category: "工作区",
    run: quitApp,
  },
  {
    id: "view.toggle-study-mode",
    title: "进入 / 退出三栏工作区(左 Agent、中内容、右笔记)",
    category: "视图",
    run: () => {
      toggleStudyMode();
    },
  },
  {
    // Code mode is its own mode (agent | code | notes), unrelated to the vault.
    // Deliberately unbound by default: ⌘⇧C is "insert code block" in the notes
    // region; bind this command yourself in keybindings.json if you want a key.
    id: "view.toggle-code-mode",
    title: "进入 / 退出代码模式(左 Agent、中代码、右笔记)",
    category: "视图",
    run: () => {
      toggleCodeMode();
    },
  },
  {
    id: "view.toggle-projects",
    title: "进入 / 退出项目区(项目列表、项目待办、日记)",
    category: "视图",
    run: () => {
      toggleProjectsMode();
    },
  },
  {
    id: "view.toggle-invest-mode",
    title: "进入 / 退出投资模式(左标的、中 K 线与详情、右笔记;⌘⌥←/→切换标的)",
    category: "视图",
    run: () => {
      toggleInvestMode();
    },
  },
  // ---- Focus mode (pomodoro + exclusive lock) ----
  // The command only forwards: the timer state has exactly one writer in
  // focus/store.ts (see the "single writer" note there). One pomodoro is one
  // continuous stretch of focus: no break segment, no pause, no ending early
  // — the only mid-session operation is "start". So there is exactly one
  // command here and no entry point for exiting or changing the lock.
  {
    id: "focus.pomodoro-start",
    title: "专注:开始番茄钟(第一个时长;独占屏幕 + 硬锁,结束前不能退出)",
    category: "专注",
    // The keyboard path has no chip to read a length from: it uses the first
    // configured duration (see focus/timer.ts::startTimer).
    run: () => void useFocusStore.getState().start(),
  },
  // ---- Project management (project region) ----
  // The component's private state reaches the view through a window event:
  // the command layer holds neither the card carousel's DOM nor the editor
  // instance, it only emits the "who gets the focus" signal (the same split
  // of duties as agentPanelCommand).
  {
    id: "region.focus-project",
    title: "切换到项目区",
    category: "区域切换",
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
    id: "project.delete",
    title: "删除当前项目(整份项目文件进废纸篓,可恢复)",
    category: "项目",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:delete-project"));
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
    title: "打开微信读书(书架 / 商城 / 阅读,进三栏工作区)",
    category: "视图",
    run: () => {
      const store = useAppStore.getState();
      if (store.mode !== "study") store.setMode("study");
      store.setStudyContent({ kind: "url", url: WEREAD_HOME_URL, title: "微信读书" });
    },
  },
  // Study mode paging (scrolls by the step from settings, half a screen by
  // default). The default is PageUp/PageDown (including the arrow keys) and
  // can be rebound in the settings; the action is registered by the reader
  // (study/pdfNav.ts), and when no PDF/web page is open or the focus should
  // not be taken, `when` is false and the key is passed through to the page.
  //
  // The binding is configured in the reading region and a modified chord
  // takes effect across regions (REGION_FREE_COMMANDS in keys.ts): pressing
  // it in the notes region or the Agent panel scrolls just the same. Paging
  // **does not move the focus**: the focus stays wherever it is, so pressing
  // ⌃J repeatedly inside the notes region keeps paging, and after typing you
  // do not have to click back into the editor.
  {
    id: "study.pdf-prev-page",
    title: "上一页(按步长滚动)",
    category: "内容区",
    when: canFlipPdfPage,
    run: () => {
      void flipPdfPage(-1);
    },
  },
  {
    id: "study.pdf-next-page",
    title: "下一页(按步长滚动)",
    category: "内容区",
    when: canFlipPdfPage,
    run: () => {
      void flipPdfPage(1);
    },
  },
  {
    id: "study.pdf-snap-to-agent",
    title: "截取内容区可见内容到 Agent(⌘⇧E)",
    category: "内容区",
    when: () =>
      useAppStore.getState().mode === "study" &&
      useAppStore.getState().studyContent?.kind === "pdf" &&
      hasPdfSnapshotSource(),
    // Both the capture and the delivery go through the front end: the page
    // is a canvas anyway, so no system screenshot permission is needed and
    // the clipboard is bypassed — the result becomes an attachment queued in
    // the input, the very same pipeline as a manually pasted screenshot. The
    // assistant panel is always mounted in the three-column layout, so there
    // is no need to switch tabs first.
    run: async () => {
      const store = useAppStore.getState();
      try {
        const file = await capturePdfSnapshot();
        if (!file) {
          store.showToast("内容区还没有渲染出页面,稍后再试");
          return;
        }
        const image = await fileToAgentImage(file, file.type);
        store.runAgentPanelCommand("attach-images", { images: [image] });
      } catch (e) {
        store.showToast(`截图失败: ${String(e)}`);
      }
    },
  },
  {
    id: "study.web-zoom-in",
    title: "放大网页(⌘=)",
    category: "内容区",
    when: hasWebPreview,
    keepsPageFocus: true,
    run: () => applyWebZoom(1),
  },
  {
    id: "study.web-zoom-out",
    title: "缩小网页(⌘-)",
    category: "内容区",
    when: hasWebPreview,
    keepsPageFocus: true,
    run: () => applyWebZoom(-1),
  },
  {
    id: "study.web-zoom-reset",
    title: "网页缩放回到 100%(⌘0)",
    category: "内容区",
    when: hasWebPreview,
    keepsPageFocus: true,
    run: () => useAppStore.getState().patchSettings({ studyWebZoom: DEFAULT_WEB_ZOOM }),
  },
  {
    id: "agent.switch-session",
    title: "切换主会话/辅助会话(⌘⇧Y)",
    category: "Agent区",
    run: () => useAppStore.getState().bumpAgentSwitchSessionSignal(),
  },
  // ---- Switching between the three focusable regions ----
  // The same group of commands has one default binding per region (see
  // REGION_PLACEMENT in commands/keys.ts): ⌘⌥A/N/R = Agent / notes /
  // reading. Keys pressed inside a web page / WeChat Reading are forwarded
  // back to the main window by the in-page runtime over the title channel
  // (see study/webAnnotations.ts).
  {
    id: "region.focus-agent",
    title: "切换到 Agent 输入框",
    category: "区域切换",
    // Both three-column layouts mount the agent panel (study and code); the
    // notes / projects views have none to focus.
    when: hasAgentPanel,
    run: () => {
      const store = useAppStore.getState();
      // Same rule as region.focus-notes: a command is not an input event, so
      // the region is claimed here — outside the page the input may already
      // hold DOM focus (the reading region never takes it), and then no
      // `focusin` follows the focus() below.
      setActiveKeyRegion("agent");
      // The assistant takes the middle column and stays there; the panel then
      // focuses its input and hands the IME to Chinese, in every mode.
      store.setMainColumn("agent");
      // A selected block of code travels with the signal: the panel splices it
      // into the same box it is about to focus. With no selection the command
      // keeps its plain meaning (move the keyboard to the box only).
      store.runAgentPanelCommand("focus-input", {
        insert: quoteCodeSelection() ?? undefined,
      });
    },
  },
  {
    id: "region.focus-notes",
    title: "切换到笔记区",
    category: "区域切换",
    run: () => {
      // The command claims the region itself, exactly like the code column
      // does (see focusCodeContent) — a command is not an input event.
      // `focus()` fires no focusin when the editor already holds DOM focus,
      // and that is the normal state while reading: a PDF never takes focus
      // and a native page leaves the main webview's activeElement untouched.
      // Relying on the focus event then leaves the reading region owning the
      // keyboard although the caret is in this column.
      setActiveKeyRegion("notes");
      // The editor is always visible (the three columns are permanently
      // mounted), so the focus can move right away.
      requestAnimationFrame(() => getView()?.focus());
    },
  },
  {
    id: "region.focus-reading",
    title: "切换到内容区",
    category: "区域切换",
    when: hasAgentPanel,
    // A chord forwarded from the web page must not pull the first responder
    // out of it: in study mode the command only re-orders columns. Code mode
    // has no page to protect — the caret goes to the file there.
    keepsPageFocus: true,
    run: focusContentArea,
  },
  // ---- Session actions inside the study assistant panel ----
  {
    id: "agent.toggle-creative",
    title: "切换创作模式(生成 HTML 实时预览)",
    category: "Agent区",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("toggle-creative"),
  },
  {
    id: "agent.new-session",
    title: "新建一个全新会话",
    category: "Agent区",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("new"),
  },
  {
    id: "agent.fork-session",
    title: "从当前会话分叉出一个新会话",
    category: "Agent区",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("fork"),
  },
  {
    id: "agent.back-from-fork",
    title: "从分叉会话返回上一条会话",
    category: "Agent区",
    when: agentPanelActive,
    run: () => useAppStore.getState().runAgentPanelCommand("back"),
  },
  {
    id: "agent.focus-history",
    title: "打开并聚焦历史会话列表",
    category: "Agent区",
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
    // ⌘\ expanding from the collapsed state = open + drop the focus onto the
    // currently open file row (through focusSidebar's one-shot ticket; the
    // reveal logic for the file row is the same path as ⌘I); pressing it
    // again collapses. The top bar button still uses store.toggleSidebar —
    // glancing at the tree with the mouse must not steal the editor's focus.
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
  {
    id: "edit.insert-math-block",
    title: "插入公式块",
    category: "编辑",
    run: withView(insertMathBlock),
  },
  {
    id: "edit.insert-inline-math",
    title: "插入行内公式",
    category: "编辑",
    run: withView(insertInlineMath),
  },
  {
    id: "edit.insert-code-block",
    title: "插入代码块",
    category: "编辑",
    run: withView(insertCodeBlock),
  },
  {
    id: "edit.insert-inline-code",
    title: "插入行内代码",
    category: "编辑",
    run: withView(insertInlineCode),
  },
  {
    id: "edit.insert-callout",
    title: "插入 Callout 块 / 跳到关联块",
    category: "编辑",
    // Three end positions: with a selection = open a block at the end of the
    // note whose title is the selected text (the original text becomes the
    // anchor, rendered as a dashed underline); the cursor on the anchor or
    // inside the block (it has an origin) = jump / go back; otherwise = open
    // an empty block in place.
    run: withView(insertCallout),
  },
  {
    id: "edit.insert-wikilink",
    title: "插入内部链接 / 跳到本行链接",
    category: "编辑",
    // Not going through withView: if the cursor's line has a link it jumps,
    // otherwise it opens the suggest panel at the cursor — the panel manages
    // the focus itself.
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
  {
    id: "edit.toggle-bold",
    title: "加粗",
    category: "编辑",
    run: withView((v) => toggleWrap(v, "**")),
  },
  {
    id: "edit.toggle-italic",
    title: "斜体",
    category: "编辑",
    run: withView((v) => toggleWrap(v, "*")),
  },
  {
    id: "edit.toggle-strikethrough",
    title: "删除线",
    category: "编辑",
    run: withView((v) => toggleWrap(v, "~~")),
  },
  {
    id: "edit.toggle-todo",
    title: "切换当前行待办状态",
    category: "编辑",
    run: withView(toggleTodo),
  },
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
  {
    id: "edit.toggle-bullet-list",
    title: "无序列表:切换当前行项目符号",
    category: "编辑",
    run: withView((v) => toggleList(v, "bullet")),
  },
  {
    id: "edit.toggle-numbered-list",
    title: "有序列表:切换当前行编号",
    category: "编辑",
    run: withView((v) => toggleList(v, "numbered")),
  },
  {
    id: "edit.toggle-heading",
    title: "标题层级循环：正文(继承上一标题级别) → 更深一级 → … → 正文",
    category: "编辑",
    run: withView((v) => {
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const existing = line.text.match(/^(#{1,6})(\s+|$)/);
      // The leftover number only has to be cleared when the next level lands
      // in the body text (an existing heading of H4 or deeper).
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
  // No default key: the user pairs it with the cycle key plus Shift (the
  // cycle demotes, this one promotes). Command id stays stable for the
  // keybinding file.
  {
    id: "edit.heading-promote",
    title: "标题升级:H2→H1,H1→正文",
    category: "编辑",
    run: withView((v) => {
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const headingRemoved = /^#(?:\s|$)/.test(line.text);
      promoteHeading(v);
      settleHeadingNumbering(v, line.from, headingRemoved);
    }),
  },

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

  // ---- python: markdown embedded code blocks ----
  {
    id: "python.run-note",
    title: "把当前笔记当一个 py 文件运行(⌘↩)",
    category: "Python",
    run: () => void runCurrentNote(),
  },
  {
    id: "python.run-stop",
    title: "停止当前运行",
    category: "Python",
    run: () => void stopRun(),
  },
  {
    id: "python.toggle-lsp",
    title: "开/关当前项目的 ty 类型检查(LSP)",
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
            next === "ty" ? `项目「${proj}」ty 类型检查已开启` : `项目「${proj}」ty 类型检查已关闭`,
          );
      } catch (e) {
        useAppStore.getState().showToast(`切换失败: ${String(e)}`);
      }
    },
  },
  // ---- Invest mode (the invest region) ----
  // The same split of duties as the project commands: the store owns the
  // state, the command layer only signals (the layout runs the action).
  {
    id: "invest.next-instrument",
    title: "切换到下一个标的/板块(⌘⌥→)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-cycle", { detail: 1 }));
    },
  },
  {
    id: "invest.prev-instrument",
    title: "切换到上一个标的/板块(⌘⌥←)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-cycle", { detail: -1 }));
    },
  },
  {
    id: "invest.next-doc",
    title: "下一个标的文档 Tab",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-doc", { detail: 1 }));
    },
  },
  {
    id: "invest.prev-doc",
    title: "上一个标的文档 Tab",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-doc", { detail: -1 }));
    },
  },
  {
    id: "invest.toggle-sector-view",
    title: "标的视图 ↔ 板块视图(⌘⌥S)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-toggle-view"));
    },
  },
  {
    // B9: the middle column is permanent now, so this chord brings the LEFT
    // column back to the list instead of hiding the agent.
    id: "invest.focus-market",
    title: "左栏切回标的列表(K 线 + 详情常驻中栏)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-focus-list"));
    },
  },
  {
    id: "invest.focus-agent",
    title: "左栏切到 AI 分析(分析当前标的)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-focus-agent"));
    },
  },
  {
    id: "invest.search-knowledge",
    title: "全局知识检索(跨标的全文搜索)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-knowledge"));
    },
  },
  {
    // C15: the same-hexin convention — bare ↑/↓ walk the FILTERED list (the
    // search box is never cleared), Enter opens the scope's document.
    id: "invest.list-up",
    title: "列表上一个标的(↑,按当前过滤结果)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-list-move", { detail: -1 }));
    },
  },
  {
    id: "invest.list-down",
    title: "列表下一个标的(↓,按当前过滤结果)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-list-move", { detail: 1 }));
    },
  },
  {
    id: "invest.open-doc",
    title: "打开当前标的的文档(Enter)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-open-doc"));
    },
  },
  {
    // C17: TradingView-style chart keys. The step/scale travel as detail.
    id: "invest.kline-scroll-left",
    title: "K 线向左平移(←)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-kline-scroll", { detail: -1 }));
    },
  },
  {
    id: "invest.kline-scroll-right",
    title: "K 线向右平移(→)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-kline-scroll", { detail: 1 }));
    },
  },
  {
    id: "invest.kline-zoom-out",
    title: "K 线缩小(-)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-kline-zoom", { detail: 0.8 }));
    },
  },
  {
    id: "invest.kline-zoom-in",
    title: "K 线放大(=)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-kline-zoom", { detail: 1.25 }));
    },
  },
  // C18: ⌘⌥1..7 land on the Nth detail tab of the current scope kind.
  ...(
    [
      ["1", "行情"],
      ["2", "资金流"],
      ["3", "财务"],
      ["4", "事件"],
      ["5", "知识"],
      ["6", "预测"],
      ["7", "回测"],
    ] as const
  ).map(([n, label]) => ({
    id: `invest.detail-tab-${n}`,
    title: `详情切到「${label}」(⌘⌥${n})`,
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-detail-tab", { detail: Number(n) }));
    },
  })),
  {
    id: "invest.kline-period-day",
    title: "K 线切到日 K",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    keepsPageFocus: true,
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-period", { detail: "1d" }));
    },
  },
  {
    id: "invest.kline-period-week",
    title: "K 线切到周 K",
    category: "投资",
    keepsPageFocus: true,
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-period", { detail: "1w" }));
    },
  },
  {
    id: "invest.kline-period-month",
    title: "K 线切到月 K",
    category: "投资",
    keepsPageFocus: true,
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-period", { detail: "1M" }));
    },
  },
  {
    id: "invest.forecast-replay",
    title: "用当前 Skill 回放一次预测(截至 10 个交易日前)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-forecast"));
    },
  },
  {
    id: "invest.backtest-run",
    title: "跑一次 ma_cross 基准回测",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-backtest"));
    },
  },
  {
    id: "invest.import-data",
    title: "导入数据(标的 / K 线 / 财务 / 资金流,akshare JSON)",
    category: "投资",
    when: () => useAppStore.getState().mode === "invest",
    run: () => {
      window.dispatchEvent(new CustomEvent("bnote:invest-import"));
    },
  },
  {
    id: "python.create-uv-env",
    title: "为当前项目创建 uv 环境",
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
  // The code project commands: they belong to the code region and only take
  // effect inside the code editor (see commands/keys.ts).
  ...codeCommandDefs,
];

registerCommands(defs);

// Rendered wikilink / external link clicks from the live preview.
configureLivePreview({
  openWikiLink: (target) => actions.openWikiLink(target),
  openExternalUrl: (url) => {
    void openUrl(url).catch((e) => console.warn("open url failed", e));
  },
  // Clicking the preview image of a drawing embed: open the canvas to keep
  // editing it.
  openDrawing: (path) => openDrawingFile(path),
});

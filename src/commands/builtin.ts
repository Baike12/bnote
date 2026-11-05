import { openUrl } from "@tauri-apps/plugin-opener";
import { registerCommands, runCommand, type CommandDef } from "./registry";
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
import { agentApi, api } from "@/lib/tauri";
import { canFlipPdfPage, flipPdfPage } from "@/study/pdfNav";
import { useFocusStore } from "@/focus/store";
import { capturePdfSnapshot, hasPdfSnapshotSource } from "@/study/pdfSnapshot";
import { DEFAULT_WEB_ZOOM, stepWebZoom } from "@/study/webZoom";
import { fileToAgentImage } from "@/study/agentImages";
import { WEREAD_HOME_URL } from "@/study/weread";
import { setActiveKeyRegion } from "./globalKeys";
import { codeCommandDefs } from "@/code/commands";

/** Whether the middle column has a web page open (only then do the zoom keys take over ⌘= / ⌘- / ⌘0). */
function hasWebPreview(): boolean {
  return useAppStore.getState().studyContent?.kind === "url";
}

/** The writer is the settings: ContentPane subscribes to it and pushes it into the native child webview (see setStudyPreviewZoom). */
function applyWebZoom(direction: 1 | -1): void {
  const { settings, patchSettings } = useAppStore.getState();
  patchSettings({ studyWebZoom: stepWebZoom(settings.studyWebZoom, direction) });
}

/**
 * Hand the focus back to the reading region; when the web page lives in the
 * native child webview, hand it over to that.
 *
 * The keyboard ownership is written directly at the same time: in the web
 * branch the focus sits on the native child webview, so the main window's
 * pointerdown/focusin never fire and the region ownership would stay on the
 * notes / Agent region — the keys the main window then receives would be
 * resolved against the wrong region (⌘E would be eaten by the notes region's
 * own live-preview toggle). The command is the direct result of a user
 * keystroke, so it *is* the "most recent action".
 */
function focusReadingPane() {
  const focusPane = () => {
    document
      .querySelector<HTMLElement>('[data-key-region="reading"]')
      ?.focus({ preventScroll: true });
  };
  setActiveKeyRegion("reading");
  if (useAppStore.getState().studyContent?.kind === "url") {
    // End the main window's editing state first: while the editor
    // (contenteditable) is being edited the window's first responder is the
    // field editor inside it; without resigning, swapping the first responder
    // for the native child webview is rejected, the keyboard stays in the
    // main window — and every following key is resolved against the old
    // region.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    // Browser mode has no native view, so the command does not exist → fall
    // back to the DOM placeholder (the region decision still holds).
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
    if (m) view.dispatch({ changes: { from: after.from, to: after.from + m[1].length, insert: "" } });
  }
  renumberHeadings(view);
}

/** Whether the study assistant panel is present: it is always mounted in the three-column layout, so entering study mode is enough. */
function agentPanelActive(): boolean {
  return useAppStore.getState().mode === "study";
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
    // The macOS menu carries no ⌘Q key equivalent (see lib.rs::install_menu),
    // so the quit chord lives here with every other binding. The native menu's
    // Quit item goes through the same flush-then-destroy path.
    id: "app.quit",
    title: "退出应用",
    category: "工作区",
    run: quitApp,
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
    // Code mode is its own mode (agent | code | notes), unrelated to the vault.
    // Deliberately unbound by default: ⌘⇧C is "insert code block" in the notes
    // region; bind this command yourself in keybindings.json if you want a key.
    id: "view.toggle-code-mode",
    title: "进入 / 退出代码模式(左问 agent、中写代码、右记笔记)",
    category: "视图",
    run: () => {
      toggleCodeMode();
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
    title: "打开微信读书(书架 / 商城 / 阅读,进学习模式)",
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
  // ---- Switching between the three focusable regions ----
  // The same group of commands has one default binding per region (see
  // REGION_PLACEMENT in commands/keys.ts): ⌘⌥A/N/R = Agent / notes /
  // reading. Keys pressed inside a web page / WeChat Reading are forwarded
  // back to the main window by the in-page runtime over the title channel
  // (see study/webAnnotations.ts).
  {
    id: "region.focus-agent",
    title: "聚焦学习助手输入框",
    category: "区域切换",
    when: () => useAppStore.getState().mode === "study",
    run: () => useAppStore.getState().runAgentPanelCommand("focus-input"),
  },
  {
    id: "region.focus-notes",
    title: "聚焦笔记区编辑器",
    category: "区域切换",
    run: () => {
      // The editor is always visible (the three columns are permanently
      // mounted); after focusing, the focus event carries the keyboard
      // ownership over.
      requestAnimationFrame(() => getView()?.focus());
    },
  },
  {
    id: "region.focus-reading",
    title: "切换到阅读区(PDF / 网页)",
    category: "区域切换",
    when: () => useAppStore.getState().mode === "study",
    // The middle column is always visible, so there is no need to switch
    // tabs; it only has to hand the focus from the editor / input back to the
    // reading region.
    run: focusReadingPane,
  },
  // ---- Session actions inside the study assistant panel ----
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
  { id: "edit.insert-math-block", title: "插入公式块", category: "编辑", run: withView(insertMathBlock) },
  { id: "edit.insert-inline-math", title: "插入行内公式", category: "编辑", run: withView(insertInlineMath) },
  { id: "edit.insert-code-block", title: "插入代码块", category: "编辑", run: withView(insertCodeBlock) },
  { id: "edit.insert-inline-code", title: "插入行内代码", category: "编辑", run: withView(insertInlineCode) },
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

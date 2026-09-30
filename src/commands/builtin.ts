import { openUrl } from "@tauri-apps/plugin-opener";
import { registerCommands, runCommand, type CommandDef } from "./registry";
import { cycleQuickSwitcher } from "@/components/QuickSwitcher";
import { getView } from "@/editor/api";
import {
  cycleHeading,
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
import { useAppStore, toggleStudyMode } from "@/state/appStore";
import { ensureLinks } from "@/daily/links";
import { sendTodoToDaily } from "@/daily/engine";
import { openTodayDailyNote } from "@/daily/open";
import { runtimeDeps } from "@/daily/runtime";
import { createUvEnvForCurrentProject, runCurrentNote, stopRun } from "@/python/run";
import { resetLspStateForPath, syncNow } from "@/python/lsp";
import { api } from "@/lib/tauri";

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
    id: "workspace.open-daily",
    title: "打开今日日记(⌘⇧O,日记内再按跳回)",
    category: "工作区",
    run: () => void openTodayDailyNote(),
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
  { id: "workspace.save-note", title: "保存当前笔记", category: "工作区", run: () => void actions.saveNote() },
  {
    id: "workspace.open-drawing",
    title: "画图:打开画布,回到笔记时插入光标处(⌘D)",
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
    run: () => useAppStore.getState().toggleSidebar(),
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
    title: "切换实时渲染/源码模式",
    category: "编辑器",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ livePreview: !settings.livePreview });
    },
  },
  {
    id: "editor.toggle-vim",
    title: "切换 Vim 模式",
    category: "编辑器",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ vim: !settings.vim });
    },
  },
  {
    id: "editor.toggle-typewriter",
    title: "切换打字机模式",
    category: "编辑器",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ typewriter: !settings.typewriter });
    },
  },
  {
    id: "editor.toggle-snippets",
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
    id: "view.zoom-in",    title: "放大编辑区字号",
    category: "视图",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ fontSize: Math.min(28, settings.fontSize + 1) });
    },
  },
  {
    id: "view.zoom-out",
    title: "缩小编辑区字号",
    category: "视图",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ fontSize: Math.max(12, settings.fontSize - 1) });
    },
  },
  {
    id: "view.zoom-reset",
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

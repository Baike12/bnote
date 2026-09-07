import { openUrl } from "@tauri-apps/plugin-opener";
import { registerCommands, runCommand, type CommandDef } from "./registry";
import { getView } from "@/editor/api";
import {
  insertCodeBlock,
  insertHorizontalRule,
  insertInlineCode,
  insertInlineMath,
  insertMathBlock,
  insertWikilink,
  toggleHeading,
  toggleTodo,
  toggleWrap,
} from "@/editor/ops";
import { setSearchQuery, SearchQuery } from "@codemirror/search";
import { configureLivePreview } from "@/editor/livePreview";
import { renumberHeadings } from "@/editor/numbering";
import * as actions from "@/app/actions";
import { useAppStore } from "@/state/appStore";

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
  { id: "workspace.new-note", title: "新建笔记", category: "工作区", run: () => void actions.newNote() },
  {
    id: "workspace.new-folder",
    title: "新建文件夹",
    category: "工作区",
    run: () => void actions.newFolder(),
  },
  { id: "workspace.save-note", title: "保存当前笔记", category: "工作区", run: () => void actions.saveNote() },
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
    run: () => useAppStore.getState().setModal("switcher"),
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

  // ---- editing ----
  { id: "edit.insert-math-block", title: "插入公式块", category: "编辑", run: withView(insertMathBlock) },
  { id: "edit.insert-inline-math", title: "插入行内公式", category: "编辑", run: withView(insertInlineMath) },
  { id: "edit.insert-code-block", title: "插入代码块", category: "编辑", run: withView(insertCodeBlock) },
  { id: "edit.insert-inline-code", title: "插入行内代码", category: "编辑", run: withView(insertInlineCode) },
  { id: "edit.insert-wikilink", title: "插入内部链接", category: "编辑", run: withView(insertWikilink) },
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
  ...([1, 2, 3, 4, 5, 6] as const).map((level): CommandDef => ({
    id: `edit.heading-${level}`,
    title: `设为 ${level} 级标题`,
    category: "编辑",
    run: withView((v) => {
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const togglingOff = new RegExp(`^${"#".repeat(level)}(?:\\s|$)`).test(line.text);
      toggleHeading(v, level);
      if (!useAppStore.getState().settings.autoNumberHeadings) return;
      if (togglingOff) {
        // The heading mark is gone; don't leave its auto number behind.
        const after = v.state.doc.lineAt(
          Math.min(line.from, v.state.doc.length),
        );
        const m = /^(\d+(?:\.\d+)*[ \t]+)/.exec(after.text);
        if (m) v.dispatch({ changes: { from: after.from, to: after.from + m[1].length, insert: "" } });
      }
      renumberHeadings(v);
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

  // ---- view ----
  {
    id: "view.zoom-in",
    title: "放大编辑区字号",
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
});

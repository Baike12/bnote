//! Command surface: the GPUI actions, the registry (single source for the
//! palette and default keybindings, mirroring the Tauri shell's
//! `commands/registry.ts` + `keys.ts`), and the shared action types.

/// The GPUI action types, namespaced `workspace` (matching the Tauri shell's
/// command ids in the action names).
pub mod actions {
    use gpui::actions;

    actions!(
        workspace,
        [
            Save,
            CommandPalette,
            QuickSwitcher,
            SwitchRecentVault,
            ToggleSidebar,
            FocusSidebar,
            NewNote,
            QuickAdd,
            OpenDaily,
            SendTodoToDaily,
            ToggleTodo,
            CycleHeading,
            Heading1,
            Heading2,
            Heading3,
            Heading4,
            ToggleBulletList,
            ToggleNumberedList,
            ToggleBold,
            ToggleItalic,
            ToggleStrikethrough,
            InsertInlineCode,
            InsertCodeBlock,
            InsertMathBlock,
            InsertInlineMath,
            InsertCallout,
            InsertWikilink,
            InsertHorizontalRule,
            HeaderTodos,
            ToggleAgentPanel,
            ToggleVim,
            OpenSettings,
            PythonRunNote,
            PythonRunStop,
        ]
    );
}

/// One registry row: stable id (matches the Tauri shell's command ids so
/// `keybindings.json` stays portable), display label, default keystroke
/// (`None` = palette-only, the TS registry commands that ship without one).
pub struct CommandDef {
    pub id: &'static str,
    pub label: &'static str,
    pub key: Option<&'static str>,
}

/// The palette shows these in declaration order; groups are cosmetic for now.
pub const COMMANDS: &[CommandDef] = &[
    CommandDef { id: "save-note", label: "保存笔记", key: Some("cmd-s") },
    CommandDef { id: "command-palette", label: "命令面板", key: Some("cmd-p") },
    CommandDef { id: "quick-switcher", label: "快速跳转", key: Some("cmd-o") },
    CommandDef { id: "switch-recent-vault", label: "切换仓库", key: Some("cmd-shift-r") },
    CommandDef { id: "toggle-sidebar", label: "切换侧栏", key: Some("cmd-\\") },
    CommandDef { id: "focus-sidebar", label: "聚焦文件树", key: Some("cmd-i") },
    CommandDef { id: "new-note", label: "新建笔记", key: Some("cmd-n") },
    CommandDef { id: "quick-add", label: "快速添加文件", key: Some("cmd-shift-a") },
    CommandDef { id: "open-daily", label: "打开今日日记", key: Some("cmd-shift-o") },
    CommandDef { id: "todo-to-daily", label: "待办发送到日记", key: Some("cmd-shift-j") },
    CommandDef { id: "toggle-todo", label: "切换待办", key: Some("cmd-l") },
    CommandDef { id: "toggle-heading", label: "标题层级循环", key: Some("cmd-j") },
    CommandDef { id: "edit.heading-1", label: "一级标题", key: Some("cmd-1") },
    CommandDef { id: "edit.heading-2", label: "二级标题", key: Some("cmd-2") },
    CommandDef { id: "edit.heading-3", label: "三级标题", key: Some("cmd-3") },
    CommandDef { id: "edit.heading-4", label: "四级标题", key: Some("cmd-4") },
    CommandDef { id: "toggle-bullet-list", label: "切换无序列表", key: Some("cmd-;") },
    CommandDef { id: "toggle-numbered-list", label: "切换有序列表", key: Some("cmd-shift-;") },
    CommandDef { id: "toggle-bold", label: "加粗", key: Some("cmd-b") },
    CommandDef { id: "toggle-italic", label: "斜体", key: Some("cmd-shift-i") },
    CommandDef { id: "toggle-strikethrough", label: "删除线", key: Some("cmd-shift-d") },
    CommandDef { id: "insert-inline-code", label: "行内代码", key: Some("cmd-`") },
    CommandDef { id: "insert-code-block", label: "代码块", key: Some("cmd-shift-c") },
    CommandDef { id: "insert-math-block", label: "公式块", key: Some("cmd-m") },
    CommandDef { id: "insert-inline-math", label: "行内公式", key: Some("cmd-shift-m") },
    CommandDef { id: "insert-callout", label: "插入 Callout", key: Some("cmd-shift-b") },
    CommandDef { id: "insert-wikilink", label: "插入双链", key: Some("cmd-k") },
    CommandDef { id: "insert-horizontal-rule", label: "分隔线", key: Some("cmd-shift-h") },
    CommandDef { id: "header-todos", label: "跳到头部待办", key: Some("cmd-t") },
    CommandDef { id: "toggle-agent-panel", label: "Agent 面板", key: Some("cmd-shift-u") },
    CommandDef { id: "toggle-vim", label: "切换 vim 模式", key: Some("cmd-shift-v") },
    CommandDef { id: "open-settings", label: "设置", key: Some("cmd-,") },
    // Python: ⌘↩ 跑整篇笔记的虚拟 py 文件(TS `python.run-note`);停止像 TS
    // 一样没有默认键位,只出现在命令面板。
    CommandDef { id: "python.run-note", label: "Python: 运行当前笔记", key: Some("cmd-enter") },
    CommandDef { id: "python.run-stop", label: "Python: 停止运行", key: None },
];

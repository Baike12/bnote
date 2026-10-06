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
        ]
    );
}

/// One registry row: stable id (matches the Tauri shell's command ids so
/// `keybindings.json` stays portable), display label, default keystroke.
pub struct CommandDef {
    pub id: &'static str,
    pub label: &'static str,
    pub key: &'static str,
}

/// The palette shows these in declaration order; groups are cosmetic for now.
pub const COMMANDS: &[CommandDef] = &[
    CommandDef { id: "save-note", label: "保存笔记", key: "cmd-s" },
    CommandDef { id: "command-palette", label: "命令面板", key: "cmd-p" },
    CommandDef { id: "quick-switcher", label: "快速跳转", key: "cmd-o" },
    CommandDef { id: "switch-recent-vault", label: "切换仓库", key: "cmd-shift-r" },
    CommandDef { id: "toggle-sidebar", label: "切换侧栏", key: "cmd-\\" },
    CommandDef { id: "focus-sidebar", label: "聚焦文件树", key: "cmd-i" },
    CommandDef { id: "new-note", label: "新建笔记", key: "cmd-n" },
    CommandDef { id: "quick-add", label: "快速添加文件", key: "cmd-shift-a" },
    CommandDef { id: "open-daily", label: "打开今日日记", key: "cmd-shift-o" },
    CommandDef { id: "todo-to-daily", label: "待办发送到日记", key: "cmd-shift-j" },
    CommandDef { id: "toggle-todo", label: "切换待办", key: "cmd-l" },
    CommandDef { id: "toggle-heading", label: "标题层级循环", key: "cmd-j" },
    CommandDef { id: "edit.heading-1", label: "一级标题", key: "cmd-1" },
    CommandDef { id: "edit.heading-2", label: "二级标题", key: "cmd-2" },
    CommandDef { id: "edit.heading-3", label: "三级标题", key: "cmd-3" },
    CommandDef { id: "edit.heading-4", label: "四级标题", key: "cmd-4" },
    CommandDef { id: "toggle-bullet-list", label: "切换无序列表", key: "cmd-;" },
    CommandDef { id: "toggle-numbered-list", label: "切换有序列表", key: "cmd-shift-;" },
    CommandDef { id: "toggle-bold", label: "加粗", key: "cmd-b" },
    CommandDef { id: "toggle-italic", label: "斜体", key: "cmd-shift-i" },
    CommandDef { id: "toggle-strikethrough", label: "删除线", key: "cmd-shift-d" },
    CommandDef { id: "insert-inline-code", label: "行内代码", key: "cmd-`" },
    CommandDef { id: "insert-code-block", label: "代码块", key: "cmd-shift-c" },
    CommandDef { id: "insert-math-block", label: "公式块", key: "cmd-m" },
    CommandDef { id: "insert-inline-math", label: "行内公式", key: "cmd-shift-m" },
    CommandDef { id: "insert-callout", label: "插入 Callout", key: "cmd-shift-b" },
    CommandDef { id: "insert-wikilink", label: "插入双链", key: "cmd-k" },
    CommandDef { id: "insert-horizontal-rule", label: "分隔线", key: "cmd-shift-h" },
    CommandDef { id: "header-todos", label: "跳到头部待办", key: "cmd-t" },
    CommandDef { id: "toggle-agent-panel", label: "Agent 面板", key: "cmd-shift-u" },
    CommandDef { id: "toggle-vim", label: "切换 vim 模式", key: "cmd-shift-v" },
    CommandDef { id: "open-settings", label: "设置", key: "cmd-," },
];

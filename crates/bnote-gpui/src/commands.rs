//! Command surface: the GPUI actions and the registry — one table that is the
//! single source for the command palette, the settings modal's hotkeys tab,
//! the default keybindings and the action dispatch.
//!
//! The ids and default keystrokes are the Tauri shell's
//! (`src/commands/builtin.ts` + `src/commands/keys.ts`) verbatim, so a
//! `keybindings.json` written by either shell drives the other. Commands whose
//! feature the GPUI shell does not have yet (the drawing canvas, the link
//! history, window close, the search highlight) are simply absent.

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
            OpenVault,
            ToggleSidebar,
            FocusSidebar,
            NewNote,
            NewFolder,
            QuickAdd,
            OpenDaily,
            SendTodoToDaily,
            ToggleTodo,
            CycleHeading,
            Heading1,
            Heading2,
            Heading3,
            Heading4,
            Heading5,
            Heading6,
            ToggleBulletList,
            ToggleNumberedList,
            ToggleBold,
            ToggleItalic,
            ToggleStrikethrough,
            InsertInlineCode,
            InsertCodeBlock,
            InsertPythonBlock,
            InsertMathBlock,
            InsertInlineMath,
            InsertCallout,
            InsertWikilink,
            InsertHorizontalRule,
            HeaderTodos,
            ToggleAgentPanel,
            ToggleVim,
            ToggleTypewriter,
            ToggleSnippets,
            ZoomIn,
            ZoomOut,
            ZoomReset,
            OpenSettings,
            PythonRunNote,
            PythonRunStop,
            PythonToggleLsp,
            PythonCreateUvEnv,
            ToggleStudyMode,
            ToggleLivePreview,
        ]
    );
}

/// One registry row: the Tauri shell's command id, its display label, its
/// default keystroke (`None` = palette-only) and the two ways the action is
/// materialized — for dispatch and for the keymap. Keeping both here is what
/// lets [`action_for`] and [`keybinding_for`] be lookups instead of a second
/// table that can drift.
pub struct CommandDef {
    pub id: &'static str,
    pub label: &'static str,
    pub key: Option<&'static str>,
    action: fn() -> Box<dyn gpui::Action>,
    binding: fn(&str) -> gpui::KeyBinding,
}

/// One row of [`COMMANDS`].
macro_rules! command {
    ($id:expr, $label:expr, $key:expr, $action:ty) => {
        CommandDef {
            id: $id,
            label: $label,
            key: $key,
            action: || Box::new(<$action>::default()),
            binding: |key| ::gpui::KeyBinding::new(key, <$action>::default(), None),
        }
    };
}

/// The palette and the hotkeys tab show these in declaration order; groups are
/// cosmetic for now.
pub const COMMANDS: &[CommandDef] = &[
    command!("workspace.save-note", "保存笔记", Some("cmd-s"), actions::Save),
    command!("nav.command-palette", "命令面板", Some("cmd-p"), actions::CommandPalette),
    command!("nav.quick-switcher", "快速跳转", Some("cmd-o"), actions::QuickSwitcher),
    command!(
        "workspace.switch-recent-vault",
        "切换仓库",
        Some("cmd-shift-r"),
        actions::SwitchRecentVault
    ),
    command!("workspace.open-vault", "打开仓库文件夹", None, actions::OpenVault),
    command!("nav.toggle-sidebar", "切换侧栏", Some("cmd-\\"), actions::ToggleSidebar),
    command!("nav.focus-sidebar", "聚焦文件树", Some("cmd-i"), actions::FocusSidebar),
    command!("workspace.new-note", "新建笔记", Some("cmd-n"), actions::NewNote),
    command!("workspace.new-folder", "新建文件夹", None, actions::NewFolder),
    command!("workspace.quick-add", "快速添加文件", Some("cmd-shift-a"), actions::QuickAdd),
    command!("workspace.open-daily", "打开今日日记", Some("cmd-shift-o"), actions::OpenDaily),
    command!("edit.todo-to-daily", "待办发送到日记", Some("cmd-shift-j"), actions::SendTodoToDaily),
    command!("edit.toggle-todo", "切换当前行待办状态", Some("cmd-l"), actions::ToggleTodo),
    command!("edit.toggle-heading", "标题层级循环", Some("cmd-j"), actions::CycleHeading),
    command!("edit.heading-1", "一级标题", Some("cmd-1"), actions::Heading1),
    command!("edit.heading-2", "二级标题", Some("cmd-2"), actions::Heading2),
    command!("edit.heading-3", "三级标题", Some("cmd-3"), actions::Heading3),
    command!("edit.heading-4", "四级标题", Some("cmd-4"), actions::Heading4),
    command!("edit.heading-5", "五级标题", Some("cmd-5"), actions::Heading5),
    command!("edit.heading-6", "六级标题", Some("cmd-6"), actions::Heading6),
    command!("edit.toggle-bullet-list", "切换无序列表", Some("cmd-;"), actions::ToggleBulletList),
    command!(
        "edit.toggle-numbered-list",
        "切换有序列表",
        Some("cmd-shift-;"),
        actions::ToggleNumberedList
    ),
    command!("edit.toggle-bold", "加粗", Some("cmd-b"), actions::ToggleBold),
    command!("edit.toggle-italic", "斜体", Some("cmd-shift-i"), actions::ToggleItalic),
    command!("edit.toggle-strikethrough", "删除线", Some("cmd-shift-d"), actions::ToggleStrikethrough),
    command!("edit.insert-inline-code", "行内代码", Some("cmd-`"), actions::InsertInlineCode),
    command!("edit.insert-code-block", "代码块", Some("cmd-shift-c"), actions::InsertCodeBlock),
    command!("edit.insert-python-block", "插入 Python 代码块", None, actions::InsertPythonBlock),
    command!("edit.insert-math-block", "公式块", Some("cmd-m"), actions::InsertMathBlock),
    command!("edit.insert-inline-math", "行内公式", Some("cmd-shift-m"), actions::InsertInlineMath),
    command!("edit.insert-callout", "插入 Callout", Some("cmd-shift-b"), actions::InsertCallout),
    command!("edit.insert-wikilink", "插入双链", Some("cmd-k"), actions::InsertWikilink),
    command!(
        "edit.insert-horizontal-rule",
        "分隔线",
        Some("cmd-shift-h"),
        actions::InsertHorizontalRule
    ),
    command!("nav.header-todos", "跳到头部待办", Some("cmd-t"), actions::HeaderTodos),
    command!(
        "editor.toggle-live-preview",
        "切换实时渲染 / 源码模式",
        Some("cmd-e"),
        actions::ToggleLivePreview
    ),
    command!("editor.toggle-vim", "切换 vim 模式", Some("cmd-shift-v"), actions::ToggleVim),
    command!(
        "editor.toggle-typewriter",
        "切换打字机模式",
        Some("cmd-shift-t"),
        actions::ToggleTypewriter
    ),
    command!(
        "editor.toggle-snippets",
        "切换 LaTeX 快捷片段",
        Some("cmd-shift-l"),
        actions::ToggleSnippets
    ),
    command!("view.zoom-in", "放大编辑区字号", Some("cmd-="), actions::ZoomIn),
    command!("view.zoom-out", "缩小编辑区字号", Some("cmd--"), actions::ZoomOut),
    command!("view.zoom-reset", "重置编辑区字号", Some("cmd-0"), actions::ZoomReset),
    command!("view.toggle-agent-panel", "Agent 面板", Some("cmd-shift-u"), actions::ToggleAgentPanel),
    // 学习模式:左问 agent、中看内容、右记笔记(TS `view.toggle-study-mode`)。
    command!(
        "view.toggle-study-mode",
        "进入 / 退出学习模式",
        Some("cmd-shift-s"),
        actions::ToggleStudyMode
    ),
    command!("workspace.open-settings", "设置", Some("cmd-,"), actions::OpenSettings),
    // Python: ⌘↩ 跑整篇笔记的虚拟 py 文件(TS `python.run-note`);停止像 TS
    // 一样没有默认键位,只出现在命令面板。
    command!("python.run-note", "Python: 运行当前笔记", Some("cmd-enter"), actions::PythonRunNote),
    command!("python.run-stop", "Python: 停止运行", None, actions::PythonRunStop),
    command!("python.toggle-lsp", "Python: 开/关当前项目的 ty 类型检查", None, actions::PythonToggleLsp),
    command!("python.create-uv-env", "Python: 为当前项目创建 uv 环境", None, actions::PythonCreateUvEnv),
];

/// The registry row of an id.
pub fn def_of(id: &str) -> Option<&'static CommandDef> {
    COMMANDS.iter().find(|def| def.id == id)
}

/// The action of a registry command, ready to dispatch from the palette.
pub fn action_for(id: &str) -> Option<Box<dyn gpui::Action>> {
    def_of(id).map(|def| (def.action)())
}

/// A keystroke bound to a registry command's action.
pub fn keybinding_for(id: &str, key: &str) -> Option<gpui::KeyBinding> {
    def_of(id).map(|def| (def.binding)(key))
}

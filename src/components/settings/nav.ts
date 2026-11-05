/** The settings sections: the navigation groups below are the only place they are listed. */
export type Tab =
  | "general"
  | "editor"
  | "reading"
  | "focus"
  | "daily"
  | "templates"
  | "hotkeys"
  | "vim"
  | "snippets"
  | "ime"
  | "quickadd"
  | "translate"
  | "agent-model"
  | "agent-mcp"
  | "agent-skills"
  | "agent-instructions"
  | "agent-settings";

/** The navigation on the left is grouped by purpose (following the grouped sidebar of the ZCode settings page), rendered in SettingsModal. */
export const NAV_GROUPS: { label: string; items: { id: Tab; label: string }[] }[] = [
  {
    label: "常规",
    items: [
      { id: "general", label: "通用" },
      { id: "editor", label: "编辑器" },
      { id: "reading", label: "阅读" },
      { id: "focus", label: "专注" },
    ],
  },
  {
    label: "笔记",
    items: [
      { id: "daily", label: "日记" },
      { id: "templates", label: "模板" },
    ],
  },
  {
    label: "输入与命令",
    items: [
      { id: "hotkeys", label: "快捷键" },
      { id: "vim", label: "Vim" },
      { id: "snippets", label: "公式片段" },
      { id: "ime", label: "输入法" },
      { id: "quickadd", label: "快速添加" },
    ],
  },
  {
    label: "学习",
    items: [{ id: "translate", label: "翻译" }],
  },
  {
    label: "Agent",
    items: [
      { id: "agent-model", label: "模型" },
      { id: "agent-mcp", label: "MCP" },
      { id: "agent-skills", label: "技能" },
      { id: "agent-instructions", label: "AGENTS.md" },
      { id: "agent-settings", label: "Agent 设置" },
    ],
  },
];

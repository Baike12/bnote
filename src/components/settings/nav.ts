import type { AgentMode } from "@/lib/tauri";

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
  | "agent-advanced";

export interface NavItem {
  id: Tab;
  label: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** The non-agent groups, shared by every mode. */
export const BASE_NAV_GROUPS: NavGroup[] = [
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
];

/**
 * The Agent group of a mode. The pages are not cosmetic variants: each one
 * edits the files that mode actually reads.
 *
 *   coding    model, MCP, skills, AGENTS.md, and the raw settings.json
 *   creative  model, MCP, skills, AGENTS.md
 *   study     model, AGENTS.md (the study agent has no tools)
 */
export function agentNavGroup(mode: AgentMode): NavGroup {
  const label =
    mode === "coding" ? "Agent · 编码" : mode === "creative" ? "Agent · 创作" : "Agent · 学习";
  const items: NavItem[] = [{ id: "agent-model", label: "模型" }];
  if (mode !== "study") {
    items.push({ id: "agent-mcp", label: "MCP" }, { id: "agent-skills", label: "技能" });
  }
  items.push({ id: "agent-instructions", label: "AGENTS.md" });
  if (mode === "coding") items.push({ id: "agent-advanced", label: "高级" });
  return { label, items };
}

/** Every group in render order: the base groups, then the Agent group of the current mode. */
export function navGroups(mode: AgentMode): NavGroup[] {
  return [...BASE_NAV_GROUPS, agentNavGroup(mode)];
}

/**
 * Pure helpers behind the agent-definitions settings page.
 *
 * The definition object mirrors the Rust `AgentDefinition` one-to-one; the
 * only subtlety is `tools`: `null` means "the key is absent in the file → the
 * backend's general default toolset", while an empty array is a deliberate
 * "no tools at all" (the study shape). The editor's checkboxes therefore work
 * on a materialized list plus an `explicit` flag, and this module owns that
 * round-trip so the UI cannot confuse the two.
 */

import type { AgentDefinition, DefinitionListItem } from "@/lib/tauri";

/** Every tool the backend can register, in display order. */
export const TOOLS_CATALOG: { name: string; label: string }[] = [
  { name: "read_file", label: "读文件" },
  { name: "write_file", label: "写文件" },
  { name: "edit_file", label: "局部改" },
  { name: "list_files", label: "列文件" },
  { name: "glob", label: "glob" },
  { name: "grep", label: "grep" },
  { name: "bash", label: "bash" },
  { name: "bash_output", label: "后台输出" },
  { name: "bash_kill", label: "后台终止" },
  { name: "todo", label: "任务清单" },
  { name: "task", label: "子代理" },
  { name: "skill", label: "技能" },
  { name: "mcp", label: "MCP" },
  { name: "read_url", label: "读网页" },
  { name: "preview_html", label: "HTML 预览" },
  { name: "read_study_content", label: "读材料" },
];

/** The backend's default toolset (agent/defs.rs::DEFAULT_TOOLS), shown for `tools: null`. */
export const DEFAULT_TOOLS: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "glob",
  "grep",
  "bash",
  "todo",
  "skill",
];

/** The effective toolset a definition runs with (null → default set). */
export function effectiveTools(def: Pick<AgentDefinition, "tools" | "permissions">): string[] {
  const base = def.tools ?? DEFAULT_TOOLS;
  return base.filter((t) => def.permissions[t] !== "deny");
}

/** The checkbox state: which tools are on, and whether the list is explicit. */
export function toolChecks(def: Pick<AgentDefinition, "tools">): {
  on: Set<string>;
  explicit: boolean;
} {
  return { on: new Set(def.tools ?? DEFAULT_TOOLS), explicit: def.tools != null };
}

/** One checkbox flip. The first flip that CHANGES the set materializes the list (null → explicit). */
export function toggleTool(
  def: AgentDefinition,
  name: string,
  on: boolean,
): AgentDefinition {
  const { on: current, explicit } = toolChecks(def);
  const next = new Set(current);
  if (on) next.add(name);
  else next.delete(name);
  // A no-op flip on the default set keeps `null`; any real change materializes.
  const changed = on ? !current.has(name) : current.has(name);
  return {
    ...def,
    tools: explicit || changed ? [...next] : null,
  };
}

/** A fresh user definition: general toolset, compaction on, one example layer. */
export function defaultDefinition(id: string): AgentDefinition {
  return {
    id,
    name: "",
    description: "",
    body: "You are …\n\n## 守则\n\n- …",
    tools: null,
    permissions: {},
    compaction: { enabled: true, threshold: 0.85 },
    subagents: [],
    prompt_layers: [],
    model: "",
    max_tokens: 0,
    max_turns: 0,
  };
}

/** New definition id from a display name: slug-ish, validated later by the backend. */
export function idFromName(name: string, taken: Set<string>): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "agent";
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

/** Sorts the list: built-ins first (stable), then user files, both by id. */
export function sortDefinitions(list: DefinitionListItem[]): DefinitionListItem[] {
  return [...list].sort((a, b) => {
    if (a.source !== b.source) return a.source === "builtin" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

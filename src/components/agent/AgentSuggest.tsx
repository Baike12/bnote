import { useEffect, useMemo, useRef } from "react";

import { fuzzyMatchPath, fuzzyMatchTerms } from "@/lib/fuzzy";
import { buildSwitcherResults } from "@/lib/switcher";
import type { SkillInfo } from "@/lib/tauri";

export interface SuggestItem {
  /** Text inserted on pick (the full form of the trigger, e.g. /html-blog or @notes/a.md). */
  insert: string;
  title: string;
  subtitle?: string;
  /** `builtin` executes a panel command on pick; `skill`/`file` just fill the text. */
  kind: "builtin" | "skill" | "file";
}

/**
 * The built-in panel commands (CC's COMMANDS() subset that maps onto panel
 * actions). `/name args` that matches none of them falls through to the skill
 * expansion in the panel's send.
 */
export const BUILTIN_COMMANDS: { name: string; description: string }[] = [
  { name: "compact", description: "压缩上下文:把会话历史替换成摘要" },
  { name: "clear", description: "结束当前会话,开启新会话" },
  { name: "help", description: "显示可用命令与输入约定" },
];

/**
 * How well a `/name` answers the query. Name matches use the fuzzy matcher, so
 * initials and typos still land (`prfm` → `bnote-performance`, `co` →
 * `uncode`) instead of only substrings. Description-only matches sit below
 * every name match: they stay reachable but never outrank a named skill.
 */
function commandScore(name: string, query: string): number | null {
  if (!query) return 0;
  const lower = name.toLowerCase();
  if (lower === query) return 1000;
  const prefix = lower.startsWith(query) ? 400 : 0;
  const match = fuzzyMatchPath(query, lower);
  if (!prefix && !match) return null;
  return prefix + (match?.score ?? 0);
}

function skillScore(skill: SkillInfo, query: string): number | null {
  if (!query) return 0;
  const nameScore = commandScore(skill.name, query);
  if (nameScore !== null) return nameScore;
  const match = fuzzyMatchTerms(query, skill.description.toLowerCase());
  return match ? -100 + Math.min(match.score, 50) : null;
}

/**
 * Completion candidates for the input box, CC's suggestion state machine in
 * miniature:
 * - `/` at the start of a line: built-in commands first, then skills (name and
 *   description match the query);
 * - `@` anywhere: a coding session searches the code project's file index
 *   (agent_list_project_files, gitignore respected); other modes reuse the
 *   quick switcher over the vault's notes (recently opened first).
 */
export function buildSuggestItems(input: {
  trigger: { kind: "skill" | "file"; query: string } | null;
  skills: SkillInfo[];
  flatFiles: string[];
  recentFiles: string[];
  vaultPath: string | null;
  currentFile: string | null;
  /** Coding sessions search the project instead of the vault; null = not loaded yet. */
  projectFiles: string[] | null;
}): SuggestItem[] {
  const { trigger, skills } = input;
  if (!trigger) return [];
  if (trigger.kind === "skill") {
    const q = trigger.query.trim().toLowerCase();
    // The list is complete (the popup scrolls and the keyboard walk scrolls
    // it), ordered by how well the name answers the query: exact, then prefix,
    // then any name match, then description-only matches.
    const scored: { item: SuggestItem; score: number }[] = [];
    for (const command of BUILTIN_COMMANDS) {
      const score = commandScore(command.name, q);
      if (score === null) continue;
      scored.push({
        item: {
          insert: `/${command.name}`,
          title: `/${command.name}`,
          subtitle: command.description,
          kind: "builtin",
        },
        score,
      });
    }
    for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
      const score = skillScore(skill, q);
      if (score === null) continue;
      scored.push({
        item: {
          insert: `/${skill.name}`,
          title: `/${skill.name}`,
          subtitle: skill.description || skill.path,
          kind: "skill",
        },
        score,
      });
    }
    // Stable: equal scores keep the order above (built-ins first, skills by name).
    return scored.sort((a, b) => b.score - a.score).map(({ item }) => item);
  }
  // A project index that has not loaded yet yields no file candidates rather
  // than silently falling back to the vault: the two stores are unrelated.
  const isProject = input.projectFiles != null;
  let files = input.projectFiles ?? input.flatFiles;
  // Empty query on a project shows the top level first (CC's ls behaviour):
  // shallow paths, then alphabetical. The vault keeps its recency order.
  if (isProject && trigger.query.trim() === "") {
    const depth = (p: string) => p.split("/").length;
    files = [...files].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  }
  const results = buildSwitcherResults(
    files,
    input.recentFiles,
    input.vaultPath,
    trigger.query,
    input.currentFile,
    15,
  );
  return results.map(({ item }) => ({
    insert: `@${item}`,
    title: item,
    kind: "file",
  }));
}

/** Completion overlay: shows the candidates, keyboard navigation is handled in the textarea's onKeyDown. */
export function AgentSuggest({
  kind,
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  kind: "skill" | "file";
  items: SuggestItem[];
  activeIndex: number;
  onPick: (item: SuggestItem) => void;
  onHover: (index: number) => void;
}) {
  const empty = useMemo(() => items.length === 0, [items]);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  // The highlighted item must stay inside the visible window: the full skill
  // list scrolls now, so the keyboard walk has to carry the scroll with it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items]);
  if (empty) return null;
  return (
    <div
      className="agent-suggest"
      role="listbox"
      aria-label={kind === "skill" ? "命令补全" : "文件引用补全"}
    >
      <div className="agent-suggest-head">
        {kind === "skill" ? "命令与技能(↑↓ 选择,Tab/Enter 选中)" : "引用文件(@路径,模型会自动读取)"}
      </div>
      {items.map((item, i) => (
        <button
          key={`${item.kind}:${item.insert}`}
          ref={i === activeIndex ? activeRef : undefined}
          role="option"
          aria-selected={i === activeIndex}
          className={`agent-suggest-item${i === activeIndex ? " is-active" : ""}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown instead of click: it fires before the textarea's blur, otherwise the overlay is already gone.
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="agent-suggest-title">{item.title}</span>
          {item.subtitle && <span className="agent-suggest-sub">{item.subtitle}</span>}
        </button>
      ))}
    </div>
  );
}

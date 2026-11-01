import { useMemo } from "react";

import { buildSwitcherResults } from "@/lib/switcher";
import type { SkillInfo } from "@/lib/tauri";

export interface SuggestItem {
  /** Text inserted on pick (the full form of the trigger, e.g. /html-blog or @notes/a.md). */
  insert: string;
  title: string;
  subtitle?: string;
}

/**
 * Completion candidates for the input box: "/" matches skills by name and
 * description, "@" reuses the quick switcher's search (recently opened first,
 * fuzzy on file name / path, see buildSwitcherResults).
 */
export function buildSuggestItems(input: {
  trigger: { kind: "skill" | "file"; query: string } | null;
  skills: SkillInfo[];
  flatFiles: string[];
  recentFiles: string[];
  vaultPath: string | null;
  currentFile: string | null;
}): SuggestItem[] {
  const { trigger, skills } = input;
  if (!trigger) return [];
  if (trigger.kind === "skill") {
    const q = trigger.query.trim().toLowerCase();
    const matched = skills.filter((s) => {
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      );
    });
    // Prefix matches first, the rest sorted stably by name
    matched.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.name.localeCompare(b.name);
    });
    return matched.slice(0, 8).map((s) => ({
      insert: `/${s.name}`,
      title: `/${s.name}`,
      subtitle: s.description || s.path,
    }));
  }
  const results = buildSwitcherResults(
    input.flatFiles,
    input.recentFiles,
    input.vaultPath,
    trigger.query,
    input.currentFile,
    8,
  );
  return results.map(({ item }) => ({
    insert: `@${item}`,
    title: item,
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
  if (empty) return null;
  return (
    <div className="agent-suggest" role="listbox" aria-label={kind === "skill" ? "技能补全" : "文件引用补全"}>
      <div className="agent-suggest-head">
        {kind === "skill" ? "技能(/名称,模型会先加载它的指导)" : "引用文件(@路径,模型会读取它)"}
      </div>
      {items.map((item, i) => (
        <button
          key={item.insert}
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

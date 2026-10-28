import { useMemo } from "react";

import { buildSwitcherResults } from "@/lib/switcher";
import type { SkillInfo } from "@/lib/tauri";

export interface SuggestItem {
  /** 插入文本(触发词的完整形态,如 /html-blog 或 @notes/a.md)。 */
  insert: string;
  title: string;
  subtitle?: string;
}

/**
 * 输入框补全候选:/ 按名称与描述匹配技能,@ 复用快速切换器的搜索
 * (最近打开优先 + 文件名/路径模糊,见 buildSwitcherResults)。
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
    // 前缀命中的排前面,其余按名称稳定排序
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

/** 补全弹层:展示候选,键盘导航在 textarea 的 onKeyDown 里处理。 */
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
            // mousedown 而不是 click:先于 textarea 的 blur,否则弹层先消失。
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

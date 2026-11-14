import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentMode } from "@/lib/tauri";
import { BASE_NAV_GROUPS, agentNavGroup, navGroups } from "./nav";

const ALL_MODES: AgentMode[] = ["coding", "creative", "study"];

function idsOf(group: { items: { id: string }[] }): string[] {
  return group.items.map((item) => item.id);
}

/**
 * The Agent pages are not cosmetic variants of one form: each mode's pages
 * have to match the files that mode reads (study has no tools at all, so no
 * MCP or skills page; only coding has the raw settings.json page).
 */
describe("the agent navigation follows the mode", () => {
  const ids = (mode: AgentMode) => agentNavGroup(mode).items.map((item) => item.id);

  it("gives coding the full surface", () => {
    expect(ids("coding")).toEqual([
      "agent-model",
      "agent-mcp",
      "agent-skills",
      "agent-instructions",
      "agent-advanced",
    ]);
    expect(agentNavGroup("coding").label).toBe("Agent · 编码");
  });

  it("gives creative the same surface without the raw settings page", () => {
    expect(ids("creative")).toEqual([
      "agent-model",
      "agent-mcp",
      "agent-skills",
      "agent-instructions",
    ]);
    expect(agentNavGroup("creative").label).toBe("Agent · 创作");
  });

  it("gives study only the model and AGENTS.md", () => {
    expect(ids("study")).toEqual(["agent-model", "agent-instructions"]);
    expect(agentNavGroup("study").label).toBe("Agent · 学习");
  });

  it("keeps the shared groups in front of the agent group", () => {
    const groups = navGroups("coding");
    expect(groups.map((group) => group.label)).toEqual([
      "常规",
      "笔记",
      "输入与命令",
      "学习",
      "Agent · 编码",
    ]);
  });
});

/**
 * Every section is reachable from the sidebar and the sidebar never shows the
 * same page twice. A missing id means a settings page nobody can open; a
 * duplicate means two nav entries fight over one tab.
 */
describe("the navigation lists every section exactly once", () => {
  it("covers every declared tab across the three modes", () => {
    const all = new Set(ALL_MODES.flatMap((mode) => navGroups(mode).flatMap(idsOf)));
    expect([...all].sort()).toEqual(
      [
        "agent-advanced",
        "agent-instructions",
        "agent-mcp",
        "agent-model",
        "agent-skills",
        "daily",
        "editor",
        "focus",
        "general",
        "hotkeys",
        "ime",
        "quickadd",
        "reading",
        "snippets",
        "templates",
        "translate",
        "vim",
      ].sort(),
    );
  });

  it("never repeats an id inside one mode", () => {
    for (const mode of ALL_MODES) {
      const ids = navGroups(mode).flatMap(idsOf);
      expect(ids, mode).toHaveLength(new Set(ids).size);
    }
  });

  it("keeps the base groups identical in every mode", () => {
    for (const mode of ALL_MODES) {
      expect(navGroups(mode).slice(0, BASE_NAV_GROUPS.length), mode).toEqual(BASE_NAV_GROUPS);
    }
  });

  it("is pure, so building the menu twice does not grow the shared groups", () => {
    expect(navGroups("coding")).toEqual(navGroups("coding"));
    expect(BASE_NAV_GROUPS).toHaveLength(4);
  });
});

/**
 * The nav is the single list of sections; the modal renders each one by id. A
 * section with no branch renders an empty page, and a branch with no nav entry
 * is dead. Both directions are checked against the source, the same way the
 * settings-row layout gate reads the stylesheet.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const modalSource = readFileSync(resolve(root, "src/components/SettingsModal.tsx"), "utf8");
const listed = new Set(ALL_MODES.flatMap((mode) => navGroups(mode).flatMap(idsOf)));
const rendered = new Set([...modalSource.matchAll(/tab === "([^"]+)"/g)].map((match) => match[1]));

describe("the navigation and the rendered pages agree", () => {
  it("renders a page for every listed section", () => {
    expect([...listed].filter((id) => !rendered.has(id))).toEqual([]);
  });

  it("renders no page the navigation cannot reach", () => {
    expect([...rendered].filter((id) => !listed.has(id))).toEqual([]);
  });
});

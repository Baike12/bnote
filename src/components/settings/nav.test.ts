import { describe, expect, it } from "vitest";
import { agentNavGroup, navGroups } from "./nav";

/**
 * The Agent pages are not cosmetic variants of one form: each mode's pages
 * have to match the files that mode reads (study has no tools at all, so no
 * MCP or skills page; only coding has the raw settings.json page).
 */
describe("the agent navigation follows the mode", () => {
  const ids = (mode: "coding" | "creative" | "study") =>
    agentNavGroup(mode).items.map((item) => item.id);

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

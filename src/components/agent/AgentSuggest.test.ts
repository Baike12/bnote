import { describe, expect, it } from "vitest";

import { buildSuggestItems, BUILTIN_COMMANDS, type SuggestItem } from "./AgentSuggest";
import type { SkillInfo } from "@/lib/tauri";

function skill(name: string, description = `${name} 的说明`): SkillInfo {
  return { name, description, path: `/skills/${name}/SKILL.md`, source: "home", root: "/skills" };
}

function input(partial: {
  trigger?: { kind: "skill" | "file"; query: string } | null;
  skills?: SkillInfo[];
  projectFiles?: string[] | null;
  flatFiles?: string[];
}) {
  return {
    trigger: partial.trigger ?? null,
    skills: partial.skills ?? [],
    flatFiles: partial.flatFiles ?? [],
    recentFiles: [],
    vaultPath: null,
    currentFile: null,
    projectFiles: partial.projectFiles ?? null,
  };
}

const names = (items: SuggestItem[]) => items.map((i) => i.title);

describe("buildSuggestItems: / commands and skills", () => {
  it("an empty query lists every skill after the built-ins, no cap", () => {
    const skills = Array.from({ length: 20 }, (_, i) => skill(`skill-${i}`));
    const items = buildSuggestItems(input({ trigger: { kind: "skill", query: "" }, skills }));
    expect(items).toHaveLength(BUILTIN_COMMANDS.length + 20);
    expect(names(items).slice(0, 3)).toEqual(["/compact", "/clear", "/help"]);
    expect(names(items)).toContain("/skill-19");
  });

  it("the query filters by name and description, prefix matches first", () => {
    const skills = [skill("reformat"), skill("compact-code", "让代码更紧凑"), skill("uncode")];
    const items = buildSuggestItems(input({ trigger: { kind: "skill", query: "co" }, skills }));
    expect(names(items)).toEqual(["/compact", "/compact-code", "/uncode"]);
  });

  it("an exact name wins over an earlier prefix", () => {
    const items = buildSuggestItems(
      input({ trigger: { kind: "skill", query: "help" }, skills: [skill("helper")] }),
    );
    expect(names(items)[0]).toBe("/help");
  });
});

describe("buildSuggestItems: @ file references", () => {
  it("an empty query on a project lists the top level first (shallow paths)", () => {
    const files = ["a/b/c/deep.py", "zz.py", "b/mid.py", "aa.py"];
    const items = buildSuggestItems(
      input({ trigger: { kind: "file", query: "" }, projectFiles: files }),
    );
    // The title is the bare path (the popup shows it without the trigger).
    expect(names(items)).toEqual(["aa.py", "zz.py", "b/mid.py", "a/b/c/deep.py"]);
  });

  it("a coding session with no index yet yields no candidates (never the vault)", () => {
    // [] is "coding, nothing loaded"; null means "not coding" and reads the vault.
    const items = buildSuggestItems(
      input({ trigger: { kind: "file", query: "" }, projectFiles: [], flatFiles: ["笔记.md"] }),
    );
    expect(items).toEqual([]);
  });

  it("outside code mode the vault notes are the candidates", () => {
    const items = buildSuggestItems(
      input({
        trigger: { kind: "file", query: "笔" },
        projectFiles: null,
        flatFiles: ["笔记.md", "日记/今天.md"],
      }),
    );
    expect(names(items)).toContain("笔记.md");
  });
});

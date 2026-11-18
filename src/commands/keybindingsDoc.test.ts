import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { renderKeybindingsDoc } from "./keybindingsDoc";
import "@/commands/builtin";

/**
 * `docs/keybindings.md` is the user-facing copy of the default keymap; it is
 * generated because the hand-written README table had already drifted from
 * `DEFAULT_BINDINGS` (a rebound key leaves no trace in prose).
 *
 * Regenerate with `pnpm docs:keybindings`.
 */
const PATH = "docs/keybindings.md";

describe("the keybindings doc is generated from the keymap", () => {
  it("matches DEFAULT_BINDINGS", () => {
    const expected = renderKeybindingsDoc();
    const actual = readFileSync(PATH, "utf8");
    if (process.env.UPDATE_DOCS === "1") {
      writeFileSync(PATH, expected);
      return;
    }
    expect(actual).toBe(expected);
  });

  it("lists every region that has bindings, under its 区 name", () => {
    const doc = renderKeybindingsDoc();
    const regions = ["global", "notes", "reading", "agent", "project", "code", "invest"] as const;
    for (const region of regions) {
      expect(doc).toContain(`(\`${region}\`)`);
    }
    for (const heading of [
      "## 全局区",
      "## 笔记区",
      "## 内容区",
      "## Agent区",
      "## 项目区",
      "## 代码区",
      "## 投资区",
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it("keeps the deliberately unbound commands out of the tables", () => {
    const doc = renderKeybindingsDoc();
    const tables = doc.split("## Unbound on purpose")[0]!;
    expect(tables).not.toContain("`view.toggle-code-mode`");
    expect(doc).toContain("## Unbound on purpose");
  });
});

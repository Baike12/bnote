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

  it("lists every region that has bindings", () => {
    const doc = renderKeybindingsDoc();
    for (const region of ["global", "notes", "reading", "agent", "project", "code"]) {
      expect(doc).toContain(`(\`${region}\`)`);
    }
  });

  it("keeps the deliberately unbound commands out of the tables", () => {
    const doc = renderKeybindingsDoc();
    const tables = doc.split("## Unbound on purpose")[0]!;
    expect(tables).not.toContain("`view.toggle-code-mode`");
    expect(doc).toContain("## Unbound on purpose");
  });
});

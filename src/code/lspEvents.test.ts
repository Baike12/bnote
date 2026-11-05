import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { sameProject } from "./events";

/**
 * Language server events are pushed, and a server of the previous project
 * keeps running until it is stopped: its diagnostics still arrive after the
 * switch. The paths in them are project-relative, so writing them into the
 * current project's store can collide with a real file name of the new
 * project (status is keyed by language, so it always collides).
 */
describe("a code event only belongs to the open project", () => {
  it("matches the root the backend attached, and nothing else", () => {
    expect(sameProject("/repo/a", "/repo/a")).toBe(true);
    expect(sameProject("/repo/a", "/repo/b")).toBe(false);
    // No project open, or a payload without a root (an older backend): drop it.
    expect(sameProject("/repo/a", undefined)).toBe(false);
    expect(sameProject(undefined, "/repo/a")).toBe(false);
  });

  it("every lsp handler consults it before writing to the store", () => {
    const src = readFileSync("src/code/events.ts", "utf8");
    for (const event of ["code-lsp-diagnostics", "code-lsp-status", "code-lsp-log"]) {
      const start = src.indexOf(`add("${event}"`);
      const handler = src.slice(start, src.indexOf("await add(", start + 1));
      expect(handler).toMatch(/!fromThisProject\(data\.root\)/);
    }
  });
});

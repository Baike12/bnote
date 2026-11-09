import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseDiagnostic, sameProject } from "./events";

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

describe("a diagnostic is narrowed at the IPC edge", () => {
  /**
   * The Rust side forwards the server's diagnostic as received and turns a
   * missing range into `null`. The problems panel draws `range.start.line`,
   * F8 cycles through the list and the lint source maps offsets, so a
   * range-less element that reached the store used to throw during render —
   * and an uncaught render error unmounts the whole app (blank window).
   */
  it("keeps a well-formed diagnostic", () => {
    const d = parseDiagnostic({
      range: { start: { line: 3, character: 7 }, end: { line: 3, character: 9 } },
      severity: 2,
      code: "E1",
      source: "ts",
      message: "boom",
    });
    expect(d).toEqual({
      range: { start: { line: 3, character: 7 }, end: { line: 3, character: 9 } },
      severity: 2,
      code: "E1",
      source: "ts",
      message: "boom",
    });
  });

  it("drops the elements the panel cannot place", () => {
    expect(parseDiagnostic({ range: null, message: "no range" })).toBeNull();
    expect(parseDiagnostic({ range: { start: { line: 0 } }, message: "no column" })).toBeNull();
    expect(
      parseDiagnostic({
        range: { start: { line: "1", character: 0 }, end: { line: 1, character: 1 } },
        message: "string line",
      }),
    ).toBeNull();
    expect(parseDiagnostic(null)).toBeNull();
    expect(parseDiagnostic("oops")).toBeNull();
  });

  it("fills the optional fields instead of leaving undefined in the store", () => {
    const d = parseDiagnostic({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    });
    expect(d).toMatchObject({ severity: 1, code: null, source: null, message: "" });
  });
});

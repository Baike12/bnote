import { describe, expect, it } from "vitest";
import { TODO_DRAG_MIME, decodeTodoDrag, encodeTodoDrag } from "./drag";

/**
 * The drag payload crosses an HTML5 dataTransfer boundary, which is plain
 * strings from arbitrary sources (another browser, a stale tab, the OS).
 * Decoding must reject everything that cannot name a real card line.
 */

describe("todo drag payload", () => {
  it("round-trips the source path and line", () => {
    const payload = { srcPath: "/vault/.bnote/projects-manager/读书.md", line: 12 };
    expect(decodeTodoDrag(encodeTodoDrag(payload))).toEqual(payload);
    expect(TODO_DRAG_MIME).toBe("application/x-bnote-todo");
  });

  it("floors a fractional line number", () => {
    expect(decodeTodoDrag(JSON.stringify({ srcPath: "/a.md", line: 3.9 }))).toEqual({
      srcPath: "/a.md",
      line: 3,
    });
  });

  it("rejects malformed payloads instead of producing a bad drop", () => {
    for (const raw of [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ line: 1 }),
      JSON.stringify({ srcPath: "", line: 1 }),
      JSON.stringify({ srcPath: "/a.md" }),
      JSON.stringify({ srcPath: "/a.md", line: 0 }),
      JSON.stringify({ srcPath: "/a.md", line: -1 }),
      JSON.stringify({ srcPath: "/a.md", line: "2" }),
      JSON.stringify({ srcPath: 42, line: 2 }),
    ]) {
      expect(decodeTodoDrag(raw), raw).toBeNull();
    }
  });
});

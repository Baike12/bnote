import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { treeKeyAction } from "./treeKeys";

/**
 * The file tree is browsed by keyboard after ⌘⇧E. Two hands have to work on it:
 * a file manager's (arrows + Enter) and a vim user's (`j` / `k` + Enter).
 * Both are one table, so the test locks the table and the fact that the tree
 * uses it — a second switch inside the component is how the motions went
 * missing in the first place.
 */

describe("tree key table", () => {
  it("maps vim motions and arrows to the same intents", () => {
    expect(treeKeyAction({ key: "j" })).toBe("down");
    expect(treeKeyAction({ key: "ArrowDown" })).toBe("down");
    expect(treeKeyAction({ key: "k" })).toBe("up");
    expect(treeKeyAction({ key: "ArrowUp" })).toBe("up");
  });

  it("keeps the file manager keys", () => {
    expect(treeKeyAction({ key: "Home" })).toBe("first");
    expect(treeKeyAction({ key: "End" })).toBe("last");
    expect(treeKeyAction({ key: "ArrowRight" })).toBe("right");
    expect(treeKeyAction({ key: "ArrowLeft" })).toBe("left");
    expect(treeKeyAction({ key: "Enter" })).toBe("activate");
    expect(treeKeyAction({ key: " " })).toBe("activate");
    expect(treeKeyAction({ key: "Escape" })).toBe("release");
  });

  it("leaves modified keys to the command chords", () => {
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(treeKeyAction({ key: "j", [modifier]: true })).toBeNull();
      expect(treeKeyAction({ key: "k", [modifier]: true })).toBeNull();
      expect(treeKeyAction({ key: "ArrowDown", [modifier]: true })).toBeNull();
    }
  });

  it("ignores keys that are not motions", () => {
    for (const key of ["a", "G", "h", "l", "Tab", "Backspace"]) {
      expect(treeKeyAction({ key })).toBeNull();
    }
  });
});

describe("the tree has no second key switch", () => {
  it("resolves every key through the table", () => {
    const source = readFileSync("src/code/components/FileTree.tsx", "utf8");
    expect(source).toContain("treeKeyAction(event)");
    // No literal key comparison may survive beside the table: that is how the
    // arrows worked while `j` / `k` did nothing.
    expect(source).not.toMatch(/event\.key\s*===/);
    expect(source).not.toMatch(/case "(ArrowDown|ArrowUp|Enter|Escape|j|k)":/);
  });
});

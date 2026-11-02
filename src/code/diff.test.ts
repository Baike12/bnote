import { describe, expect, it } from "vitest";
import { alignHunk, diffStats, parseUnifiedDiff } from "./diff";

/**
 * Gate for unified diff parsing and side-by-side alignment.
 *
 * The backend provides the raw `git diff --no-color` text and the parsing
 * happens on the frontend: the line numbers have to be right (additions and
 * deletions each run their own counter) and the side-by-side view has to pair
 * the changed lines (via a longest common subsequence, not by matching them up
 * in order).
 */

const SAMPLE = `diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,4 @@
 fn main() {
-    println!("old");
+    println!("new");
 }
`;

describe("parseUnifiedDiff", () => {
  it("parses the file path and the hunk", () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0];
    expect(file.oldPath).toBe("src/main.rs");
    expect(file.newPath).toBe("src/main.rs");
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].oldStart).toBe(1);
    expect(file.hunks[0].newStart).toBe(1);
  });

  it("line numbers advance separately for additions and deletions", () => {
    const hunk = parseUnifiedDiff(SAMPLE).files[0].hunks[0];
    const lines = hunk.lines;
    expect(lines[0]).toMatchObject({ type: "context", oldLine: 1, newLine: 1 });
    expect(lines[1]).toMatchObject({ type: "remove", oldLine: 2, newLine: null });
    expect(lines[2]).toMatchObject({ type: "add", oldLine: null, newLine: 2 });
    expect(lines[3]).toMatchObject({ type: "context", oldLine: 3, newLine: 3 });
  });

  it("an added file has a new path and /dev/null as its old path", () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;
    const file = parseUnifiedDiff(diff).files[0];
    expect(file.oldPath).toBeNull();
    expect(file.newPath).toBe("new.txt");
    expect(file.hunks[0].lines).toHaveLength(2);
  });

  it("a deleted file has /dev/null as its new path", () => {
    const diff = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;
    const file = parseUnifiedDiff(diff).files[0];
    expect(file.oldPath).toBe("gone.txt");
    expect(file.newPath).toBeNull();
  });

  it("multiple files become separate sections", () => {
    const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-x
+y
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-p
+q
`;
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files.map((f) => f.newPath)).toEqual(["a.txt", "b.txt"]);
  });

  it("empty input does not throw", () => {
    expect(parseUnifiedDiff("").files).toEqual([]);
  });
});

describe("alignHunk", () => {
  it("the changed line is paired on the left and the right", () => {
    const hunk = parseUnifiedDiff(SAMPLE).files[0].hunks[0];
    const rows = alignHunk(hunk);
    const removed = rows.find((r) => r.left?.type === "remove");
    expect(removed?.right?.type).toBe("add");
    expect(removed?.left?.text).toBe('    println!("old");');
    expect(removed?.right?.text).toBe('    println!("new");');
  });

  it("an added-only line leaves the left side empty", () => {
    const diff = `--- a/x
+++ b/x
@@ -1,1 +1,2 @@
 keep
+added
`;
    const hunk = parseUnifiedDiff(diff).files[0].hunks[0];
    const rows = alignHunk(hunk);
    const added = rows.find((r) => r.right?.type === "add");
    expect(added?.left).toBeNull();
    expect(added?.right?.text).toBe("added");
  });

  it("a removed-only line leaves the right side empty", () => {
    const diff = `--- a/x
+++ b/x
@@ -1,2 +1,1 @@
 keep
-gone
`;
    const hunk = parseUnifiedDiff(diff).files[0].hunks[0];
    const rows = alignHunk(hunk);
    const removed = rows.find((r) => r.left?.type === "remove");
    expect(removed?.right).toBeNull();
  });
});

describe("diffStats", () => {
  it("counts the added and removed lines", () => {
    expect(diffStats(parseUnifiedDiff(SAMPLE))).toEqual({ added: 1, removed: 1 });
  });
});

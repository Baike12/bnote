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

describe("alignHunk: a hunk too large for the LCS table", () => {
  /**
   * A regenerated file produces a removal run and an addition run of tens of
   * thousands of lines. The (n+1)x(m+1) table used to be allocated inside
   * render, which throws RangeError and unmounts the whole app. Past the
   * budget the rows are paired by position instead: every line still shows.
   */
  it("pairs by position and keeps every line", () => {
    const big = 1200;
    const lines: string[] = ["@@ -1," + big + " +1," + big + " @@"];
    for (let i = 0; i < big; i += 1) lines.push(`-old ${i}`);
    for (let i = 0; i < big; i += 1) lines.push(`+new ${i}`);
    const hunk = parseUnifiedDiff(`--- a/x\n+++ b/x\n${lines.join("\n")}\n`).files[0].hunks[0];
    const rows = alignHunk(hunk);
    expect(rows).toHaveLength(big);
    expect(rows[0]?.left?.text).toBe("old 0");
    expect(rows[0]?.right?.text).toBe("new 0");
    expect(rows[big - 1]?.left?.text).toBe(`old ${big - 1}`);
  });
});

describe("parseUnifiedDiff: the lines git adds around a hunk", () => {
  it("the hunk section heading is kept", () => {
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn main\n-a\n+b\n").files[0]
      .hunks[0];
    expect(hunk.section).toBe("fn main");
  });

  it("a missing count in the header means one line", () => {
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n").files[0].hunks[0];
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });

  it('"\\ No newline at end of file" is a meta line and moves no counter', () => {
    const hunk = parseUnifiedDiff(
      "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n\\ No newline at end of file\n c\n",
    ).files[0].hunks[0];
    expect(hunk.lines.map((l) => l.type)).toEqual(["remove", "add", "meta", "context"]);
    expect(hunk.lines[2]).toMatchObject({ text: "No newline at end of file" });
    // The context line after the marker continues where the counters were.
    expect(hunk.lines[3]).toMatchObject({ oldLine: 2, newLine: 2 });
  });

  it("an empty line inside a hunk is a context line (not the end of the hunk)", () => {
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-a\n+b\n").files[0]
      .hunks[0];
    expect(hunk.lines[1]).toMatchObject({ type: "context", text: "", oldLine: 2, newLine: 2 });
  });

  it("lines with an unknown prefix are dropped, not read as context", () => {
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n?weird\n-a\n+b\n").files[0]
      .hunks[0];
    expect(hunk.lines.map((l) => l.type)).toEqual(["remove", "add"]);
  });

  it("a replayed patch line before any hunk is ignored", () => {
    const parsed = parseUnifiedDiff("--- a/x\n+++ b/x\n+a line with no hunk\n");
    expect(parsed.files[0].hunks).toEqual([]);
  });

  it("a path without the a/ b/ prefix is kept as it is", () => {
    const file = parseUnifiedDiff("--- x.txt\n+++ x.txt\n@@ -1 +1 @@\n-a\n+b\n").files[0];
    expect([file.oldPath, file.newPath]).toEqual(["x.txt", "x.txt"]);
  });

  it("a section that is only whitespace collapses to an empty heading", () => {
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@   \n-a\n+b\n").files[0].hunks[0];
    expect(hunk.section).toBe("");
  });
});

describe("alignHunk: the LCS pairing", () => {
  it("an unchanged line inside a replaced block stays aligned as context", () => {
    // The block "a / keep / c" became "x / keep / z": "keep" is the common
    // subsequence and must sit on one row, not drift to the right.
    const hunk = parseUnifiedDiff(
      "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n+one\n keep\n-c\n+three\n",
    ).files[0].hunks[0];
    const rows = alignHunk(hunk);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ left: { text: "keep" }, right: { text: "keep" } });
    expect(rows[0]).toMatchObject({ left: { text: "a" }, right: { text: "one" } });
    expect(rows[2]).toMatchObject({ left: { text: "c" }, right: { text: "three" } });
  });

  it("a meta line inside a hunk occupies its own row on the left only", () => {
    const hunk = parseUnifiedDiff(
      "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n",
    ).files[0].hunks[0];
    const rows = alignHunk(hunk);
    const meta = rows.find((r) => r.left?.type === "meta");
    expect(meta?.right).toBeNull();
  });

  it("a pure removal followed by a pure addition pairs by position", () => {
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n-b\n+x\n+y\n").files[0]
      .hunks[0];
    expect(alignHunk(hunk)).toEqual([
      {
        left: expect.objectContaining({ text: "a" }),
        right: expect.objectContaining({ text: "x" }),
      },
      {
        left: expect.objectContaining({ text: "b" }),
        right: expect.objectContaining({ text: "y" }),
      },
    ]);
  });
});

describe("alignHunk: a changed run with a shared line", () => {
  it("the shared line is paired on one row and the rest pairs by position", () => {
    // The run is "-b -same +same +x": "same" is the common subsequence, so it
    // gets one row on both sides; "b" (left only) and "x" (right only) keep
    // their own rows instead of being shifted onto each other.
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n ctx\n-b\n-same\n+same\n+x\n")
      .files[0].hunks[0];
    const rows = alignHunk(hunk);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["ctx", "ctx"],
      ["b", null],
      ["same", "same"],
      [null, "x"],
    ]);
  });

  it("a replaced block with no shared line pairs each removal with the addition below it", () => {
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n-b\n+x\n+y\n").files[0]
      .hunks[0];
    const rows = alignHunk(hunk);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
  });
});

describe("lcsPairs: the backtracking direction", () => {
  it("skips an addition before the first common line", () => {
    // removed = [a], added = [b, a]: the pair is (0 → 1), so the walk has to
    // advance the right side first.
    const hunk = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,1 +1,2 @@\n-a\n+b\n+a\n").files[0]
      .hunks[0];
    const rows = alignHunk(hunk);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      [null, "b"],
      ["a", "a"],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { alignHunk, diffStats, parseUnifiedDiff } from "./diff";

/**
 * unified diff 解析与并排对齐的门禁。
 *
 * 后端给的是 `git diff --no-color` 的原始文本,解析在前端做:行号要准
 * (增删各走各的行号计数器)、并排视图要把改动过的行配对(靠最长公共子序列,
 * 不是按顺序硬凑)。
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
  it("解析出文件路径与 hunk", () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0];
    expect(file.oldPath).toBe("src/main.rs");
    expect(file.newPath).toBe("src/main.rs");
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].oldStart).toBe(1);
    expect(file.hunks[0].newStart).toBe(1);
  });

  it("行号按增删各自推进", () => {
    const hunk = parseUnifiedDiff(SAMPLE).files[0].hunks[0];
    const lines = hunk.lines;
    expect(lines[0]).toMatchObject({ type: "context", oldLine: 1, newLine: 1 });
    expect(lines[1]).toMatchObject({ type: "remove", oldLine: 2, newLine: null });
    expect(lines[2]).toMatchObject({ type: "add", oldLine: null, newLine: 2 });
    expect(lines[3]).toMatchObject({ type: "context", oldLine: 3, newLine: 3 });
  });

  it("新增文件的新路径存在、旧路径是 /dev/null", () => {
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

  it("删除文件的新路径是 /dev/null", () => {
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

  it("多文件各自成段", () => {
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

  it("空输入不炸", () => {
    expect(parseUnifiedDiff("").files).toEqual([]);
  });
});

describe("alignHunk", () => {
  it("改动过的同一行左右配对", () => {
    const hunk = parseUnifiedDiff(SAMPLE).files[0].hunks[0];
    const rows = alignHunk(hunk);
    const removed = rows.find((r) => r.left?.type === "remove");
    expect(removed?.right?.type).toBe("add");
    expect(removed?.left?.text).toBe('    println!("old");');
    expect(removed?.right?.text).toBe('    println!("new");');
  });

  it("纯新增的行左边留空", () => {
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

  it("纯删除的行右边留空", () => {
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
  it("统计新增与删除行数", () => {
    expect(diffStats(parseUnifiedDiff(SAMPLE))).toEqual({ added: 1, removed: 1 });
  });
});

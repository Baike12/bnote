import { execSync } from "node:child_process";

/**
 * `pnpm test:related` — run the unit+integration tests related to the
 * working-tree diff. Wrapper because vitest `related` exits 0 with "no test
 * files found" on a clean tree, which reads as green (a silent success is a
 * broken lock — docs/TESTING.md flake policy).
 */
function changedFiles() {
  const run = (cmd) => execSync(cmd, { encoding: "utf8" }).split("\n").filter(Boolean);
  const tracked = run("git diff --name-only HEAD");
  const untracked = run("git ls-files -o --exclude-standard");
  return [...new Set([...tracked, ...untracked])]
    .filter((f) => f.startsWith("src/") && /\.(ts|tsx)$/.test(f))
    .filter((f) => fs.existsSync(f));
}

import fs from "node:fs";
const files = changedFiles();
if (files.length === 0) {
  console.error("test:related: no changed files under src/ — nothing to run.");
  process.exit(1);
}
console.log(`test:related: ${files.length} changed file(s)`);
const args = [
  "vitest",
  "related",
  "--run",
  "--project",
  "unit",
  "--project",
  "integration",
  ...files,
];
try {
  execSync(`pnpm exec ${args.join(" ")}`, { stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 1);
}

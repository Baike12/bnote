#!/usr/bin/env node
/**
 * Summarize the editor performance log written by src/perf/sink.ts.
 *
 * Usage:
 *   pnpm perf:report
 *   node scripts/perf-report.mjs --vault /path/to/vault
 *   node scripts/perf-report.mjs --file <editor-YYYY-MM-DD.jsonl> --last 200
 *
 * The output is deliberately small: the slow keys first (the number the user
 * felt), then long tasks, then per-phase spans. A slow key names its phases in
 * `recent`, so an unexplained gap points at a missing span (add it in the same
 * change).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const vault = arg("--vault", join(homedir(), "Documents", "baike"));
const explicitFile = arg("--file", null);
const last = Number(arg("--last", "0")) || 0;
const dir = join(vault, ".bnote", "perf");

function files() {
  if (explicitFile) return [explicitFile];
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^editor-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

const sources = files();
if (sources.length === 0) {
  console.error(`no perf log found in ${dir}`);
  process.exit(1);
}

const records = [];
for (const file of sources) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    continue;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn final line is expected when the app is writing: skip it.
    }
  }
}

const selected = last > 0 ? records.slice(-last) : records;
if (selected.length === 0) {
  console.error("no records");
  process.exit(1);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

const ms = (n) => `${Number(n).toFixed(1)}ms`;
const stamp = (t) => new Date(t).toLocaleTimeString();

const keys = selected.filter((r) => r.kind === "key");
const longTasks = selected.filter((r) => r.kind === "longtask");
const spans = selected.filter((r) => r.kind === "span");
const sessions = selected.filter((r) => r.kind === "session");

console.log(`perf report — ${sources.join(", ")}`);
console.log(
  `records: ${selected.length} (keys ${keys.length}, long tasks ${longTasks.length}, spans ${spans.length})`,
);
const session = sessions[sessions.length - 1];
if (session) {
  console.log(`last session: ${JSON.stringify(session.data)}`);
}

if (keys.length > 0) {
  const values = keys.map((r) => r.ms).sort((a, b) => a - b);
  console.log(
    `\nkeys: p50 ${ms(percentile(values, 0.5))} · p90 ${ms(percentile(values, 0.9))} · p99 ${ms(percentile(values, 0.99))} · max ${ms(values[values.length - 1])}`,
  );
  console.log("slowest keys (keydown → painted frame):");
  for (const r of [...keys].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
    const d = r.data ?? {};
    const phases = (r.recent ?? [])
      .filter((s) => s.ms >= 1)
      .map((s) => `${s.name} ${ms(s.ms)}`)
      .join(", ");
    console.log(
      `  ${stamp(r.t)}  ${JSON.stringify(r.name)}  total ${ms(r.ms)}  update ${ms(d.updateMs ?? 0)}  doc ${d.docLines ?? "?"}L/${d.docBytes ?? "?"}B  tx ${d.transactions ?? "?"}${d.composing ? "  [composing]" : ""}${phases ? `\n      phases: ${phases}` : ""}`,
    );
  }
}

if (longTasks.length > 0) {
  const values = longTasks.map((r) => r.ms).sort((a, b) => a - b);
  console.log(
    `\nlong tasks: ${longTasks.length} · p50 ${ms(percentile(values, 0.5))} · p95 ${ms(percentile(values, 0.95))} · max ${ms(values[values.length - 1])}`,
  );
  for (const r of [...longTasks].sort((a, b) => b.ms - a.ms).slice(0, 8)) {
    const phases = (r.recent ?? [])
      .filter((s) => s.ms >= 1)
      .map((s) => `${s.name} ${ms(s.ms)}`)
      .join(", ");
    console.log(`  ${stamp(r.t)}  ${ms(r.ms)}  ${phases || "(no phase spans)"}`);
  }
}

if (spans.length > 0) {
  const byName = new Map();
  for (const r of spans) {
    const list = byName.get(r.name) ?? [];
    list.push(r.ms);
    byName.set(r.name, list);
  }
  console.log("\nspans (recorded only at ≥25ms or while full tracing):");
  for (const [name, values] of [...byName.entries()].sort(
    (a, b) => Math.max(...b[1]) - Math.max(...a[1]),
  )) {
    console.log(
      `  ${name.padEnd(24)} n ${String(values.length).padStart(4)} · p50 ${ms(percentile(values, 0.5))} · p95 ${ms(percentile(values, 0.95))} · max ${ms(Math.max(...values))}`,
    );
  }
}

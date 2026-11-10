---
name: bnote-performance
description: Review and diagnose bnote performance the way the owner's lifeline requires (per-keystroke budget, no O(document) scans, no forced layout, no key-path IPC). Use when reviewing a hot-path change (src/editor, src/daily, src/footprint, src/python/lsp.ts, any update listener/decoration/widget), when the user reports "卡顿 / 慢 / 延迟 / jank", or when a change is about to be called done. Runs the perf gate, reads the JSONL trace, names the root cause from evidence, and reports file:line findings; it does not guess and does not edit code unless asked.
---

# Reviewing and diagnosing bnote performance

`docs/PERFORMANCE.md` is the contract; read it first. This skill turns it into
a repeatable pass: evidence, attribution, findings. Do not edit code during a
review — report first, fix only when the user asks.

**A subagent may run this skill read-only.** When the caller gives a report
path, write the final report there (markdown) and keep the reply short;
otherwise print it. Every finding needs a `file:line`, a severity, the root
cause and the evidence that proves it. "Feels fine" is not evidence.

## 1. Scope the diff

```bash
git status --porcelain
git diff --stat
git diff -- src/editor src/daily src/footprint src/python src/perf
```

Classify every touched file:

- **Hot path** — runs per keystroke: `updateListener`, `ViewPlugin.update`,
  `StateField.update`, `inputHandler`, keymaps, `EditorView.update`,
  `requestMeasure`, decorations, widgets, `docChanged` branches.
- **Warm** — runs per cursor move / viewport change.
- **Cold** — file switch, settings, commands, backend.

Only hot-path changes need the full gate; say so explicitly for warm/cold.

## 2. Evidence (must run, not inferred)

| Check | Command |
|---|---|
| Full gate | `pnpm gate` |
| Editor budgets | `pnpm vitest run src/editor/perf.gate.test.ts` |
| Code-pane budgets | `pnpm vitest run src/code/perf.gate.test.ts` |
| Rust / native | `cd src-tauri && cargo fmt --check && cargo check && cargo test --lib` |
| IME switch cost | `cd src-tauri && cargo test --lib probe_switch_sources -- --nocapture` |
| The trace | `pnpm perf:report` (or `node scripts/perf-report.mjs --vault <vault> --last 200`) |

Browser measurement (only when geometry/feel changed): DEBUG.md protocol with
browseros, one tab group per task, session handle on every call, DOM assertions
and bytes on disk as the source of truth. Record the document size, the keys,
and before/after numbers from the **same** document.

## 3. The hot-path checklist (report each as pass/fail with proof)

1. **O(document) per keystroke.** Search the diff for `doc.toString()`,
   `doc.iterLines()`, `syntaxTree(...).iterate` over the whole document,
   `new Array(doc.lines)`, and `WeakMap<Text|EditorState, …>` full scans. A hit
   is a blocker unless it is behind a state field that maps + invalidates.
2. **Forced layout.** `coordsAtPos`, `getBoundingClientRect`, `scrollTop`,
   `offsetHeight`, `getComputedStyle` inside `update`/update listener/
   inputHandler. The editor allows exactly two sites (`cursor.flush`,
   `typewriter.measure`); a third is a finding.
3. **Update-cycle count.** A `dispatch` from a plugin/update listener is a
   second full cycle; a plugin→effect→dispatch round trip is a finding, a state
   field is the fix.
4. **Key-path async.** `await`/IPC/file write in an input path; background
   legs must be debounced and re-validate their target.
5. **Rendering cost.** New widget without `eq()`, un-cached KaTeX/Markdown
   render, `innerHTML` built per keystroke.
6. **Gates.** Behavior test next to the module; perf gate extension when a
   per-keystroke path changed; a full-document scan absent is proven by the
   `math.scan` / `callout.scan` span count staying 0 across ordinary keys.
7. **Instrumentation.** New hot phase has a `perfStart`/`perfEnd` span named
   `area.phase`; no allocation/JSON on that path.

## 4. Diagnosing a reported lag (the trace playbook)

1. Reproduce with the user's exact keys and note the document size.
2. Start full tracing: command palette → **性能:开始详细追踪 2 分钟** (or
   `window.__bnotePerf.start(120)`), reproduce, then **性能:停止详细追踪并打印汇总**.
3. `pnpm perf:report`. Read the slowest `key` records first:
   - `ms ≈ updateMs` → the state/decoration pipeline. Look at `recent` spans.
   - `ms ≫ updateMs` → the block is outside the update: layout/paint or the
     native IME leg. A small `ime.switch` span with a large `ms` points at
     TIS/Sogou activation (native; verify with the Rust probe, say it cannot be
     proven in the browser).
   - `math.scan` / `callout.scan` in `recent` on ordinary keys → a
     full-document scan regressed; find which field stopped mapping.
   - `katex.render` large or repeated → an un-cached/`eq()`-broken widget.
   - A large unaccounted gap → the phase has no span; add one in the fix.
4. Fix the model, then rerun the same protocol and put both numbers in the
   report.

## 5. The known math/Tab + IME case (regression playbook)

- `$|$` (the `ma` / `##@` snippet output) must be an **inline** empty formula,
  not a `$$` block opener; otherwise the rest of the paragraph becomes math
  source and Tab has nowhere to go. Locked by
  `src/editor/mathScan.test.ts` ("the ma shape").
- A snippet session that ends **in place** (its finalPos is the closing
  delimiter) must hand the same Tab to tabout; consuming it makes one Tab do
  nothing and the next insert indentation. Locked by
  `src/editor/snippets/session.test.ts` ("ending in place").
- Leaving a formula switches the IME to the insert source. TIS is main-thread
  native: ~2–7 ms warm, ~73–88 ms cold, macism fallback ~150 ms+. The browser
  cannot measure it; use `ime.switch` spans and the Rust probe, and state that
  the platform claim needs a deployed check.

## 6. Report format

```markdown
# Performance review — <change>

Verdict: PASS / PASS WITH FINDINGS / BLOCK

Evidence: <commands run, key numbers, doc size>

## Findings
### [P1] <title> — <file:line>
- Root cause: <data flow / ordering / geometry model>
- Evidence: <measurement or trace record>
- Fix: <the model change, not a special case>

## Budgets
| Path | Before | After | Budget |
```

Severity: **P0** = the notes area janks/freezes or a gate is red; **P1** = an
O(document) scan, a forced layout, or a key-path round trip; **P2** = a missing
gate/span or a warm-path inefficiency. No style noise.

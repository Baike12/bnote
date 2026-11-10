---
name: bnote-review
description: Review a bnote change the way the Claude Code team reviews theirs (layers, evidence, fresh-context reviewers, converging findings). Use when the user asks for "review" / "检视" / "审一下这个改动" / "提交前看看", or when a change is about to be called done. It reads REVIEW.md (the code-owner rules) and AGENTS.md, collects runnable evidence, runs independent reviewers over the diff, filters style noise, and reports file:line findings with severity counts.
---

# Reviewing a bnote change

The process follows Anthropic's Claude Code review post
(<https://x.com/addyosmani/status/2114604912520921136>), adapted to a local
single-repository project: layers instead of one gate, evidence instead of "done",
independent reviewers instead of one pass, and a review that converges.
`REVIEW.md` is the contract this process enforces — read it first, it decides what
counts as a defect.

Do not edit code during the review. Report first; fix only when the user asks.

## Scope

Default: everything not on `main`, plus the working tree.

```bash
git diff --stat main...HEAD        # committed on the branch
git diff --stat                    # uncommitted
git status --porcelain             # untracked files are part of the change too
```

`src-tauri/target/`, `node_modules/`, `src-tauri/gen/`, `vendor/` and generated
`docs/keybindings.md` are excluded (REVIEW.md §5).

## Layer 1 — runnable evidence

The change must show what it ran, not that it "works":

| Change | Evidence |
|---|---|
| Front end | `pnpm gate` (lint + typecheck + format + tests) |
| Rust | `cargo fmt --check`, `cargo check`, `cargo test --lib` |
| Behaviour that tests cannot reach | a browser assertion against `localhost:1430`, or bytes read back from disk |
| Layout / feel | a measurement or DOM assertion; screenshots alone are not a number |

Missing evidence is a finding by itself (`Important` when the change claims a
behaviour nobody proved). Machine load can fail the perf gates: check `uptime`,
re-run the failing test alone, and report the real result.

## Layer 2 — independent reviewers over the diff

Spawn reviewers with **fresh context**: each gets the diff and the files it
touches, never the author's reasoning. Run them in parallel, one per lens:

1. **Bug hunt** — wrong state, stale writes, races, off-by-one, error paths that
   swallow a failure, a promise nobody awaits.
2. **Fit** — does it follow the module's existing shape (`AGENTS.md`: one writer,
   thin command surface, pure logic outside UI, `devbridge.rs` parity, three
   command registrations)?
3. **Security / boundary** — path traversal, IPC input, `assetProtocol` scope,
   shell, credentials reaching a transcript.

Ask each for `file:line` + failure + severity, and tell them explicitly: no style,
no naming, no formatting (REVIEW.md §4).

## Layer 3 — vote, then filter

A finding is confirmed only when a second reviewer (or a direct check of the code)
agrees it is real. Drop the rest as false positives. Then filter:

- style / diagnostics / cleanup only → drop;
- already answered in the thread → drop;
- not introduced by this diff → `Pre-existing`, report separately;
- repo-wide class (the same mistake in five places) → one finding naming the class,
  not five findings.

Never inflate the count with non-bugs: false positives make the next review slower.

## Layer 4 — report

Order by severity, one block per finding:

```
Important  src/path/file.ts:42  The control keeps width: 260px inside a row that
           cannot wrap, so the label collapses to one character per line.
           Fix: let the row wrap and the control shrink (REVIEW.md §8.1).
Nit        src/path/other.ts:10  The comment says "cached" but the value is
           recomputed each call.
Pre-existing …
```

End with the counts and an explicit verdict:

```
Important 0 · Nit 2 · Pre-existing 1 — no blocking issues.
```

or `No issues`. A verdict without a count is not a verdict.

## Layer 5 — converge

- One round per pass, at most **three** on a change; then question the approach.
- Re-review the diff only after the first round.
- Do not re-report a finding that was fixed, clarified, or accepted.
- When an Important finding turns out to be a class (the same bug elsewhere), say
  so once and name every site.

## When the review finds a gateable class

If a finding can be locked mechanically, add the gate in the same change: a unit
test for the module, a source gate (like `settingRowLayout.test.ts` or
`src/app/csp.gate.test.ts`), a lint rule, or a line in `REVIEW.md` §8. A review
that only comments does not stop the bug from returning.

## What stays human

Decide what to build (vision, taste, scope), audit dangerous code (billing, focus
lock, auto-updater, CI), own architecture choices, verify the evidence (if you
cannot say what a check would miss, you do not have one), and answer for what
ships.

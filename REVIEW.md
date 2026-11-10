# REVIEW.md — what a reviewer must catch in bnote

Code owners write this file for the reviewer; it is the part of the review that
`AGENTS.md` does not cover. `AGENTS.md` says how the project is built, this file says
what counts as a defect here and when to stop. It follows Anthropic's Claude Code
review process (<https://x.com/addyosmani/status/2114604912520921136>): layers instead
of one gate, evidence instead of "done", findings with `file:line`, and a review that
converges.

Keep this file brief. Every review reads it; a long file stops being read.

## 1. What counts as failure here

Report these as **Important** with `file:line` and the failure, never as taste:

- **The docs lie.** `README.md`, `README.zh-CN.md`, `docs/keybindings.md` or the
  settings copy disagree with the code (a setting that does nothing, a keybinding
  that is not bound, a path that moved).
- **The config misroutes.** A stored path points at the wrong root: an agent
  credential in a transcript, a session record under the vault instead of the agent
  home, a mode reading another mode's `settings.json`.
- **Two writers.** A value kept in a store and mirrored in component state, or two
  async paths that can both write it. The review asks which one owns it.
- **A hot path got slower.** Anything touching input transactions, decoration
  rebuilds, `updateListener`, measure cycles or scrolling needs a number before and
  after; "feels fine" is not evidence.
- **A layout that overflows its container.** Text squeezed to one character per
  line, a control painted across a card border, a popover clipped by the panel.
- **Native-only behaviour claimed as verified.** Window levels, event taps, IME and
  WKWebView rendering cannot be proven in a browser; say so instead of accepting
  "it works".
- **A false comment.** A comment or doc comment that describes behaviour the code
  does not have — that is the same class as a lying doc.

## 2. Layers, not one gate

Each layer is cheap and catches a different class; no layer is sufficient alone.

1. **Runnable evidence before the diff.** The change shows what it ran:
   `pnpm gate`, `cargo test --lib`, a browser assertion, bytes read back from disk.
   "Done" without output is not reviewable. A change that says it verified something
   must show the command or the assertion that proves it.
2. **Fresh-context review of the diff.** A reviewer that did not write the change
   reads the diff against the whole file, not the summary: does it fix the stated
   problem, does it fit the module, can it break a caller.
3. **Security review.** Any new IPC command, path join, `assetProtocol` scope or
   shell invocation is checked for traversal and for what crosses the boundary.
   An open security finding blocks the change.
4. **Blocking checks.** `pnpm gate` (lint, typecheck, format, tests) and, for Rust:
   `cargo fmt`, `cargo check`, `cargo test --lib`. These block; they are not advice.
5. **Human review scaled by risk.** Settings and agent plumbing get a real read;
   window/focus/native and security-sensitive changes get a deployed check by a
   person. An agent's approval never stands in for the human one.
6. **Rollback.** Each change must be revertible alone: no mixed refactor, no hidden
   behaviour change in a rename.

## 3. Findings format

Every finding names **`file:line`**, the **failure it causes**, and a severity:

- `Important` — ships a bug, a data loss, a lie in the docs, or a regression.
- `Nit` — correctness of reading, not behaviour. Never blocks.
- `Pre-existing` — not introduced by this diff. Reported, not blamed.

A review ends with a top-level summary: the count per severity and an explicit
`No issues` when there are none. A verdict without a count is not a verdict.
Findings are ordered by severity; style-only findings are filtered out before
anyone reads them.

## 4. Do not nitpick

No comment on: formatting (Prettier and rustfmt own it), import order, naming taste,
comment wording, or a refactor the diff did not touch. Same test, same copy, same
behaviour is not a finding. If a rule matters, it belongs in lint, a test, or this
file — not in a comment that the next author will forget.

## 5. Ignored paths

`src-tauri/target/`, `node_modules/`, `src-tauri/gen/`, `vendor/`, and generated
`docs/keybindings.md` are not read by hand. The keybinding table is verified by its
own gate (`pnpm docs:keybindings` byte comparison), not by reading it.

## 6. Convergence

A review must converge; an agent author and an agent reviewer can otherwise cycle
forever.

- After **three** cycles on one change, re-evaluate the approach instead of another
  round.
- After the first cycle, re-review **the diff only**, not the whole file again.
- Report the **class** of a problem once (every place it occurs), not the same line
  three times.
- Never re-report a finding that was answered (fixed, clarified as intentional, or
  decided not to matter).

## 7. How we check the reviewer

- **Incidents are the eval.** Every bug that reaches a user is added to §8 with its
  root cause, and the review question that would have caught it. The review process
  is measured against that list, not against its own confidence.
- **Noise is measured, not assumed.** A comment that a human dismisses as
  intentional or irrelevant is noise. Finding more bugs by also reporting non-bugs
  is not progress.
- **Clean changes are sampled.** Run the review on known-good changes and count what
  it invents; that number is the false-positive rate.
- **Priority order: real bugs first, then fewer review cycles.** Not more comments.

## 8. Regression log

Each entry is a class of defect that shipped, so a review looks for it again and a
gate locks it.

### 8.1 Settings rows: squeezed labels and controls painted over the card

- **Symptom.** The Agent model page rendered `默认模型 / 供应商 / 模型 / 思考强度`
  one character per line, and the three selects ran past the card's right border.
- **Cause.** `.setting-row-text` was `flex: 1; min-width: 0` with no basis, while
  `.setting-control` was `flex-shrink: 0` and every `.settings-select-wrap` inside a
  control kept `width: 260px`. Three selects meant a 780px control: the row had to
  give space, and the only thing it could shrink was the label.
- **Fix.** The row wraps (`flex-wrap: wrap`), the text has a basis
  (`flex: 1 1 180px`), the control may shrink (`flex: 0 1 auto; min-width: 0`), and
  the three selects of `.agent-selection` share the row (`flex: 1 1 0; min-width: 0`).
- **Review question.** When a control holds more than one element, does the row still
  have a width for the label? Check the narrowest panel, not the widest.
- **Gate.** `src/components/settings/settingRowLayout.test.ts`

# PERFORMANCE.md — the editing loop is the product

This is a subordinate document of [AGENTS.md](../AGENTS.md). It defines the
performance contract of the notes editor, the instrumentation every developer
uses, and the checklist a performance review applies. When a feature and this
document disagree, performance wins: a note editor that lags has no reason to
exist.

**The contract.** A keystroke in the notes area must produce feedback in the
next frame. The work per keystroke is bounded by the edited range and the
viewport — never by the document length. This holds for a 2,000-line note as
well as for a 20-line one; the user's notes grow, the budget does not.

## 1. Budgets

| Path | Budget | How it is locked |
|---|---|---|
| State update + decoration rebuild per keystroke (900-line doc) | median < 4 ms | `src/editor/perf.gate.test.ts` |
| Full input pipeline (state + DOM sync + measure), viewport-sized doc | median < 4 ms | perf gate + browser measurement |
| Pure cursor move on plain text | no decoration rebuild | `selectionAffectsDecos` gate |
| Per-keystroke full-document scans | **zero** | incremental fields + perf gate (`math.scan` count) |
| Forced layout per keystroke | at most one | comments at `cursor.flush` / `typewriter.measure` |
| Main-thread block | < 50 ms (a long task is a defect, not jitter) | `longtask` records + `key` records |

A measurement that only says "feels fine" is not evidence (AGENTS.md). Use the
protocol in §4.

## 2. Rules for hot-path code

### R1 — Per-keystroke work is O(change) or O(viewport), never O(document)

The editor document is a new `Text` generation on every keystroke, so a
`WeakMap<Text, …>` cache is a cache **per keystroke**, not per file. A full
scan behind such a cache is O(document) per keystroke.

Correct pattern — a state field that maps its value through the transaction and
only recomputes when its own invalidation rule says so:

- `mathRegionsField` (`src/editor/context.ts`): re-scans only when the changed
  text or a delimiter's neighbour class can change pairing — `$`, `\`, a
  newline, a space/digit typed against a `$`, a blankness flip, or an edit
  inside a display block that already has a blank line (environment tokens).
  An unclosed block's `to` is its body end and grows with the text.
- `calloutRegionsField` (`src/editor/callout.ts`): re-scans only on `:`, a
  newline, a fence/math delimiter, an edit on a line whose text starts with
  `:::` or matches a fence line, or a change in the display-math **line
  spans** (the scan reads them to skip markers inside math); otherwise map the
  regions. An unclosed callout's `to` is the document end.
- Block statics (`src/editor/livePreview.ts`): re-walk the syntax tree only on
  block-construct characters (`` ` ~ * _ - ``), a newline, or an edit at a
  line start; otherwise map the intervals. Callout edges are **not** static —
  `buildBlockDecos` derives them from `calloutRegions(state)`, so a title edit
  cannot leave a stale widget.
- Heading numbering (`src/editor/numbering.ts`): `numberingMayChange` skips the
  scan unless `#`, `:`, a newline, or a line-start edit can change a number.

When you add a new document-wide model, add it as a field with the same shape:
`create` scans once, `update` maps, an explicit `mayAffect…` predicate decides
when to re-scan. Do not add a `WeakMap<Text, …>` full scan to an update path.

A key typed **immediately next to a `$`** may re-scan once: whether that `$`
is an opener or a closer is not decidable from one neighbour, and a wrong
answer would leave stale regions. This is the only ordinary-looking key that
scans; the gate measures it (1.61 ms for 1200 formulas) and every other
character maps.

### R2 — No forced layout in an update listener

`coordsAtPos`, `getBoundingClientRect`, `scrollTop`, `offsetHeight` and
`getComputedStyle` synchronously flush style/layout. Reading one of them inside
`update()` or an update listener turns every keystroke into a full layout round.

The editor has exactly two forced-layout sites, each with a documented reason
and a perf span:

- `cursor.flush` (`setup.ts`): vim's block cursor and insert-mode anchor need
  one measure inside the key task; gated by `vimCursorNeedsFlush`.
- `typewriter.measure` (`typewriter.ts`): the centering scroll goes through
  `requestMeasure`, one read per update.

Do not add a third. Reuse these two: a new feature that needs cursor geometry
reads it from the measure phase, not from its own listener.

### R3 — Do not render expensive DOM on the keystroke path

KaTeX is ~1–5 ms for typical formulas and grows with the source. It runs only
on a cache miss (`renderMathHtml`), and the cache key is the exact source. A new
widget must have a cheap `eq()` so scrolling and cursor moves reuse it, and a
heavy renderer must be cached by its inputs.

### R4 — One update cycle per interaction

A plugin that dispatches a follow-up transaction costs two full update cycles
(every plugin, every decoration, every measure). Prefer a state field that
computes from the transaction it already receives (this is why block math is a
field, not a plugin→effect→dispatch round trip). Synchronous follow-up
dispatches in an update listener are forbidden (CM throws); queue them in a
microtask **and** make them rare.

### R5 — Side work is debounced and off the key path

File writes (`save.note`), LSP sync, daily-note sync, footprint aggregation and
IME switching are background legs. They may start from a transaction, but the
keystroke must not await them. Every async result re-validates its target
(view connected, current file still the same) before writing.

### R6 — Instrument what you add

A new hot phase gets `perfStart()` / `perfEnd(start, "area.phase", fields,
v1, v2, v3)` from `src/perf/trace.ts`, where `fields` is a module-level
`perfFields("name", …)` constant. The values are passed positionally: the data
object is built only when the span crosses the record threshold. Span names
follow `area.phase`: `math.scan`, `callout.scan`, `livePreview.inline`,
`livePreview.statics`, `livePreview.blockDecos`, `emphasis.marks`,
`latex.bracketColors`, `latex.cursorBrackets`, `numbering.scan`,
`katex.render`, `cursor.flush`, `typewriter.measure`, `daily.intents`,
`ime.switch`, `save.note`.

The cost of a span when tracing is off is one boolean check; when `slow` (the
default) it is two `performance.now()` calls and one Map lookup, with no
allocation on a fast span. Never put a `JSON.stringify`, a closure or an
object literal on this path (the object literal would be allocated before
`perfEnd` can decide not to record it).

### R7 — Gates

A hot-path change is not done without a test and a measurement:

- behavior: `*.test.ts` next to the module;
- order of magnitude: extend `src/editor/perf.gate.test.ts` when the change
  touches a per-keystroke path;
- geometry/feel: browser measurement against `localhost:1430` (DEBUG.md), with
  before/after numbers in the same run and the same document;
- a full-document scan must be proven absent: assert the `math.scan` /
  `callout.scan` span count stays 0 across ordinary keystrokes.

## 3. The instrumentation

`src/perf/trace.ts` is the core. Levels:

- `slow` (default, always on): records spans ≥ 25 ms, keys with
  keydown→paint ≥ 50 ms, and browser long tasks. This is the post-hoc evidence
  when a freeze is reported.
- `full`: records every span and every key for a bounded window; started by
  the command palette command **性能:开始详细追踪 2 分钟** or
  `window.__bnotePerf.start(seconds)`.
- `off`: no clocks on the hot path.

`src/perf/editorProbe.ts` measures the number the user feels: a capture-phase
`keydown` → the first frame presented after the update. Its `data` carries
`updateMs` (the state/plugin part), the document size, IME composition state,
and `recent` spans filtered to **this key's** clock window.

`src/perf/sink.ts` appends the records to
`<vault>/.bnote/perf/editor-YYYY-MM-DD.jsonl` in 1.5 s batches, off the key
path. A missing or read-only vault disables persistence with one warning; the
in-memory ring still serves `window.__bnotePerf.report()`.

### The record format

```jsonc
{ "kind": "key", "name": "a", "ms": 212.4,
  "data": { "updateMs": 3.1, "docLines": 900, "docBytes": 54000,
            "composing": false, "transactions": 1 },
  "recent": [ { "name": "math.scan", "start": 123.4, "ms": 180.2 } ] }
```

`ms` ≈ `updateMs` + layout + paint + any main-thread block. If `updateMs` is
small but `ms` is large, the block is outside the update: IME/TIS, layout, or
paint. `recent` names the last instrumented phases; a slow unaccounted gap is a
missing span (add it in the same change).

## 4. Profiling protocol (deterministic)

1. Reproduce with the **same document** and the **same keys** before and after.
2. Start full tracing: command palette → 性能:开始详细追踪 2 分钟, reproduce the
   lag, then 性能:停止追踪并打印汇总.
3. Read the newest JSONL: `pnpm perf:report` (default vault) or
   `node scripts/perf-report.mjs --vault /path/to/vault --last 200`.
4. Attribute: sort keys by `ms`; compare with `updateMs`; read `recent`. A slow
   `math.scan` / `callout.scan` means a full-document scan is back. A slow
   `katex.render` means an un-cached formula. A small `updateMs` with a large
   `ms` and an `ime.switch` span means the input-source switch.
5. Fix the model (AGENTS.md: never patch the symptom), then re-run the same
   protocol and put both numbers in the commit message / summary.

For the browser loop, the harness (`harness.html`) uses the same editor
extensions, so its `window.__perfHooks` + `__bnotePerf` (when installed) expose
the same spans without the native IME leg.

## 5. Performance review checklist

Run this against every diff that touches `src/editor`, `src/daily`,
`src/footprint`, `src/python/lsp.ts`, or an update listener:

- [ ] Does any new code call `doc.toString()`, `doc.iterLines()`, or iterate the
      whole syntax tree from an update/input path?
- [ ] Is a new full-document cache keyed by `Text`/`EditorState`? Replace it
      with a state field + mapping + explicit invalidation (R1).
- [ ] Does a new update listener run on every doc change? What does it compute,
      and what is its gate?
- [ ] Any layout read (`coordsAtPos`, rect, scroll) in an update path (R2)?
- [ ] Any new `dispatch` from a plugin/update listener (R4)?
- [ ] Any `await`/IPC/file write on the key path (R5)?
- [ ] Does the new widget have a cheap `eq()` and a cached expensive render
      (R3)?
- [ ] New hot phase instrumented with a span (R6)?
- [ ] Behavior test + perf-gate extension + browser before/after (R7)?
- [ ] `pnpm gate` green; Rust paths also `cargo check` / `cargo test --lib`.

## 6. Known native leg: IME switching

`imeSwitch` keeps ASCII in normal mode / formulas (ABC) and switches to the
insert source (Sogou) on entering insert. The switch is an in-process Carbon TIS
call that HIToolbox runs on the app's **main thread** — the same thread that
delivers key events — so its duration is input latency, not paint latency. This
leg is **not** visible in browser measurement. Use `ime.switch` spans and the
Rust probe (`cargo test --lib probe_switch_sources -- --nocapture`); platform
behavior needs a deployed check (AGENTS.md).

The measured cost on this machine (45 samples, full trace 2026-11-11):

| target state | `tisMs` | what it is |
|---|---|---|
| same source used within 5 s | p50 4.6 ms | TIS bookkeeping only |
| idle 5–120 s | p50 8.7 ms, max 53 ms | the input method waking up |
| idle > 2 min | p50 52.6 ms, max 166 ms | a third-party IME being activated (`Sogou`) |

That is the whole switch: the command is **synchronous**, so Tauri runs it on the
main thread instead of `spawn_blocking` → `run_on_main_thread` → channel (that
form added a measured 10–35 ms before the TIS call even started, exactly between
the mode change and the source changing). `SetImeOutcome` returns the call's own
duration, and the span carries it:

| field | meaning | a large value means |
|---|---|---|
| `tisMs` | inside `TISSelectInputSource` | the input method was cold; every key pressed meanwhile waits |
| `ms - tisMs` | IPC + the front end's own task boundary | the bridge, not the IME |

The first TIS call in a process pays ~41 ms (`TISCopyCurrentKeyboardInputSource`
measured on macOS 26); `imeWarmUp` pre-pays it at startup, so a large `tisMs`
after warm-up is not initialization. `save.note` spans of the same period are
the control: when a 41-byte write also costs ~200 ms, the congestion is the
command channel, not the IME.

Two things this leg deliberately does **not** do:

- **No verification chain.** The macOS 26 race it used to retry for ("menu bar
  switched, the app still types latin") is invisible to
  `TISCopyCurrentKeyboardInputSource` — the system already reports the new
  source — so the check could never detect it, while it added two more
  main-thread TIS calls at +120 ms and +240 ms (on the user's next characters)
  and ended in a `macism` CLI fallback that steals focus.
- **No extra deferral.** The switch is queued one task tick after the keystroke
  (`setTimeout(0)`) so the mode change and its DOM work land first. Waiting for
  a frame on top of that only shortened the time the IME had to be ready before
  the user's first character.


## 7. Where the hot path lives (map)

| Concern | Module |
|---|---|
| Extension assembly / update listeners | `src/editor/setup.ts` |
| Inline + block decorations | `src/editor/livePreview.ts` |
| Math pairing (incremental field) | `src/editor/context.ts`, `src/editor/mathScan.ts` |
| Callout pairing (incremental field) | `src/editor/callout.ts` |
| Bracket colors / cursor brackets | `src/editor/snippets/brackets.ts` |
| KaTeX widgets | `src/editor/widgets.ts` |
| IME follow | `src/editor/imeSwitch.ts`, `src-tauri/src/commands/ime.rs` |
| Typewriter measure | `src/editor/typewriter.ts` |
| Vim cursor flush | `src/editor/setup.ts` (`scheduleVimCursorFlush`) |
| Heading renumbering | `src/editor/numbering.ts` |
| Perf core / probe / sink | `src/perf/` |

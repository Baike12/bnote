# Testing

## First principle

A test system is a **defect-class registry with an alarm wired to every class**.
Every regression that ever shipped here had a root-cause *class*; the system's
job is that each class maps to exactly one layer whose test **cannot stay
silent** when the class reappears — and that this mapping is explicit,
auditable, and maintained like code. "Implemented differently than expected"
and "perf regressed" are not bad luck; they are classes whose alarm was
missing, muted, or aimed at the wrong layer.

The working protocol that follows from this:

1. **A fixed bug must answer: why did no existing layer alarm?** Exactly one of
   three answers is acceptable, and each prescribes the follow-up:
   - *the layer was missing* → add the layer (or extend one) in the same PR;
   - *the layer existed but was mute* → the test asserted the wrong contract;
     fix the assertion, not the test's existence;
   - *no automated layer can reach it* (CSS anchoring, native IME, window
     levels) → it belongs to the browser-measured or native-only protocol
     below, and the measurement is scripted, not remembered.
2. **Lock the class, not the instance.** A regression test that only replays
   the exact repro is a museum exhibit. Name the class, then assert the
   invariant that makes the whole class impossible (see the registry below).
3. **The mapping is reviewed when it alarms.** When a test fires, confirm the
   registry named the right layer; when a defect escapes, the registry entry
   is the fix's first deliverable (divider-drag case study lives in the
   registry).

Shape follows ROI (the Testing Trophy: "write tests, not too many, mostly
integration" — integration at the real seams carries the most fault-detecting
power per maintenance dollar; static analysis under everything). This repo
already sits on that shape; what was missing is the explicit registry, which is
what kept three shipped bugs invisible to 3,300 green tests (2026-11-17:
divider drag argument-order drift, window-wide CSS overlay, import-not-
refreshing). The registry below closes those classes and is appended to on
every escaped defect.

## Defect-class registry

Every entry: the class, the layer that alarms, the lock. Keep it ordered by
the date the class was admitted.

| Defect class (real incident) | Alarming layer | Lock |
|---|---|---|
| **Seam drift** — a component calls a pure model with another model's argument shape; both sides are self-consistent, the compiler sees nothing (divider drag: `dragLeftEdge(x, host, sum)` called as `(width, host, sum)`; one drag jumped to the clamp bounds). | unit — **seam functions** | The component→model call shape is extracted into a pure function in the model module (`leftDividerWidths`, `middleDividerWidth`); the component is its only caller, and tests assert the pointer deltas (`+10px ⇒ +10px`, column-sum conserved, 10% floor). The rule is enforced, not remembered: `dividerSeam.gate.test.ts` fails on any raw `drag*Edge(` call inside a component. All four layouts (invest, study, code, projects) go through their domain's seam functions. Rule: **when a component calls a pure model with measurements, that call shape is a seam and gets a function + tests.** |
| **Contract rename drift** — an IPC wrapper renamed without the Rust command, or a `#[tauri::command]` defined but never registered. | snapshot + structural | `src/lib/tauri.contract.test.ts` snapshots every wrapper's `invoke` name; `src-tauri/tests/command_surface.rs` asserts definitions == `generate_handler![]` == devbridge arms; `src/lib/ipcContract.test.ts` scans every TS `invoke("…")` literal (nested-generic safe) and asserts invoked ⊆ bridge arms and invoked ⊆ `#[tauri::command]` definitions — a typo'd or orphaned command name fails `pnpm gate` without cargo. |
| **Cross-market data routing** — bars/snapshots landing under the wrong `(market, code)` because a default silently won. | unit (fixture) + DB roundtrip | `parse_quote` three-market fixtures with real response bodies; `markets_are_isolated_by_key` roundtrip; `market_for` resolution-order test. |
| **Unit-contract violation** — a fraction rendered raw (`-0.0327%`), a hand-rolled `%` suffix, hk/us shares divided by 100. | unit — formatters as the only converters | `src/invest/format.ts` is the single converter set (`pct`/`signedPct`/`num`/`yi`/`sharesToLots`), locked by `src/invest/format.test.ts`; import files pass a quality gate (`INVALID_BAR`), locked at the command boundary by `commands::invest::tests::import_rejects_ohlc_inconsistent_bars`. |
| **Async state migration** — a mutation succeeded but the view kept the pre-mutation state until a scope switch (import → chart not reloaded; backtest → list not reloaded). | unit (pure decision) + integration (store flow) | Pure: `importTargetScope` (`layoutModel.test.ts`) decides the post-import target. Integration: `store.integration.test.ts` locks the whole orchestration (`applyImport` jumps to the imported scope) and the `backtestTick` bump/failure invariants. Rule: **after any await that mutates the DB, name who re-renders — in code (a tick/selector), not in hope.** |
| **CSS anchoring / geometry** — an `inset: 0` overlay anchoring to the window because an ancestor lacks `position: relative`; nothing type-checks this. | **source gate + browser-measured protocol** (no unit layer can reach it) | The class shipped four times (.invest-kline, .invest-import-scrim, .invest-toast, .code-overlay), so the source-level half is enforced, not remembered: `overlayAnchoring.gate.test.ts` requires every full-bleed overlay to register a container that declares a position, and snapshots the inventory (a new overlay is a forced, reviewable decision). The measured half lives in E2E: `e2e/specs/investLayout.e2e.ts` asserts the import scrim's rect equals the invest layout's rect (verified 2026-11-18 against the real binary) and drives the dividers through W3C pointer actions (the same first real run caught splitDrag's pointerdown `preventDefault` suppressing the click chain, so double-click reset never fired). The double-click reset itself is a deployed check (docs/DEPLOYED-CHECKS.md): the embedded WebKitWebDriver never synthesizes `dblclick` (measured, three gestures). |
| **Ingested-data shape drift** — a vendor response field shift silently corrupting numbers. | unit — real-body fixtures | Every parser keeps fixtures cut from live responses (Tencent cn/hk/us, agent SSE cassettes); an index shift fails on the exact field. |
| **Performance regression** — an O(document) scan or per-keystroke measure creeping into a hot path. | perf gate (measured, load-gated) | `src/**/perf.gate.test.ts` locks order-of-magnitude budgets per docs/PERFORMANCE.md; budgets move only from measured medians. |
| **Parser robustness** — a hand-edited config/vendor body the examples never imagined. | unit — **deterministic property tests** | `quotes.rs`: a fixed-seed LCG generates 200 valid configs (`every_generated_valid_config_parses_and_routes`) and 120 single-byte corruptions (`corrupted_yaml_never_panics_and_reports_a_line`; every error is either line-numbered or `QUOTES_*`-coded). Example-based tests cover the cases we thought of; properties cover the ones we did not. |
| **Date boundary / timezone** — a date computed off-by-one or in the wrong zone, shipping inside a directory name or a "today" stamp (ingest feeds landed on *tomorrow*). | unit — a pure civil-date function | `ingest.rs` `feed_day_for(unix_secs, utc_offset_minutes)` is the only converter; `a_day_boundary_rolls_over_exactly_once` locks the epoch anchor, the exact one-flip midnight boundary for east/west zones, and monotonicity across leap years. Zone offsets are a collector-level argument (the current collector is UTC-explicit); a "today"-stamp consumer must go through it, not hand-roll `now / 86400`. |
| **Flake** — a test that passes alone and fails on a loaded/parallel run. | flake policy + structural alarm | No sleeps; wait on DOM state; fake timers for scheduling; a flaky test is a defect (find the race), never retried away. The policy has an alarm: the registry gate fails on any `browser.pause(` inside an E2E spec, so a timer-based wait cannot land silently. |

Adding a class: fix → answer "why silent" → append the row → land the lock in
the same PR. The registry is reviewed whenever a row's lock alarms.

## The seam rule (how cross-module bugs are prevented)

The divider incident generalized: **a self-consistent function plus a
self-consistent caller is invisible to every per-side test.** The rule that
closes the class:

- Any time a component passes measured DOM geometry (widths, rects, offsets)
  into a pure model, the call shape is extracted into a *seam function* that
  lives in the model's module, takes a single named-measurements object, and
  is the component's only entry to the model.
- The seam function gets the regression tests (pointer-delta semantics,
  conservation invariants, clamp floors) — the model's own tests keep
  validating its internal contract.
- The same rule covers Rust: `commands/` parse and validate, then call feature
  modules; a command that reshapes arguments before the call is a seam and
  gets a test through `test_support` (e.g. `snapshot_refresh_rejects_unknown_markets`).

## Browser-measured invariants

Some classes have no automated layer (CSS anchoring, stacking contexts,
pointer gestures against a canvas, native-only behaviors). They are not
"untestable" — they are **measured**, with the protocol written down so the
measurement survives the person who ran it:

1. Reproduce in the harness/browser with the exact gesture (CDP pointer
   events, not synthetic React events alone — the divider bug only appeared
   through real pointer sequences).
2. Assert geometry numerically (`getBoundingClientRect`, `elementFromPoint`,
   `getBBox`), not visually ("looks fine" is not evidence).
3. Record the measured numbers in the PR; a fix without its before/after
   measurement is not done.
4. When a measurement becomes load-bearing (the overlay-must-match-pane
   invariant), promote it: either a DOM-geometry unit test if it can be
   reached from jsdom, or an E2E spec if it needs the real app.
   - Gesture E2E lives with the other specs and runs in the nightly E2E job:
     `e2e/specs/investLayout.e2e.ts` drives the layout dividers through W3C
     pointer actions and asserts the widths follow the pointer (the divider
     bug's e2e-level lock).
   - Iteration on changed files: `pnpm test:related <files...>` runs the
     unit+integration tests related to those files (vitest `related`).

## AI-driven testing

Three forms, each with its discipline. The grounding research: LLM-generated
tests fail mostly on **oracle correctness** (a wrong assertion is worse than
none — it locks in the bug), and the industrial consensus workflow is
*context enrichment + iterative validation/repair through compiler and
execution feedback* (arXiv 2511.21382, 178-paper survey, 2026-09). The static
gate is the compiler-side half of that loop; the reviewer is the oracle half.

1. **Adversarial role testing (the highest-yield form here).** Humans and
   single-persona reviewers probe their own assumptions; *independent*
   role-persona agents probing a running build find cross-cutting breakage
   the author cannot see. Institutionalized as the
   `bnote-adversarial-test` skill: 2–4 role agents (domain user, quant/
   engineer, QA) operate the real app UI-only, report P0/P1/P2 with
   reproductions; every finding is triaged into *fixed* / *tool-artifact*
   (re-measured, dismissed with evidence) / *by-design* (recorded). Two full
   rounds (2026-11) produced 30 findings → 18 fixes, 3 tool artifacts, 9
   by-design — and none of the P0s were reachable by the existing 3,300+ automated tests.
2. **LLM-generated tests.** Allowed, but a generated test is a *draft*: it
   must pass `pnpm gate` (compiler + execution feedback), a human must verify
   the **oracle** against the spec (would this fail if the behavior were
   wrong?), and the defect-class registry must name which class it locks. A
   green generated test that locks no class is deleted, not merged.
3. **Structural gates as AI-exerciseable assertions.** `command_surface.rs`,
   `imeArchitecture.gate.test.ts`, and the coverage ratchet are
   source-reading assertions machines keep green; they catch the drift class
   (defined-but-unregistered, reverted architecture legs) that functional
   tests never see.

---

## Layers and commands

| Layer | Command | Environment | Proves |
|---|---|---|---|
| Types / lint / format | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | node | The code compiles, imports resolve, style is uniform. |
| Unit | `pnpm test:unit` | node | Pure rules: parsing, engines, geometry, command registry, LSP framing. |
| Integration | `pnpm test:integration` | jsdom | Real modules and Zustand stores wired through the real `src/lib/tauri.ts` boundary. Two fixture styles coexist, both faking only the process boundary: the in-memory vault (`src/test/fakeVault.ts`) for file-surface flows, and per-domain in-memory command stubs for flows beyond the file surface (invest, focus, …). No test mocks the module it is testing. |
| Rust unit | `cargo test --lib` | Rust | Backend behavior: paths, watchers, sessions, LSP, Python, translation. |
| Rust structural | `cargo test --test command_surface` | Rust | Every `#[tauri::command]`, every `generate_handler![]` entry, and every browser-bridge arm agree. |
| Agent cassette | `cargo test --test agent_cassette` | Rust | A recorded Anthropic stream is replayed over HTTP and driven through the real agent loop and tools. |
| Coverage | `pnpm test:coverage` | node + jsdom | Unit + integration coverage against ratcheted thresholds. |
| Performance | `pnpm test:perf` | node | Per-keystroke and tree/editor order-of-magnitude budgets. |
| E2E | `pnpm test:e2e` | macOS, real binary | Disk IO, vault watcher, native window, global keybindings, autosave. |
| Full gate | `pnpm gate:full` | static + coverage + perf + Rust | Everything the CI frontend/rust/perf jobs run. **E2E is not part of `gate:full`** — it is the nightly/label job (`pnpm test:e2e:build && pnpm test:e2e`), because it builds its own binary. |

`pnpm gate` is the fast PR gate: lint + typecheck + format + unit/integration.
`pnpm gate:full` adds E2E typecheck, coverage, perf and Rust tests.

### Vitest projects

`vitest.config.ts` defines three projects instead of one environment:

- **unit** (`node`) — `src/**/*.test.ts(x)`, excluding integration and perf.
- **integration** (`jsdom`) — `src/**/*.integration.test.ts(x)`, loading
  `src/test/setup.integration.ts`.
- **perf** (`node`) — `src/**/perf.gate.test.ts`, deliberately outside the
  coverage run: V8 instrumentation adds enough overhead to push a measured
  median past its budget and produce a false failure. Each file also gates
  itself on machine load (`src/perf/loadGate.ts`): when the 1-minute load
  average reaches 0.75× the CPU count the suites report as skipped and print
  the measured load, because a budget measured on an oversubscribed machine
  says nothing about the code. Rerun `pnpm test:perf` on an idle machine.

## Front-end integration: the fake IPC boundary

`src/test/fakeVault.ts` implements the Rust command surface in memory: vault
tree, file IO, config, keybindings, vimrc, Python stubs. It is installed once,
at the exact production seam:

```ts
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  api: fakeVault.api,
}));
```

Consequences:

- App code, stores, components and command handlers are the real ones.
- The typed wrapper layer (`src/lib/tauri.ts`) is the real one, so a wrong
  argument name or a renamed command still fails.
- Only the process boundary is fake. A test never mocks the module it is
  testing, and never mirrors a store into component state.

Use `fakeVault.seed()`, `seedDirs()`, `failNext()`, and `writes` to arrange
disk state and assert what was written. Reset happens before every test.

`src/lib/tauri.contract.test.ts` is the complementary gate: it snapshots every
exported wrapper’s `invoke` command name, so a rename in `src/lib/tauri.ts`
cannot silently drift from the Rust command.

## Agent record and replay

The agent is tested against recorded Anthropic traffic, not hand-written
responses. `src-tauri/src/agent/cassette.rs` records every request body and every
raw SSE frame when `BNOTE_CASSETTE_DIR` is set; `tests/common/mod.rs` serves that
folder over a real HTTP/1.1 chunked socket, so `Provider`, the SSE assemblers,
`Session`, `ToolDispatch` and the real tools all run unmodified.

```
<folder>/manifest.json                 format, version, creation time
<folder>/0001-request.json             method, url, model, session, thinking, body
<folder>/0001-response/meta.json       status, content-type, completed
<folder>/0001-response/frames/0001.sse one file per raw SSE frame
<folder>/0001-response/frames/9999-partial.sse   unterminated tail, if any
```

- Recording is off unless `BNOTE_CASSETTE_DIR` names a folder. `begin`,
  `push_chunk` and `finish` are best-effort: a failed cassette write never
  fails the model turn.
- Authorization headers are neither read nor written. Request bodies are stored
  verbatim (system prompt, conversation, tool results, temp vault paths), so a
  cassette is a transcript and must be reviewed before it is committed.
- Replay is order-based and checks the request path suffix (`/v1/messages`,
  `/v1/chat/completions`); an exhausted or mismatched cassette answers HTTP 500
  with the expected/actual index, so a drift fails loudly.
- Anthropic is the recording target. OpenAI replay exists as a parsing
  regression only (`provider-openai` is synthetic).
- `redacted_thinking` is preserved as `Content::Thinking.redacted` and sent back
  verbatim; Anthropic rejects a replayed thinking block whose signature or
  opaque data was dropped.

Fixtures:

| Folder | Content |
|---|---|
| `tests/fixtures/cassettes/provider-anthropic` | One synthetic turn: thinking + signature, text, tool_use. |
| `tests/fixtures/cassettes/provider-openai` | One synthetic OpenAI turn: reasoning, text, tool_calls. |
| `tests/fixtures/cassettes/agent-harness` | Seven synthetic turns covering TodoWrite/TodoRead, Read/Write, an Agent subagent and completion. |
| `tests/fixtures/cassettes/agent-real` | Nine real Anthropic turns against a DeepSeek gateway: TodoWrite, TodoRead, Read, Write, one explore subagent, final TodoWrite. The Write turn carries a `redacted_thinking` block. |

`cargo test --test agent_cassette` replays them. `the_harness_replays_the_real_anthropic_recording`
also asserts that tool results reach the next request, the subagent report
reaches the parent, todos end completed, and the written file is byte-exact.

To record again (paid, ignored by default):

```bash
cd src-tauri
BNOTE_RECORD_API_KEY=... BNOTE_RECORD_BASE_URL=https://... \
BNOTE_RECORD_MODEL=claude-sonnet-4-5 \
cargo test --test agent_record -- --ignored --nocapture
```

Credentials fall back to `~/.claude/settings.json` (`ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`). The folder defaults to
`tests/fixtures/cassettes/agent-real` and can be redirected with
`BNOTE_RECORD_DIR`. The test records into a sibling `.recording` folder, asks
for thinking plus every tool feature, and fails if the endpoint returned no
thinking block at all. Only a run that passed every assertion replaces the
fixture, so a failed or thinking-less recording cannot destroy a good cassette.

## Coverage policy

`@vitest/coverage-v8` with global and per-domain thresholds. Thresholds are a
**ratchet**, not a goal: they sit just below the measured baseline and move up
when the suite grows. A new module that lands untested fails the domain.

- `.tsx` views are excluded: the architecture keeps behavior in plain modules
  (AGENTS.md rule 4); views are wiring covered by E2E flows. Component `.ts`
  helpers (`toolSummary`, `agentCards`, …) stay measured.
- `.test.*`, `src/dev/**`, `src/test/**`, `src/main.tsx` are excluded.
- When adding a domain, add a `src/<domain>/**` threshold at or below the
  measured value in the same PR.

Coverage is reported as `text-summary`, `json-summary` and `lcov` under
`coverage/` (CI uploads it).

## E2E: real binary, isolated data

macOS uses the official embedded WebDriver provider. The WebDriver server lives
inside the app only when the binary is built with the Cargo `e2e` feature, so a
release build never contains it.

Two pieces on the app side are what let the service drive the real window
instead of timing out (`Tauri core.invoke not available after 5s`):

- `src-tauri/tauri.e2e.conf.json` enables `app.withGlobalTauri` and adds a
  window capability with `wdio:default`. The config is passed only by the
  `test:e2e:build` script; the base config never loads it.
- `src/main.tsx` imports `@wdio/tauri-plugin` only when `VITE_E2E === "1"`.
  The flag is a compile-time constant, so the production bundle drops both the
  branch and the import (verified: no `WDIO Tauri Plugin` chunk in `dist/`).

```bash
pnpm test:e2e:build   # VITE_E2E=1 tauri build --debug --no-bundle --features e2e
pnpm test:e2e         # wdio run e2e/wdio.conf.ts
```

Measured on this machine after the wiring above: the suite ran green in seconds, with
zero `core.invoke` timeout warnings. Before it, the same suite took 4m36s and
logged 79 timeout warnings because the service polls for
`window.__wdio_original_core__` (set by the plugin) and the app never loaded it.

The binary is feature-specific: any `cargo build`/`cargo test` without
`--features e2e` replaces `src-tauri/target/debug/bnote` with a build that has
no WebDriver server, and `pnpm test:e2e` then fails in `onPrepare` after 120s.
Always run `pnpm test:e2e:build` immediately before `pnpm test:e2e`; the CI job
does exactly that.

Isolation is part of the contract:

| Artifact | Location | Lifetime |
|---|---|---|
| App data (`config.json`, agent state) | `e2e/.tmp/data` via `--bnote-data-dir` | recreated per run |
| Vault | `e2e/.tmp/vault` (copy of `e2e/fixtures/vault`) | recreated per run |
| Failure forensics | the same dirs + `e2e/logs/` | kept when the run fails |

The user’s real vault and `~/Library/Application Support/...` are never read or
written by a test. `restore_window_bounds` uses the same data-dir resolver, so
even window geometry cannot leak from the real profile.

What the spec proves (`e2e/specs/app.e2e.ts`):

- the app boots on `lastVault` and renders the real on-disk tree (lazy folder
  expansion goes through `read_dir`);
- keystrokes in CodeMirror autosave to bytes on disk, and `dirty` clears;
- the sidebar “new note” action creates and opens a file through the Rust
  command;
- `Mod-Shift-o` creates `Daily/YYYY-MM-DD.md` and opens it;
- a file created and edited outside the app appears in the tree/editor through
  the Rust watcher;
- the command palette opens, filters, and closes on Escape.

Not provable in CI by this layer: window levels, the focus hard-lock event tap,
IME/TIS switching, native pen cursor, and PDF/annotation rendering. Those stay
native-only and walk the deployed checklist in
[docs/DEPLOYED-CHECKS.md](./DEPLOYED-CHECKS.md) before a release; the pure
parts (state machines, geometry, filtering) are covered by unit/integration
tests.

## Structural gate: command surface

`src-tauri/tests/command_surface.rs` parses the source and asserts:

```text
#[tauri::command] definitions  ==  generate_handler![]  ==  devbridge dispatch
```

This closes a failure class the compiler does not see: a command that compiles
but is never registered, a registration with no definition, a duplicate
registration, or a browser-bridge arm whose name no longer exists. The two
`set_input_source` cfg variants are treated as one name.

## Structural gate: IME switching

A mode switch works only as one composed chain, and two of its legs are
invisible to the compiler and to every functional test: the TIS select must
run in the helper process (in-process, it freezes the UI thread for the whole
call), and a confirmed switch must hand the new source to the app's own text
input context (otherwise the menu bar moves while WebKit keeps typing latin).
Both legs have already been reverted by "simplification" edits that shipped a
broken build.

- `src/editor/imeArchitecture.gate.test.ts` (unit) reads the front-end and
  backend sources and locks the chain: the editor composition, the app-shell
  blur/focus sync, the `set_input_source` IPC name, the helper detection order
  in `main.rs`, the protocol-only command layer, the helper's run-loop drain,
  and the accessory activation policy.
- `src-tauri/tests/ime_architecture.rs` (Rust) locks the same backend
  contract for `cargo test`.
- Behaviour underneath: `src/editor/imeSwitch.test.ts` (intent state machine),
  `src/editor/imeSwitchExtension.integration.test.ts` (mode change → IPC →
  re-mount through a real editor), and `src-tauri/tests/ime_daemon.rs` (the
  real helper process over its line protocol).

## Performance gates

`src/editor/perf.gate.test.ts` and `src/code/perf.gate.test.ts` lock the order
of magnitude of hot operations. They run outside coverage, in their own Vitest
project and CI job. The budget and measurement protocol are defined in
[docs/PERFORMANCE.md](./PERFORMANCE.md); update a budget only from a measured
median, never by guesswork.

The harness must hand the measured state a **complete** syntax tree.
`ensureSyntaxTree(state, len, timeout)` parses ahead but restores the previous
viewport, so the state can still hold a partial tree (measured: 3,026 of
11,825 chars, which made every “whole document” budget measure a quarter of it).
`makeState` therefore installs the parsed tree with `state.update({})` — the
headless equivalent of `forceParsing`'s `view.dispatch({})` — and asserts
`syntaxTree(state).length === doc.length` before the first sample.

The note-area block also locks the interactions that changed the block
structure, not only typing/paste: Backspace joining two blocks, redo after undo
(`history()`), appending at EOF, 20 multi-cursor insertions, and 60
viewport-only rebuilds while scrolling.

## Flake policy

- No `sleep` for synchronization. Wait on DOM state or `browser.waitUntil`.
- Unit/integration tests use fake timers for debounce and scheduling.
- The E2E app is launched once per spec file; tests are ordered and share one
  vault, so each test seeds the state it needs (opens its own note, uses a
  unique file name).
- A perf failure on a loaded machine is rerun alone and reported with the load
  average; it is not “fixed” by lowering the budget.
- A flaky test is a defect: find the race and remove it, do not retry.

## CI

`.github/workflows/ci.yml`:

| Job | Trigger | Contents |
|---|---|---|
| `frontend` | every push/PR | lint, both typechecks, format, unit + integration + coverage, coverage artifact |
| `rust` | every push/PR | `cargo fmt --check`, `cargo check`, `cargo test --lib`, command-surface test |
| `perf` | main, nightly, `perf` label | `pnpm test:perf` |
| `e2e` | nightly, manual, `e2e` label | e2e debug build + WebdriverIO on macOS; artifacts on failure |

## References

- Tauri’s own testing guide: mock runtime for unit tests, WebDriver for E2E
  (<https://tauri.app/develop/tests/>).
- Tauri WebDriver guide, including the embedded server used here
  (<https://tauri.app/develop/tests/webdriver/>).
- WebdriverIO Tauri service, `embedded` provider on macOS
  (<https://webdriver.io/docs/desktop-testing/tauri>).
- Public CI layouts of comparable apps: GitButler runs Rust tests plus
  Playwright E2E; AppFlowy splits Rust, Flutter and coverage workflows; Yaak
  and Spacedrive lean on workspace/crate tests.

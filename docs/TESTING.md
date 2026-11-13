# Testing

The test system has one job: a change that breaks a user-visible behavior or a
hot-path budget fails before it ships. Each layer answers a question the layer
below it cannot.

```text
                     ┌──────────────────────────────┐
                     │ E2E (WebdriverIO + real app) │  macOS, nightly/label
                     │ boot, disk IO, watcher, keys │
                     └──────────────┬───────────────┘
                                    │
                    ┌───────────────┴────────────────┐
                    │ integration (jsdom + fake IPC) │  every PR
                    │ modules + stores + UI state    │
                    └───────────────┬────────────────┘
                                    │
             ┌──────────────────────┴───────────────────────┐
             │ unit (node, pure logic) + Rust #[test]       │  every PR
             │ parsers, engines, geometry, commands, LSP    │
             └──────────────────────┬───────────────────────┘
                                    │
        ┌───────────────────────────┴────────────────────────────┐
        │ static gates: tsc, eslint, prettier, command surface,   │  every PR
        │ coverage thresholds, perf gates                         │
        └─────────────────────────────────────────────────────────┘
```

## Layers and commands

| Layer | Command | Environment | Proves |
|---|---|---|---|
| Types / lint / format | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | node | The code compiles, imports resolve, style is uniform. |
| Unit | `pnpm test:unit` | node | Pure rules: parsing, engines, geometry, command registry, LSP framing. |
| Integration | `pnpm test:integration` | jsdom | Real modules and Zustand stores wired through the **real** `src/lib/tauri.ts` boundary, with a fake vault behind it. |
| Rust unit | `cargo test --lib` | Rust | Backend behavior: paths, watchers, sessions, LSP, Python, translation. |
| Rust structural | `cargo test --test command_surface` | Rust | Every `#[tauri::command]`, every `generate_handler![]` entry, and every browser-bridge arm agree. |
| Coverage | `pnpm test:coverage` | node + jsdom | Unit + integration coverage against ratcheted thresholds. |
| Performance | `pnpm test:perf` | node | Per-keystroke and tree/editor order-of-magnitude budgets. |
| E2E | `pnpm test:e2e` | macOS, real binary | Disk IO, vault watcher, native window, global keybindings, autosave. |
| Full gate | `pnpm gate:full` | all of the above | The complete contract before a release or a risky change. |

`pnpm gate` is the fast PR gate: lint + typecheck + format + unit/integration.
`pnpm gate:full` adds E2E typecheck, coverage, perf and Rust tests.

### Vitest projects

`vitest.config.ts` defines three projects instead of one environment:

- **unit** (`node`) — `src/**/*.test.ts(x)`, excluding integration and perf.
- **integration** (`jsdom`) — `src/**/*.integration.test.ts(x)`, loading
  `src/test/setup.integration.ts`.
- **perf** (`node`) — `src/**/perf.gate.test.ts`, deliberately outside the
  coverage run: V8 instrumentation adds enough overhead to push a measured
  median past its budget and produce a false failure.

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

Use `fakeVault.seedFile()`, `seedDir()`, `failNext()`, and `writes` to arrange
disk state and assert what was written. Reset happens before every test.

`src/lib/tauri.contract.test.ts` is the complementary gate: it snapshots every
exported wrapper’s `invoke` command name, so a rename in `src/lib/tauri.ts`
cannot silently drift from the Rust command.

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

Measured on this machine after the wiring above: **6 specs pass in 3.5s**, with
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
native-only and need a manual deployed check; the pure parts (state machines,
geometry, filtering) are covered by unit/integration tests.

## Structural gate: command surface

`src-tauri/tests/command_surface.rs` parses the source and asserts:

```text
#[tauri::command] definitions  ==  generate_handler![]  ==  devbridge dispatch
```

This closes a failure class the compiler does not see: a command that compiles
but is never registered, a registration with no definition, a duplicate
registration, or a browser-bridge arm whose name no longer exists. The two
`set_input_source` cfg variants are treated as one name.

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

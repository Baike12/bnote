# AGENTS.md — bnote agent conventions

## Project Overview

bnote is a local-first Markdown notebook for macOS: a vault is a folder of plain `.md` files, and the app is the editor over it.

- **Frontend:** TypeScript (strict) + React 19 + Vite 8 + CodeMirror 6 + Zustand 5.
- **Backend:** Rust + Tauri 2. Commands live in `src-tauri/src/commands/` and return `CmdResult<T>` (`Result<T, String>`); feature logic lives in `src-tauri/src/{agent,code,lsp,python}/`.
- **What it does:** live-preview Markdown with vim mode, LaTeX snippets and KaTeX math, callouts, daily notes with cross-file todo sync, study mode (PDF/web reading plus an agent), a code-project pane with LSP, kanban projects, a pomodoro focus mode that takes over the screen, and a drawing canvas.
- **Runtime:** `pnpm dev` serves the app on `localhost:1430`; the Tauri window loads the same URL. In browser mode, `src/dev/browserMode.ts` mocks `window.__TAURI_INTERNALS__` and routes IPC to `src-tauri/src/devbridge.rs` (`127.0.0.1:1439`), which calls the real `#[tauri::command]` implementations.
- **Entry points:** `src/main.tsx` → `src/App.tsx` (startup order: config → vault → focus restore); `src-tauri/src/main.rs` → `src-tauri/src/lib.rs`.
- **Platform:** macOS-first. Window levels, event taps, IME, and the pen cursor are native; they cannot be exercised in a browser.

## Project Structure

```
src/                          frontend
├── main.tsx, App.tsx         entry, app shell, startup order
├── editor/                   CodeMirror core: setup.ts assembles extensions; live preview,
│                             decorations, vim, snippets, math, typewriter, geometry
├── study/                    study mode: assistant | content | notes columns, PDF, web, materials
├── code/                     code-project pane: file tree, editor, LSP client, git diff, problems
├── agent/                    agent panel: sessions, providers, tools, markdown rendering
├── daily/                    daily notes, cross-file todo sync, rollover
├── projects/                 kanban project view
├── footprint/                today's-footprint aggregation into the daily note
├── python/                   embedded Python: extraction, LSP, runner
├── focus/                    pomodoro timer and screen-lock state (native side: commands/focus.rs)
├── commands/                 command registry, key bindings, key regions
├── state/                    app store, settings, config persistence
├── components/               views: app chrome (title bar, status bar, settings, palettes)
│                             plus one folder per domain view (agent, study, code, daily,
│                             projects, focus, python); views sit in the composition layer
├── vault/                    vault MRU and quick switch
├── lib/                      shared helpers and the typed IPC boundary (lib/tauri.ts)
├── dev/                      browser mode and harness hooks
├── styles/                   global.css: design tokens (dark/light) and component styles
└── assets/                   static assets (custom cursors)

src-tauri/src/                Rust backend
├── lib.rs, main.rs           Tauri setup, window creation, command registration
├── state.rs                  AppState: vault, watchers, sessions, LSP managers
├── commands/                 #[tauri::command] surface; mod.rs lists the modules
├── agent/                    providers, sessions, tools, MCP
├── code/                     project tree cache, LSP manager, git
├── lsp/                      shared LSP transport
├── python/                   runtimes, venvs, runner
├── devbridge.rs              HTTP bridge for browser mode (same command implementations)
└── dict.rs, translate.rs     offline dictionary and translation

docs/                       generated keybinding table (`pnpm docs:keybindings`)
vendor/                     vendored crates (anydoc, pdf-inspector)
scripts/                      dev-signing setup
```

### Key Concepts

- **Commands, not ad-hoc handlers.** User-visible actions are commands (`src/commands/builtin.ts`, registered in `registry.ts`, bound in `keys.ts`, scoped by key regions). A UI control and its keybinding call the same command, so the palette and rebinding stay honest.
- **Extensions are assembled in one place.** `src/editor/setup.ts` composes the CodeMirror extension tree; settings change behavior through compartments (`wrapCompartment`, `typewriterCompartment`), never by rebuilding editor state.
- **Agent modes have their own roots.** Coding, creative and study each read `<vault>/.bnote/agents/<mode>/` (`settings.json`, `AGENTS.md`, `skills/`); only coding also reads the code project (its `.bnote/settings.json` and instruction hierarchy, `.agents/skills`). The agent's home is the open vault's `.bnote` (credentials in `agent.json`, transcripts, tasks and plans all live there; `$HOME/.bnote` is only the fallback when no vault is open).
- **Single writer.** Zustand stores (and the Rust `AppState`) own their data. Components subscribe with selectors and do not mirror store state locally; async results must prove they still belong to the current state before writing.
- **Thin Rust surface.** Commands parse and validate input, then call feature modules. Long work (LSP, indexing) runs off the command thread and reports through events.
- **Two debugging loops.** Real backend on `localhost:1430`; deterministic harness at `/harness.html`. See DEBUG.md.

### Important Files

| File | Purpose |
|------|---------|
| `src/main.tsx`, `src/App.tsx` | Frontend entry and startup order (config, vault, focus restore) |
| `src/editor/setup.ts` | The single place where CodeMirror extensions are assembled |
| `src/commands/builtin.ts`, `keys.ts` | Command registry and key bindings |
| `src/state/appStore.ts` | Settings, config snapshot, persistence |
| `src/lib/tauri.ts` | Typed IPC boundary (`api`, `agentApi`, `focusApi`, ...) |
| `src-tauri/src/lib.rs` | Tauri setup and command registration |
| `src-tauri/src/state.rs` | `AppState` shared by every command |
| `src-tauri/src/devbridge.rs` | HTTP bridge used by browser mode; calls the same command implementations |
| `DEBUG.md` | Required debugging and verification protocol |

## Code Quality

Architecture and code must read like poetry — simple, clear, elegant — and be fast, lean, and secure by design.

### TypeScript — five rules

1. **Types at the boundary, no `any`.** `strict`, `noUnusedLocals`, and `noUnusedParameters` are on. Narrow `unknown` at IPC/DOM edges instead of casting; `as` is a last resort and needs a one-line reason. Type exported APIs explicitly; local inference is fine.
2. **Make illegal states unrepresentable.** Use discriminated unions (`{ phase: "idle" } | { phase: "focus"; endsAt: number }`), not parallel booleans that can disagree. Derive values (`remainingMs`) instead of storing a second copy.
3. **No floating promises.** `await` every async call, or `void` it with a stated reason. Every rejection either reaches the user (toast/error state) or is an intentional fallback. Typed linting is not enabled, so this is review-enforced.
4. **Pure logic outside UI glue.** Rules belong in plain modules (`focus/timer.ts`, `code/tree.ts`, `code/image.ts`) covered by vitest; React components and CodeMirror extensions only wire them to the DOM.
5. **One owner per state.** A store or a single module owns each value: no component-level mirrors, no module-level caches that survive HMR without an owner. Async callbacks re-check the reference or version before writing.

### Rust — five rules

1. **Correctness and clarity first.** New code must not `unwrap()`, `expect()`, or `panic!` on paths reachable from user input, disk contents, or IPC; propagate with `?`. Never discard a fallible result with `let _ =` — handle it or log it deliberately.
2. **Indexing and slicing can panic.** Use `get`, `strip_prefix`, and `split_once`; slice user text only on character boundaries. Markdown and PDF parsing code gets extra care.
3. **Errors must cross the IPC boundary.** Every command returns `CmdResult<T>` with a message the UI can act on. A command that fails silently is a bug.
4. **Follow the existing module layout.** One file per logical component; prefer extending an existing file over adding a small one. Feature directories keep their `mod.rs` module list (`commands/`, `agent/`, `code/`, `lsp/`, `python/`).
5. **Never hold a lock across blocking work or `.await`.** `AppState` mutexes are shared by every command: clone what you need, drop the guard, then do the work.

### Design: SOLID and root-cause fixes

- **S** — one module, one model; one piece of state, one writer.
- **O** — extend through registries, commands, and compartments instead of editing every call site.
- **L** — adapters keep the contract: `devbridge.rs` calls the same command implementations, not a parallel copy.
- **I** — expose only the actions callers need; no god store, no 40-method interface.
- **D** — core logic depends on seams (pure modules, `src/lib/tauri.ts`); platform code sits behind thin adapters.

**Never patch a bug.** Fix the model, not the symptom:

1. **Reproduce and quantify** — a minimal input plus per-frame/per-transaction evidence that names the exact code path.
2. **Explain the root cause** from the data flow, ordering, or geometry model, not from the symptom.
3. **Fix the model** — converge to one source of truth, one writer, an explicit ordering contract. Refactor when that is the honest fix; no special cases, fallbacks, delays, retries, or call-site exceptions.
4. **Prove the class is closed** — answer why the same bug cannot reappear through another entry point. If you cannot, the root cause is still unfound.

## Performance Is the Lifeline

bnote's core is **feel**: editing, scrolling, caret movement, and rendering must not jank, and must not race.

- **No jank.** Before touching a hot path (input transactions, decoration rebuilds, `updateListener`, measure cycles, scrolling), count the work per keystroke/frame and the layout reads; prove any O(document length) computation is necessary.
- **No races.** One writer per state (see above). Every async callback (`requestMeasure`, rAF, `setTimeout`, microtasks, IPC, file watcher) must re-validate against current state and drop stale results.
- **Measure, never guess.** Locate performance problems with deterministic measurements (per-frame DOM/layout/caret traces, transaction counts, measure counts). "Feels fine" is not evidence.
- **Keep the budget honest.** `src/editor/perf.gate.test.ts` and `src/code/perf.gate.test.ts` lock the order of magnitude of hot operations. Calibrate budgets from measured medians (~6–10×); update them from measurements, never by guesswork. Perf-sensitive changes get before/after measurement with the same protocol.
- **The full contract is [docs/PERFORMANCE.md](./docs/PERFORMANCE.md).** It defines the per-keystroke budget, the no-O(document) rule, the incremental-field pattern, the instrumentation (`src/perf/`, `.bnote/perf/*.jsonl`, `pnpm perf:report`) and the review checklist. The `bnote-performance` skill turns it into a repeatable review pass when the user asks for one.

## Comments

- Explain **why**, not what. If the code already says it, do not repeat it.
- Complex logic needs a comment at the decision point: ordering contracts, single-writer invariants, geometry models, platform workarounds. State the invariant and the failure it prevents.
- Prefer a short comment beside the tricky line over a long block at the top of the file.
- New and edited comments are English (see Language).

## Git

- **`git commit` and `git push` only when explicitly asked.** Leave changes uncommitted so the user can review them first; only push the branch the user names.
- Use Conventional Commits in English, imperative mood, subject at most 20 words: `feat:`, `fix:`, `refactor:`, `perf:`, `test:`, `docs:`, `build:`, `chore:`.
- One logical change per commit; do not mix refactors with behavior changes.
- Example: `fix: reflow math widgets after font load`.

## Debugging

Read **[DEBUG.md](./DEBUG.md)** before changing behavior; it defines the two loops, the real vault location, and the traps. The rules that must not be broken:

- **Do not build or deploy after a front-end change** unless the user asks. Building is the user's decision.
- Verify in the session browser against `localhost:1430`; do not steal focus and do not take full-screen screenshots. DOM assertions and bytes on disk are the source of truth.
- Browser verification uses **browseros**, with one tab group per task and the session handle passed on every call; never start playwright-cli or another browser tool. See DEBUG.md for the harness protocol.
- Native-only behavior (window levels, event taps, IME, native webviews) cannot be proven in a browser; say so and leave it for a deployed check.
- Close the tabs you opened; stop any dev server this session started.

## Test Gate

Run **`pnpm gate`** (= `pnpm lint` + `pnpm typecheck` + `pnpm test`) and make it pass before calling any change done.

- **Test root causes, not symptoms.** Put regression tests next to the module as `*.test.ts` (vitest, node environment). Lock behavior and invariants: normal flow, boundaries, idempotence, bidirectional rules.
- **A feature is not done without tests and gates.** Hot paths also get an order-of-magnitude perf gate.
- **Geometry and feel need browser measurement** in addition to unit tests: pure tests lock control flow, not pixels. Use the harness protocol in DEBUG.md and compare before/after.
- **Lint errors block; warnings need a reason.** New warnings (engine `any` assertions, dev-bridge `console.log`) must be justified.
- **Rust changes** run `cargo check` in `src-tauri` (and `cargo test --lib` for behavior changes), plus `cargo fmt` (the repo is rustfmt-clean; `rustfmt.toml` at the repo root sets the width). `src-tauri` is a single package: one lockfile and one target directory. Rust is not part of `pnpm gate`.
- If the gate fails under heavy machine load, check the load average and rerun the failing test alone; report the real result.

## Language

- All code is English: identifiers, types, comments, doc comments, test names, commit messages, and documentation (including this file).
- Chinese is reserved for user-facing UI copy and product strings.
- Legacy Chinese comments are migrated in a separate task; new or edited comments must be English.

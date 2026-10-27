<p align="center">
  <img src="./app-icon.png" width="104" alt="bnote app icon" />
</p>

<h1 align="center">bnote</h1>

<p align="center">
  A local-first Markdown notes app for macOS.<br />
  <strong>Tauri 2 · React 19 · CodeMirror 6 · Rust</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="CodeMirror 6" src="https://img.shields.io/badge/CodeMirror-6-B873F6?style=flat-square" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111111" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust&logoColor=white" />
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat-square" />
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/Baike12/bnote?style=flat-square&logo=github" />
  <img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/Baike12/bnote?style=flat-square" />
</p>

> **bnote** puts notes, paper/web reading, and a study assistant in one window. A vault is just a folder on disk and a note is just Markdown: version it with Git, open it in any editor, take it with you. The common workflows are built in — no plugin ecosystem required, and no Electron.

---

## Contents

- [Highlights](#highlights)
- [Editor](#editor)
- [Study mode](#study-mode)
- [Daily notes, todos, and footprints](#daily-notes-todos-and-footprints)
- [Canvas, attachments, and Python](#canvas-attachments-and-python)
- [Default shortcuts](#default-shortcuts)
- [Getting started](#getting-started)
- [Data and configuration](#data-and-configuration)
- [Architecture and performance](#architecture-and-performance)
- [Development and quality gates](#development-and-quality-gates)
- [Roadmap](#roadmap)
- [License and acknowledgements](#license-and-acknowledgements)

## Highlights

| Area | Capability |
| --- | --- |
| **Local-first** | A vault is a plain folder and a note is plain Markdown — usable from Git, iCloud, Dropbox, or any editor. |
| **Live preview** | The cursor line keeps its source; everything else renders Obsidian-style. Only the viewport is processed, so long documents stay smooth. |
| **Math and snippets** | KaTeX inline/block math; 220+ built-in LaTeX snippets with placeholders, regex captures, visual wrapping, and vault-level overrides. |
| **Vim and IME** | Native Vim mode with vimrc mappings; on macOS the input source follows insert/normal mode while math and code blocks stay English. |
| **Per-region keybindings** | The same chord can mean different things in global / notes / reading / agent regions; every command is searchable, rebindable, unbindable. |
| **Study mode** | Read PDFs, web pages, or WeRead in the center pane and take notes or chat with the study assistant on the right; annotations and reading positions are persisted per material. |
| **Selection translation** | Single words use the embedded offline ECDICT (59k entries); sentences go to a configurable model API (OpenAI-compatible / DeepSeek / GLM / Qwen / Anthropic / Ollama). |
| **Daily notes and todos** | Cross-file todos sync bidirectionally into today's daily note; completed unsent todos are recorded automatically; the day's edits become a "footprint" summary. |
| **Canvas and attachments** | Excalidraw drawings are saved as files with exported previews, re-inserted at the cursor on return; Obsidian `.excalidraw.md` is supported. |
| **Python** | All python fences in a note run as one `.py` file with streaming output and cancellation; `ty` diagnostics and `uv` environment management. |

## Editor

### Live preview

Obsidian-style: the cursor line keeps its source, everything else renders (`src/editor/livePreview.ts`).

- Headings, bold, italic, strikethrough, blockquotes, callouts, horizontal rules, lists, escapes, inline code, fenced code
- Fenced code is highlighted per language; language packs load on demand
- Inline `$...$` and block `$$...$$` math render with KaTeX; while editing, the source stays visible with a live preview below
- Task list checkboxes are clickable; completing one appends `✅ date`, clicking again reverts it
- `[[target|alias]]` wikilinks jump within the vault; external links open in the system browser
- `![alt](path)` and `![[image.png]]` resolve via relative path → vault root → file name, and only visible lines are rendered
- Embedded Excalidraw files show the exported PNG; clicking reopens the canvas
- Cursor and scroll position are restored when a note is reopened

### Math and LaTeX snippets

- 220+ built-in snippets: `Tab` expansion, expansion-on-type, placeholder mirroring, regex captures, visual-mode wrapping, and context detection for text/math/code
- Auto-sizing brackets, matrix shortcuts, Tabout, bracket-pair highlighting, double-dollar deletion, snippet whitespace cleanup
- A vault-level `.bnote/snippets.js` **replaces** the built-in set; saving hot-reloads it and load errors are surfaced in the UI
- LaTeX Suite behaviors can be toggled individually in Settings — no restart

### Vim and input methods

- `normal` / `insert` / `visual` modes; common vimrc mappings (`map`, `noremap`, `nnoremap`, `imap`, `vmap`) and key sequences such as `jj`
- `:w`, `:wq`, `:x`, `:q`, `:noh`; `:Bnote <command id>` maps any bnote command to a Vim key
- `o` / `O` preserve indentation; visual mode, jumplist, clipboard, and pixel-accurate vertical motion are native implementations
- On macOS the input source can follow the mode: Chinese for insert, English for normal/visual, English while inside math or code blocks
- Switching uses in-process Carbon TIS (millisecond-scale, background thread, skipped when already active) and is scoped to bnote: the previous source is restored when the window loses focus
- Vault-level mappings live in `.bnote/vimrc`; global mappings live in `vimrc` under the app data directory

### Commands, navigation, and workspace

- **Command palette**: fuzzy search over every command; adding a feature means registering one `CommandDef` (`src/commands/registry.ts`)
- **Quick switcher**: search by file or folder name, space-separated tokens match with AND; empty input shows recent files
- **Insert link**: complete a note at the cursor; if the current line already has a link, the same shortcut jumps to it; duplicate names are written as vault-relative paths
- **Back-links**: walk the wikilink jump history backwards without disturbing ordinary file opens
- **Quick add**: "name + target folder" presets create notes in one shot, creating missing folders and de-duplicating names
- **Quick todo**: a single input; Enter inserts the todo at the top of today's daily-note todo area without switching files
- **Headings**: cycle body → H1 → H2 → H3 → H4; `Cmd+1..6` set a level directly, with optional automatic `1 / 1.1 / 1.1.2` numbering
- **Keybinding editor**: search, filter, record, unbind, restore defaults per region; conflicts remove the old binding and one command can hold several keys
- **Files**: one flat walk builds the file/directory/asset index (`list_files`); expansion only affects visible rows. Create, rename, delete, context menu, and recent-vault switching
- **Writing**: typewriter mode, adjustable editor font size, save-after-idle, dark and light themes

## Study mode

Study mode is a two-column layout: **content (left) + a right pane with Notes / Study assistant tabs**. The divider is draggable and the content width is stored in pixels; both tabs stay mounted, so switching never rebuilds the editor.

### PDF

- Imported PDFs are copied into `.bnote/materials/pdfs/<pinyin-dir>/` next to their annotations and sessions; no Markdown conversion
- Rendered with pdf.js, with an outline sidebar, zoom, text selection, and an eye-care tint
- **Annotations**: yellow highlights and blue notes stored as whole-page ratios — zoom, cropping, and DPR changes do not move them; the right margin lists them
- **Reading position**: page number + offset within the page, so re-layout resumes at the same place
- **Snapshot to assistant**: the visible area is composited from the page canvases (no screen-recording permission) and attached to the assistant input
- The history dropdown returns to any previously opened PDF

### Web pages and WeRead

- Web pages run in a **native child webview**, not an iframe, so `X-Frame-Options` and CSP `frame-ancestors` cannot block them; scrolling and geometry follow the content pane
- **Annotations**: highlights and notes are anchored by quote + 40 characters of context + offset, so ads and lazy loading cannot shift them; stored per URL in `.bnote/web-annotations/<host>-<hash>.json` with a localStorage fallback inside the page
- **Reading position** is a scroll ratio, so reopening returns to the same passage
- **Paged reading**: `PageUp` / `PageDown` scroll by a configurable fraction and snap to text lines; the upper half of the page dims as a progress cue
- **Page zoom**: `− / percentage / +` in the toolbar, or `⌘=` / `⌘-` / `⌘0`; browser-level zoom that reflows text and scales the whole page (50%–300%)
- **WeRead adaptation**: full-width reading area, catalog docked on the left; SPA route changes are tracked so the current book enters history

### Selection translation

- **Words** (exactly one English token): the embedded ECDICT dictionary, 59,137 common entries, ~1.5 MB compressed into the binary and decompressed into memory on first lookup
- **Sentences and phrases** (two or more tokens): the configured model API. A missing word **never** falls back to the model; the card asks you to select more words instead
- Protocols: OpenAI-compatible, DeepSeek, GLM, Qwen, Anthropic, Ollama (defaults to `http://127.0.0.1:11434`, `POST /api/chat`)
- Thinking is sent per protocol (`think` / `thinking.type` / `enable_thinking`) and is off by default
- API keys and requests stay in Rust (`translate.json`); the page never sees the key. Sentence requests from the web preview are throttled to one per 600 ms
- Settings includes a "test connection" button that uses unsaved form values
- Local services such as Ollama are yours to start; bnote is only an HTTP client and never spawns them

### Study assistant

- Supports Anthropic Messages and OpenAI-compatible protocols with SSE streaming
- **Per-material sessions**: each PDF or URL keeps its conversations in that material's `sessions/<session>.jsonl`, whose first line is metadata (title + model config snapshot); switching materials switches back to its session
- Fork from any message into an auxiliary session, switch between the primary and auxiliary sessions, and browse history from a drawer
- The footer shows context usage (input + output of the last request against the configured context window)
- Paste screenshots or pick images as message attachments
- Vault-level custom instructions in `.bnote/agent.md` are appended to the system prompt
- The assistant is currently **pure Q&A**: no tools are registered (file-system / MCP tools are not enabled), so it answers from the model's own knowledge

## Daily notes, todos, and footprints

- A todo in any note can be sent to today's daily note (default `Daily/YYYY-MM-DD.md`, created automatically)
- After sending, both sides stay in sync: completion state and subtask edits mirror in both directions; an existing identical entry in the daily note is adopted instead of duplicated
- Todos that were never sent are still recorded in the daily note when checked, and cleaned up when unchecked
- The daily note ends with a "footprint": non-todo additions and edits of the day grouped by source file, each jumping back to the original text
- Todo mappings live in `.bnote/daily-links.json`; footprint baselines in `.bnote/daily-footprints.json`

## Canvas, attachments, and Python

### Canvas and attachments

- Open an Excalidraw canvas from the command palette; it has its own keymap and saves before switching files
- New drawings are saved as `<name>.excalidraw` with a same-named PNG exported for Markdown previews
- Compatible with the Obsidian Excalidraw plugin's `.excalidraw.md` (including `compressed-json`)
- Returning to the source note inserts `![[...]]` at the original cursor position
- Images, PDFs, and other media enter the vault asset index used for Markdown resolution

### Python

- All `python` fences in a note are aligned by line number and run as one virtual `.py` file
- `Cmd+Enter` runs the note; stdout/stderr stream into a bottom panel with stop, exit code, duration, and a 300-second timeout
- `ty`-based completion, hover, and diagnostics, toggled from the command palette
- Create or sync a `uv` environment for the current project (`uv init --bare` + `uv sync`), with logs in the run panel

## Default shortcuts

> macOS defaults. Every command can be rebound or unbound per region in Settings → Shortcuts; the settings page is the source of truth.

### Workspace and navigation

| Shortcut | Action |
| --- | --- |
| `Cmd+P` | Command palette |
| `Cmd+O` | Quick switcher |
| `Cmd+N` / `Cmd+S` | New / save note |
| `Cmd+Shift+A` | Quick add file |
| `Cmd+Shift+K` | Quick todo into today's daily note |
| `Cmd+Shift+O` | Open today's daily note; press again inside to jump back |
| `Cmd+Shift+R` | Switch to a recent vault |
| `Cmd+,` | Settings |
| `Cmd+\` | Toggle sidebar |
| `Cmd+I` | Focus sidebar |
| `Cmd+[` | Go back in link history |
| `Cmd+T` | Jump to the header question-todo / return |
| `Cmd+Shift+S` | Enter / leave study mode |

### Editing

| Shortcut | Action |
| --- | --- |
| `Cmd+M` / `Cmd+Shift+M` | Insert block / inline math |
| `Cmd+Shift+C` / `` Cmd+` `` | Insert code block / inline code |
| `Cmd+Shift+B` | Insert callout |
| `Cmd+Shift+H` | Insert horizontal rule |
| `Cmd+K` | Insert wikilink; jump when the line already has one |
| `Cmd+B` / `Cmd+Shift+I` / `Cmd+Shift+D` | Bold / italic / strikethrough |
| `Cmd+J` / `Cmd+1..6` | Cycle heading level / set level N |
| `Cmd+L` | Toggle todo |
| `Cmd+Shift+J` | Send todo to today's daily note (keep in sync) |
| `Cmd+;` / `Cmd+Shift+;` | Bullet / numbered list |
| `Cmd+Enter` | Run the note's Python code |
| `Cmd+E` | Toggle live preview / source mode |
| `Cmd+Shift+V` / `Cmd+Shift+T` / `Cmd+Shift+L` | Toggle Vim / typewriter / LaTeX snippets |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | Editor font larger / smaller / reset (global; the reading region gives these keys to web zoom) |

### Study mode and reading region

| Shortcut | Action |
| --- | --- |
| `PageUp` / `PageDown` | Previous / next page (fixed keys, unaffected by rebinding) |
| `Cmd+Shift+E` | Snapshot the visible reading area into the assistant |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | Web page zoom in / out / reset (when a web page is open) |
| `Cmd+Shift+U` | Toggle the right pane: notes / assistant |
| `Cmd+Shift+Y` | Assistant: switch primary / auxiliary session |
| `Cmd+Shift+N` | Assistant: new session |
| `Cmd+Shift+F` | Assistant: fork the current session |
| `Cmd+Shift+H` | Assistant: open session history |
| `Cmd+[` | Assistant: return from a forked session |
| `Cmd+Option+A` / `Cmd+Option+N` / `Cmd+Option+R` | Focus assistant / notes / reading region |

> The assistant's `⌘⇧N` / `⌘⇧F` / `⌘⇧H` / `⌘⇧Y` and `⌘[` only apply while focus is inside the assistant panel; `⌘[` in the notes region is link history.

## Getting started

```bash
git clone https://github.com/Baike12/bnote.git
cd bnote
pnpm install
pnpm tauri dev
```

Pick a vault folder on first launch.

### Requirements

- macOS
- Node.js 20+
- pnpm
- Rust stable
- Xcode Command Line Tools

Optional: `uv` (Python environments), `ty` (Python type checking), Ollama or another model service (sentence translation / study assistant).

### Build

```bash
pnpm tauri build
```

Produces `.app` / `.dmg` bundles via Tauri.

### Tests and checks

```bash
pnpm gate                                            # lint + typecheck + unit tests
cargo test --manifest-path src-tauri/Cargo.toml      # Rust tests
cargo check --manifest-path src-tauri/Cargo.toml     # Rust compile check
```

## Data and configuration

### Application data

`~/Library/Application Support/com.bnote.app/`

| File | Purpose |
| --- | --- |
| `config.json` | Recent vaults, last file, settings, cursor positions, window geometry |
| `keybindings.json` | Global keybinding overrides, grouped by region |
| `vimrc` | Global Vim mappings |
| `agent.json` | Assistant protocol, base URL, model, API key, context window |
| `translate.json` | Sentence translation protocol, base URL, model, API key, thinking, timeout |

### Vault-level configuration

| Path | Purpose |
| --- | --- |
| `.bnote/keybindings.json` | Vault-level keybinding overrides |
| `.bnote/vimrc` | Vault-level Vim mappings (take precedence) |
| `.bnote/snippets.js` | Vault-level LaTeX snippets; replaces the built-in set |
| `.bnote/agent.md` | Vault-level custom instructions for the assistant |
| `.bnote/materials/index.json` | Material registry: identity → directory |
| `.bnote/materials/pdfs/<dir>/` | PDF file, `annotations.json`, `sessions/*.jsonl` |
| `.bnote/materials/webpages/<dir>/` | Web material sessions |
| `.bnote/materials/wxreads/<dir>/` | WeRead material sessions |
| `.bnote/web-annotations/<host>-<hash>.json` | Web annotations, one file per URL |
| `.bnote/read-positions.json` | Reading positions (PDF page + offset; web scroll ratio) |
| `.bnote/daily-links.json` | Cross-file todo mappings |
| `.bnote/daily-footprints.json` | Daily footprint baselines |

## Architecture and performance

```text
src/                        Frontend: React 19 + CodeMirror 6 + Zustand
  editor/                   Live preview, KaTeX, LaTeX snippets, Vim, typewriter, IME follow
  commands/                 Command registry, per-region keymap, built-in commands
  components/               Sidebar, editor, study layout, PDF viewer, agent panel, settings
  study/                    Materials, PDF/web annotations, reading positions, WeRead, web runtime, zoom
  daily/  footprint/        Cross-file todos and daily footprint diff/rendering
  python/                   Code block extraction, run panel, type-check client
  dev/                      Browser debug entry and harness

src-tauri/src/              Rust backend
  commands/                 vault/files/config/materials/agent/python/ime/translate
  agent/                    Providers (Anthropic + OpenAI-compatible), SSE streaming, sessions
  python/                   Runner, ty LSP bridge, uv environments
  dict.rs                   Embedded ECDICT (binary asset + binary search)
  translate.rs              Selection classification and translation requests
  devbridge.rs              Browser-mode IPC bridge (127.0.0.1:1439)

scripts/build-dict.py       Generates the dictionary asset from a pinned ECDICT commit
```

Design principles that cut across the codebase:

- **The filesystem is the source of truth**: notes, annotations, and sessions live in the vault; Rust file I/O runs on `spawn_blocking` and never blocks the UI
- **Single writer**: each piece of state has exactly one writer; asynchronous callbacks (measure, watcher, streaming events) prove they still belong to the current state and drop stale results
- **Vault watcher**: a plain FSEvents-based watcher with a hand-rolled debouncer emits `vault-changed` after 300 ms of silence, avoiding a full-tree scan on startup
- **Viewport-only work**: live preview walks only the visible syntax tree; performance-sensitive paths are guarded by [`src/editor/perf.gate.test.ts`](src/editor/perf.gate.test.ts) on a ~900-line mixed document (10× regressions fail the gate)
- **Native capabilities stay in Rust**: file I/O, the web preview (a native child webview), and translation/model requests all originate in Rust; API keys never enter a page context

## Development and quality gates

- **Frontend**: `pnpm dev` starts Vite; `pnpm tauri dev` starts the full app. `pnpm gate` = `eslint` + `tsc --noEmit` + `vitest`, and is the definition of "done"
- **Real backend in a browser**: with `pnpm tauri dev` running, `http://localhost:1430/` is the real app (devbridge supplies Tauri IPC, a real vault, a real file tree, and real watcher events)
- **Pure frontend harness**: `http://localhost:1430/harness.html` mounts the editor with every extension plus an in-memory fake vault for deterministic DOM assertions and geometry measurements
- **Design constraints and debugging protocol**: see [`AGENTS.md`](AGENTS.md)

## Roadmap

- Multiple tabs
- Full-text search across the vault
- Knowledge graph / graph view
- More complete vimrc support: `<leader>` prefixes and more `:set` options

## License and acknowledgements

Released under the [MIT License](LICENSE).

The embedded dictionary is derived from [ECDICT](https://github.com/skywind3000/ECDICT) (MIT); the source commit and build parameters are recorded in `src-tauri/resources/ecdict_common.json`. Thanks also to [Tauri](https://tauri.app/), [CodeMirror](https://codemirror.net/), [KaTeX](https://katex.org/), [pdf.js](https://mozilla.github.io/pdf.js/), and [Excalidraw](https://excalidraw.com/).

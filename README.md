<p align="center">
  <img src="./app-icon.png" width="104" alt="bnote app icon" />
</p>

<h1 align="center">bnote</h1>

<p align="center">
  A local-first Markdown notes app for macOS.<br />
  <strong>Tauri 2 · React 19 · CodeMirror 6 · Rust</strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
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

> **bnote** puts notes, paper/web reading, code repositories, and a coding agent in one window. A vault is just a folder on disk and a note is just Markdown: version it with Git, open it in any editor, take it with you. The common workflows are built in — no plugin ecosystem required, and no Electron.

---

## Highlights

| Area | Capability |
| --- | --- |
| **Local-first** | A vault is a plain folder and a note is plain Markdown — usable from Git, iCloud, Dropbox, or any editor. |
| **Four modes** | Notes / study / code / projects: mutually exclusive full-screen modes, each with its own layout, key region, and width preferences. |
| **Live preview** | The cursor line keeps its source; everything else renders Obsidian-style. Only the viewport is processed, so long documents stay smooth. |
| **Math and snippets** | KaTeX inline/block math; 220+ built-in LaTeX snippets with placeholders, regex captures, visual wrapping, and vault-level overrides. |
| **Vim and IME** | Native Vim mode with vimrc mappings; on macOS the input source follows insert/normal mode while math and code blocks stay English. |
| **Per-region keybindings** | The same chord can mean different things in global / notes / reading / agent / code / project regions; every command is searchable, rebindable, unbindable. |
| **Study mode** | Three columns: ask the agent on the left, read a PDF / web page / WeRead in the middle, take notes on the right; annotations, reading positions, and sessions persist per material. |
| **Selection translation** | Single words use the embedded offline ECDICT (59k entries); sentences go to a configurable model API (OpenAI-compatible / DeepSeek / GLM / Qwen / Anthropic / Ollama). |
| **Code mode** | Its own three columns (agent \| code \| notes): file tree, tree-sitter highlighting, LSP navigation and completion, git diffs, integrated terminal. |
| **Coding agent** | Tools, permissions, plan mode, hooks, output styles, auto memory, and prompt history follow Claude Code's structure; runtime state lives in `~/.bnote`. |
| **Project management** | Each project is a Markdown todo list; the board is laid out horizontally, todos can be dragged and sent to today's daily note. |
| **Daily notes and todos** | Cross-file todos sync bidirectionally into today's daily note; completed unsent todos are recorded automatically; the day's edits become a "footprint" summary. |
| **Canvas and attachments** | Excalidraw drawings are saved as files with exported previews, re-inserted at the cursor on return; Obsidian `.excalidraw.md` is supported. |
| **Python** | All python fences in a note run as one `.py` file with streaming output and cancellation; `ty` diagnostics and `uv` environment management. |
| **Focus mode** | Pomodoro plus pseudo-fullscreen and a hard lock: you cannot quit or switch apps before the time is up, and a restart resumes the countdown. |

## Getting started

```bash
git clone https://github.com/Baike12/bnote.git
cd bnote
pnpm install
pnpm tauri dev
```

Pick a vault folder on first launch; code mode needs no vault — point it at a repository.

### Requirements

- macOS
- Node.js 20+
- pnpm
- Rust stable
- Xcode Command Line Tools

Optional: `uv` (Python environments), `ty` (Python type checking), Ollama or another model service (sentence translation / agent).

### Build

```bash
pnpm tauri build
```

Produces `.app` / `.dmg` bundles via Tauri.

### Tests and checks

```bash
pnpm gate                                            # lint + typecheck + format check + unit tests
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests
cargo check --manifest-path src-tauri/Cargo.toml  # Rust compile check
cargo fmt --manifest-path src-tauri/Cargo.toml --check       # Rust format check
```

## Four modes

| Mode | Layout | How to enter |
| --- | --- | --- |
| **Notes** | Sidebar + editor | default |
| **Study** | Agent \| content \| notes | `Cmd+Shift+S` |
| **Code** | Agent \| code project \| notes | command palette (unbound by default, see below) |
| **Projects** | project list \| board \| daily note | `Cmd+Shift+P` |

- Exactly one mode is active at a time; switching modes does not rebuild CodeMirror instances, so scroll position, folds, and decorations survive.
- Study and code mode both use three columns with two draggable dividers. The first two widths are stored in pixels (`studyAgentWidth` / `studyContentWidth` and `codeAgentWidth` / `codeContentWidth` separately) and the third column takes the rest; a narrow window clamps the first two with CSS without rewriting your preference.
- **Code mode has no default shortcut**: `Cmd+Shift+C` is "insert code block". Bind `view.toggle-code-mode` in the `global` section of `keybindings.json` if you want one.

## Editor

### Live preview

Obsidian-style: the cursor line keeps its source, everything else renders (`src/editor/livePreview.ts`).

- Headings, bold, italic, strikethrough, blockquotes, callouts, horizontal rules, lists, escapes, inline code, fenced code
- Fenced code is highlighted per language; language packs load on demand
- Inline `$...$` and block `$$...$$` math render with KaTeX; while editing, the source stays visible, block math keeps a live preview below, and inline math renders a copy right after the source until the cursor leaves
- Task list checkboxes are clickable; completing one appends `✅ date`, clicking again reverts it
- Callouts use `:::` fences. `Cmd+Shift+B` inserts an empty block / jumps / jumps back without a selection, and with a selection moves it under a titled block anchored by the title text
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

Study mode is a **three-column** layout: **agent (left) + content (middle) + notes (right)**. Both dividers drag, widths are stored in pixels, and all three columns stay mounted permanently — switching materials or turning pages rebuilds nothing. The left column is the study assistant; `Cmd+Shift+G` switches it to creative mode.

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
- **Page zoom**: `− / percentage / +` in the toolbar, or `Cmd=` / `Cmd-` / `Cmd0`; browser-level zoom that reflows text and scales the whole page (50%–300%)
- **WeRead adaptation**: full-width reading area, catalog docked on the left; SPA route changes are tracked so the current book enters history

### Selection translation

- **Words** (exactly one English token): the embedded ECDICT dictionary, 59,137 common entries, ~1.5 MB compressed into the binary and decompressed into memory on first lookup
- **Sentences and phrases** (two or more tokens): the configured model API. A missing word **never** falls back to the model; the card asks you to select more words instead
- Protocols: OpenAI-compatible, DeepSeek, GLM, Qwen, Anthropic, Ollama (defaults to `http://127.0.0.1:11434`, `POST /api/chat`)
- Thinking is sent per protocol (`think` / `thinking.type` / `enable_thinking`) and is off by default
- API keys and requests stay in Rust (`translate.json`); the page never sees the key. Sentence requests from the web preview are throttled to one per 600 ms
- Settings includes a "test connection" button that uses unsaved form values
- Local services such as Ollama are yours to start; bnote is only an HTTP client and never spawns them

### Study assistant and creative mode

- The study assistant is **pure Q&A**: no tools are registered, and it answers about the current PDF or web page. It supports Anthropic Messages and OpenAI-compatible protocols with SSE streaming
- **Per-material sessions**: each PDF or URL keeps its conversations in that material's `sessions/<session>.jsonl`, whose first line is metadata (title + model config snapshot); switching materials switches back to its session
- Fork from any message into an auxiliary session, switch between the primary and auxiliary sessions, and browse history from a drawer
- The footer shows context usage (input + output of the last request against the configured context window)
- Paste screenshots or pick images as message attachments
- **Creative mode** (`Cmd+Shift+G`): the same panel runs the creative definition with file read/write, bash, skills, MCP, and an HTML preview tool, producing articles or HTML rendered live in the panel
- Custom instructions live in the vault's `.bnote/AGENTS.md` (the legacy `.bnote/agent.md` is still read)

## Code mode

Code mode is a **mode of its own**, unrelated to the vault: ask the agent on the left, write code in the middle, keep taking notes on the right. Its column widths are persisted separately.

### File tree and editor

- **File tree**: the backend walks once (respecting `.gitignore`) and the frontend folds it into a tree; expanding a folder never touches the disk again. Git status letters sit on the right (M/A/D/?/R), language icons come from the extension
- **Syntax highlighting**: TypeScript / Rust / Go / Python use dedicated tree-sitter grammars (incremental); other languages fall back to a generic set. Grammars load on demand
- **Images**: bitmaps render through the asset protocol; SVG still opens as text
- **Tree actions**: `Cmd+Shift+E` focuses the tree (expands to the current file; `↑↓` / `→←` / `Enter` / `Esc`), `Cmd+B` toggles it, the width drags

### Language servers

- One LSP process per language over standard `Content-Length` framed JSON-RPC. Built-in defaults cover ts / rust / go / python; the launch command is configurable in Settings and a project-level `.bnote/lsp.json` adds another layer (it travels with the repository)
- **Navigation and hints**: go to definition (F12) / type definition (`Cmd+F12`) / implementation / references (`Shift+F12`) / rename (F2), hover signatures, completion (`Ctrl+Space`), workspace symbols
- Completion triggers automatically after `.` / `::`; `F8` / `Shift+F8` walk the problem list
- Python projects get the venv's `VIRTUAL_ENV` and `PATH` injected

### Git and terminal

- **Git**: status, stage/unstage, and a diff view (unified or side-by-side, the side-by-side pairs lines by longest common subsequence and aligns the changed line)
- **Integrated terminal**: `portable-pty` in Rust plus xterm in the frontend, a full-width multi-tab drawer toggled with `Ctrl+\``; sessions are re-attached rather than rebuilt, and resizing writes CSS variables only

### Coding agent

- Opening a repository in the middle column switches the left agent to the coding definition: the session uses the repository root as its workdir (relative paths and bash anchor there), and tasks, history, and memory are recorded under that project
- Every tool is available: file read/write, glob / grep, bash (background and kill), todo, subagent dispatch, skills, MCP, plan mode, and asking the user
- The project root is the sandbox: reads and writes inside are allowed, everything outside is refused (relative paths are lexically normalized and then canonicalized, and symlinks pointing outside are rejected too)
- Transcripts live in `~/.bnote/projects/<project key>/<session>.jsonl`; no code material directory ever appears in the vault

## Project management

- Layout: **project list | board | daily note**, with draggable dividers on both sides
- A project is one todo list in `<vault>/.bnote/projects/<name>.md`. Markdown is deliberate: a project todo has to be editable with Vim, checkable, and recognizable by the cross-file todo sync
- The board is genuinely multi-column: the current column is centered and editable (CodeMirror with Vim), the others are DOM previews — clicking one focuses it. Switching projects only swaps the document, never rebuilds the editor
- Todos drag between columns (children follow their parent); the column header shows the project name and open count
- Create / delete: `Cmd+Shift+N` creates, `Cmd+Backspace` moves the current project to the trash (project region only); the context menu and the `⋯` header menu offer the same actions
- `Cmd+Shift+J` inserts the current todo at the **top** of today's daily todo area (in the notes region the same key appends to the end)

## Daily notes, todos, and footprints

- A todo in any note can be sent to today's daily note (default `Daily/YYYY-MM-DD.md`, created automatically)
- After sending, both sides stay in sync: completion state and subtask edits mirror in both directions; an existing identical entry in the daily note is adopted instead of duplicated
- Todos that were never sent are still recorded in the daily note when checked, and cleaned up when unchecked
- The daily note ends with a "footprint": non-todo additions and edits of the day grouped by source file, each jumping back to the original text
- Creating a new daily note carries over the previous note's unfinished todos
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

## Agent

The agent follows Claude Code's structure: definitions and prompts are compiled into the binary. Each mode owns its configuration — `<vault>/.bnote/agents/<mode>/{settings.json, AGENTS.md, skills/, output-styles/}` by default, so it travels with the notebook — while session records and other runtime state stay in `~/.bnote`.

### Three modes, three scopes

| Mode | Model | MCP | Skills | Instructions |
| --- | --- | --- | --- | --- |
| Coding | shared | own `mcpServers` | mode root + project `.agents/skills` + `~/.agents/skills` | mode root, then the repository hierarchy |
| Creative | shared | own `mcpServers` | mode root only | mode root only |
| Study | shared | none (no tools) | none | mode root only |

The model, endpoint and API key are machine-level (one key per machine) and stored in `~/.bnote/agent.json`; that file also holds the optional `agent_roots` override for each mode.

### Model and protocols

- Anthropic Messages, OpenAI-compatible, DeepSeek, GLM, Qwen, Ollama, and custom endpoints, all with SSE streaming
- Model configuration in `~/.bnote/agent.json` (protocol, base URL, model, API key, context window); a legacy `agent.json` in the app data directory is migrated on first launch
- API keys are used only in Rust and never enter a page context

### Instruction files (AGENTS.md)

- **Every mode** reads its own `<vault>/.bnote/agents/<mode>/AGENTS.md` and `rules/*.md` (moved there once from the old `~/.bnote` and `.bnote/AGENTS.md` locations)
- **Coding sessions** additionally read `AGENTS.md` / `CLAUDE.md` / `.bnote/AGENTS.md` / `.bnote/rules/*.md` / `AGENTS.local.md` from the repository root down to the working directory
- **Study and creative sessions** never read a repository's instruction files
- `@import` is followed (up to 5 levels, skipping code fences and comments) and `settings.instructionsExcludes` filters files by glob
- When a file is read, any not-yet-loaded `AGENTS.md` between its directory and the project root is injected as a system-reminder on the next turn

### Tools, permissions, and plan mode

- **Tools**: `read_file` / `write_file` / `edit_file` / `list_files` / `glob` / `grep` / `bash` (with `bash_output`, `bash_kill`), `todo`, `task`, `skill`, `mcp`, `task_*`, `ask_user_question`, `send_message`, `EnterPlanMode` / `ExitPlanMode`
- **Subagents**: `general-purpose` (all tools), `explore` (read-only), `plan` (read-only planning), and `fork` (inherits the current context); they run in parallel or in the background, and their transcripts land in `~/.bnote/projects/<project key>/<session>/subagents/`
- **Four permission modes** (shield menu): confirm before changes / autonomous / full access / plan. Rules in `permissions.allow / ask / deny` are evaluated before the mode and accept forms such as `Bash(git push:*)` and path globs
- **Plan mode**: read-only investigation; file writes and side-effecting commands are refused. `ExitPlanMode` writes the plan to `~/.bnote/plans/<slug>.md` and shows an approval card; the previous mode returns only after you approve
- **Context**: long sessions are compacted automatically (with a circuit breaker), large tool results are persisted and referenced, and Anthropic system prompts are split into static/dynamic blocks with `cache_control` on the static one

### Settings layers, hooks, and output styles

- **Layers merge**: the mode's `settings.json`, then (coding only) `<project>/.bnote/settings.json` and `settings.local.json`; arrays concatenate and deduplicate, objects deep-merge, scalars take the last value. Fields: `mcpServers`, `disabledMcpServers`, `skillDirs`, `disabledSkills`, `env`, `permissions`, `hooks`, `outputStyle`, `instructionsExcludes`, `cleanupPeriodDays`, `plansDirectory`, `autoMemoryEnabled`, `autoMemoryDirectory`
- **MCP is per mode**: a server list in the mode's `settings.json`; `disabledMcpServers` keeps a server configured while switching it off from the settings page
- **Hooks**: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`. They run through `sh -c` with JSON on stdin and a 60-second default timeout, and can return `permissionDecision`, `additionalContext`, or `updatedInput`; a non-zero exit can block a tool
- **Output styles**: built-in default / Explanatory / Learning, plus custom files in `<mode root>/output-styles/*.md` and (coding) `<project>/.bnote/output-styles/*.md` (frontmatter: `name` / `description` / `keep-coding-instructions`); the selected `settings.outputStyle` is injected as a dynamic segment
- **Settings UI follows the mode**: `Settings → Agent` shows `Model | MCP | Skills | AGENTS.md | Advanced` for coding, `Model | MCP | Skills | AGENTS.md` for creative, and `Model | AGENTS.md` for study. Every page reads and writes the real files (root path with an override, settings.json editor with parse state, per-server MCP switches); the window keeps one height and scrolls instead of resizing

### Memory, history, and skills

- **Auto memory**: `~/.bnote/projects/<project key>/memory/MEMORY.md` is the only index, one file per memory, linked with `[[name]]`; coding sessions get the index plus the memory behavior prompt on every turn
- **Prompt history**: every send appends to `~/.bnote/history.jsonl`. With an empty input, `↑` recalls this project's earlier prompts and `↓` walks forward; the walk resets after sending
- **Skills**: coding scans `<vault>/.bnote/agents/coding/skills/`, `<code project>/.agents/skills/`, `~/.agents/skills/` (the Agent Skills convention) and `skillDirs`; creative scans only its own root; a duplicated name keeps the highest-precedence copy. The settings page groups the list by source

### The `~/.bnote` layout

```text
~/.bnote/
├── agent.json            protocol / model / API key / per-mode root overrides
├── history.jsonl         prompt history
├── plans/<slug>.md       plan-mode output
├── tasks/<list>/         persisted task list state
└── projects/<project key>/
    ├── memory/MEMORY.md  auto-memory index
    ├── <session>.jsonl   coding session transcript
    └── <session>/        subagents/ and tool-results/

<vault>/.bnote/agents/<mode>/
├── settings.json         MCP, skill dirs, permissions, hooks, output style
├── AGENTS.md             the mode's instructions
├── rules/*.md
├── skills/<name>/SKILL.md
└── output-styles/*.md
```

## Focus mode

- Click the status-bar chip to start; the command palette has `focus.pomodoro-start` (`Cmd+Alt+T`, using the first configured duration)
- **One pomodoro is one continuous stretch**: no break phase, no pause, no ending early — only "start"
- Starting means pseudo-fullscreen (level 25, covering the menu bar, spanning Spaces), the hard lock, and the timer all at once. The hard lock needs the accessibility permission; without it the stretch does not start and the notice points at System Settings
- The hard lock swallows `Cmd+Tab` / `Cmd+Space` / `Ctrl+↑` / `Cmd+Q`; app menu keys (`Cmd+M` / `Cmd+H` / `Cmd+W`) keep working
- Up to three durations can be configured and cannot change mid-session; a restart restores both the countdown and the locks
- When time is up the locks release and the window level is restored; a running session writes the countdown into the window title

## Keybindings

Every action is a command: reachable from the palette (`Cmd+P`), bound to a key, and rebindable. The table of defaults is generated from the keymap, not written here: **[docs/keybindings.md](docs/keybindings.md)**.

- **Per-region keymap**: the same chord means different things depending on what has focus — `global` / `notes` / `reading` / `agent` / `project` / `code`. In the assistant panel `Cmd+[` returns to the parent session; in the notes region it goes back to the previous link jump.
- **Rebinding**: Settings → Hotkeys records a new chord, unbinds, and restores defaults per region. Overrides live in `<vault>/.bnote/keybindings.json`, which travels with the vault and is safe to hand-edit.
- **Unbound by design**: `view.toggle-code-mode` has no default chord (`Cmd+Shift+C` inserts a code block), and `app.quit` is unbound so an accidental `Cmd+Q` cannot quit the app — focus mode's hard lock swallows it while a pomodoro runs anyway.

## Data and configuration

### Application data

`~/Library/Application Support/com.bnote.app/`

| File | Purpose |
| --- | --- |
| `config.json` | Recent vaults, last file, settings, cursor positions, window geometry, code project |
| `keybindings.json` | Global keybinding overrides, grouped by region |
| `vimrc` | Global Vim mappings |
| `translate.json` | Sentence translation protocol, base URL, model, API key, thinking, timeout |

### Agent runtime (`~/.bnote`)

| Path | Purpose |
| --- | --- |
| `agent.json` | Protocol, base URL, model, API key, context window, and the optional per-mode `agent_roots` |
| `history.jsonl` | Prompt history (recalled with `↑`) |
| `plans/` | Plan-mode plan files |
| `tasks/<list>/` | Persisted task list state |
| `projects/<project key>/` | Per project: `memory/`, session `.jsonl`, subagents, tool results |

`BNOTE_HOME` moves the whole directory elsewhere.

### Vault-level configuration

| Path | Purpose |
| --- | --- |
| `.bnote/keybindings.json` | Vault-level keybinding overrides (`global` / `notes` / `reading` / `agent` / `project` / `code`) |
| `.bnote/vimrc` | Vault-level Vim mappings (take precedence) |
| `.bnote/snippets.js` | Vault-level LaTeX snippets; replaces the built-in set |
| `.bnote/agents/<mode>/` | The mode's configuration root: `settings.json`, `AGENTS.md`, `skills/`, `rules/`, `output-styles/` |
| `.bnote/settings.json`, `.bnote/settings.local.json` | Code-project agent settings, layered over the coding mode root |
| `.agents/skills/` | Code-project skills (the Agent Skills convention) |
| `.bnote/lsp.json` | Language server launch commands (travels with the repository) |
| `.bnote/projects/<name>.md` | One project todo list |
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
  components/               App chrome, the four mode layouts, agent panel, PDF viewer, settings
  study/                    Materials, PDF/web annotations, reading positions, WeRead, web runtime, zoom
  code/                     File tree, editor, LSP client, git diff, problems, terminal
  projects/                 Project board model, dragging, sending to the daily note
  focus/                    Pomodoro state machine and focus lock
  daily/  footprint/        Cross-file todos and daily footprint diff/rendering
  python/                   Code block extraction, run panel, type-check client
  dev/                      Browser debug entry and harness

src-tauri/src/              Rust backend
  commands/                 vault/files/config/materials/agent/python/ime/translate/focus/term
  agent/                    Providers, sessions, tools, subagents, home, instructions, settings, hooks, output styles
  code/ lsp/                Project tree cache, git, shared LSP transport
  python/                   Runner, ty LSP bridge, uv environments
  dict.rs / translate.rs    Embedded ECDICT and selection classification / translation requests
  devbridge.rs              Browser-mode IPC bridge (127.0.0.1:1439)

scripts/                    Dev signing setup
```

Design principles that cut across the codebase:

- **The filesystem is the source of truth**: notes, annotations, and sessions live on disk (the vault or `~/.bnote`); Rust file I/O runs on `spawn_blocking` and never blocks the UI
- **Single writer**: each piece of state has exactly one writer; asynchronous callbacks (measure, watcher, streaming events) prove they still belong to the current state and drop stale results
- **Vault watcher**: a plain FSEvents-based watcher with a hand-rolled debouncer emits `vault-changed` after 300 ms of silence, avoiding a full-tree scan on startup
- **Viewport-only work**: live preview walks only the visible syntax tree; performance-sensitive paths are guarded by [`src/editor/perf.gate.test.ts`](src/editor/perf.gate.test.ts) and [`src/code/perf.gate.test.ts`](src/code/perf.gate.test.ts)
- **Native capabilities stay in Rust**: file I/O, the web preview (a native child webview), and translation/model requests all originate in Rust; API keys never enter a page context

## Development and quality gates

- **Frontend**: `pnpm dev` starts Vite; `pnpm tauri dev` starts the full app. `pnpm gate` = `eslint` + `tsc --noEmit` + `prettier --check` + `vitest`, and is the definition of "done"
- **Real backend in a browser**: with `pnpm tauri dev` running, `http://localhost:1430/` is the real app (devbridge supplies Tauri IPC, a real vault, a real file tree, and real watcher events)
- **Pure frontend harness**: `http://localhost:1430/harness.html` mounts the editor with every extension plus an in-memory fake vault for deterministic DOM assertions and geometry measurements
- **Design constraints and debugging protocol**: see [`AGENTS.md`](AGENTS.md) and [`DEBUG.md`](DEBUG.md)

## Roadmap

- Multiple tabs
- Full-text search across the vault
- Knowledge graph / graph view
- More complete vimrc support: `<leader>` prefixes and more `:set` options

## License and acknowledgements

Released under the [MIT License](LICENSE).

The embedded dictionary is derived from [ECDICT](https://github.com/skywind3000/ECDICT) (MIT); the source commit and build parameters are recorded in `src-tauri/resources/ecdict_common.json`. Thanks also to [Tauri](https://tauri.app/), [CodeMirror](https://codemirror.net/), [KaTeX](https://katex.org/), [pdf.js](https://mozilla.github.io/pdf.js/), [Excalidraw](https://excalidraw.com/), and [xterm.js](https://xtermjs.org/).

<p align="center">
  <img src="./app-icon.png" width="104" alt="bnote app icon" />
</p>

<h1 align="center">bnote</h1>

<p align="center">
  A local-first Markdown notes app built with <strong>Tauri 2 + CodeMirror 6</strong>.<br />
  Your files stay on disk. The editing experience targets Obsidian-class speed, with core features built in instead of shipped as plugins.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">简体中文</a>
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="CodeMirror 6" src="https://img.shields.io/badge/CodeMirror-6-B873F6?style=flat-square" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111111" />
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/Baike12/bnote?style=flat-square&logo=github" />
  <img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/Baike12/bnote?style=flat-square" />
</p>

> bnote is a macOS-first, local-first Markdown notes app. Live preview, KaTeX math, LaTeX snippets, Vim, automatic input-source switching, daily-note todo sync, Excalidraw drawing, study mode, and Python execution are all built in. A vault is still a normal folder, and every note is still plain Markdown.

## Highlights

| Capability | Description |
| --- | --- |
| **Local first** | A vault is an ordinary folder on disk. Notes work with Git, iCloud, Dropbox, or any editor. |
| **Live preview** | The cursor line stays as source while the rest renders in an Obsidian-like style. Only the visible syntax tree is processed, so long notes stay fast. |
| **Math and snippets** | KaTeX inline/block math plus LaTeX snippets with automatic expansion, placeholder mirrors, regex captures, visual wrapping, and vault-level customization. |
| **Vim and IME** | Native Vim mode and vimrc mappings. On macOS, the input source can follow insert/normal mode, while math and code can stay in English. |
| **Daily notes and todos** | Two-way todo sync with today's daily note, plus a "Today's footprints" digest of non-todo edits across the vault. |
| **Drawing and media** | Lazy-loaded images; Excalidraw scenes are stored as files and embedded back into notes as previews with an editable source. |
| **Study mode** | A three-column workspace for Agent chat, PDF/web content, and notes. Includes PDF-to-Markdown conversion, MCP tools, and custom skill directories. |
| **Python workflow** | Run all Python fences in a note as one `.py` file, with streaming output, cancellation, ty diagnostics, and uv environments. |
| **Fast navigation** | Command palette, quick switcher, wikilink completion and backlinks, quick add, recent vaults, and fully customizable shortcuts. |

## Features

### Live Preview

The cursor line remains editable source; the rest of the document renders in place.

- Headings, bold, italic, strikethrough, blockquotes, callouts, horizontal rules, lists, escapes, inline code, and fenced code blocks
- Syntax highlighting for code blocks, with language packs loaded on demand
- Inline `$...$` and block `$$...$$` math rendered with KaTeX; editing shows the source plus a live preview below
- Clickable task lists that add `✅ date` when completed and remove it when unchecked
- Clickable `[[target|alias]]` wikilinks and external `[text](url)` links
- `![alt](path)` and `![[image.png]]` embeds, resolved by relative path, vault root, and filename, then lazy-loaded in the viewport
- Excalidraw `.excalidraw` / `.excalidraw.md` embeds render as their exported PNG and reopen the canvas when clicked
- Per-note cursor and scroll restoration

The renderer lives in [`src/editor/livePreview.ts`](src/editor/livePreview.ts) and processes only the visible syntax tree, with a KaTeX HTML cache.

### Math and LaTeX Snippets

- 200+ built-in snippets with `Tab` expansion, automatic expansion, placeholder mirrors, regex captures, visual wrapping, and context-aware behavior in prose, math, and code
- LaTeX Suite behaviors including automatic bracket enlargement, matrix shortcuts, tabout, paired-bracket colors, dollar deletion, and whitespace cleanup
- A vault-level `.bnote/snippets.js` completely replaces the built-in set and hot-reloads on save; load failures are surfaced in the UI
- Every LaTeX Suite behavior can be toggled in Settings without restarting the app

### Vim and Input Methods

- Normal, insert, and visual modes with `map`, `noremap`, `nnoremap`, `imap`, `vmap`, and key sequences such as `jj`
- `:w`, `:wq`, `:x`, `:q`, and `:noh` work out of the box; `:Bnote <command-id>` maps any bnote command to a Vim key
- `o` / `O` preserve indentation; visual mode, jump lists, clipboard integration, and pixel-stable vertical motion are adapted for the editor
- On macOS, configure separate input sources for insert and normal mode under `Settings → Input Method`
- Opening the quick switcher can switch to English automatically and restore the previous input source when the window loses focus; switching uses Carbon TIS without spawning a process

### Editing and Navigation

- **Command palette**: fuzzy-search every command; a new feature only needs to register a `CommandDef`
- **Quick switcher**: search by filename or folder name, with space-separated terms treated as AND; empty input shows recent files
- **Link completion**: insert a wikilink at the cursor. If the current line already has one, the same shortcut jumps to that note instead. Duplicate filenames are written as vault-relative paths
- **Link history**: walk backward through internal-link jumps without affecting ordinary file opens
- **Quick add**: define "name + destination folder" commands and create notes in one action; nested folders and duplicate names are handled automatically
- **Heading tools**: `Cmd+J` cycles prose → H1 → H2 → H3 → H4 → prose; `Cmd+1..6` set a level directly, with optional `1 / 1.1 / 1.1.2` numbering
- **Shortcut customization**: search, filter, capture, unbind, and reset bindings. Conflicts remove the old binding automatically, and one command can have multiple keys
- **File management**: lazy folder loading, create, rename, delete, context menus, and recent-vault switching
- **Writing comfort**: typewriter mode, editor font-size control, and autosave after typing stops

### Daily Notes, Todos, and Today's Footprints

- Send any todo line to today's daily note (default: `Daily/YYYY-MM-DD.md`; folders and files are created on demand)
- Keep both sides in sync afterward: completion state and nested todo changes are mirrored in both directions. Existing matching entries in the daily note are adopted instead of duplicated
- Checking an unsent todo can record it automatically; unchecking it removes the daily-note copy
- A "Today's footprints" section at the end of the daily note groups non-todo edits by source file and links back to the original location
- Todo mappings live in `.bnote/daily-links.json`; footprint baselines live in `.bnote/daily-footprints.json`, so both survive restarts

### Drawing and Media

- Open an Excalidraw canvas from the command palette; the canvas owns its own keyboard interaction and is saved and finalized before switching files
- New drawings are stored as `<name>.excalidraw` and exported to a same-name PNG for Markdown preview
- Compatible with Obsidian Excalidraw `.excalidraw.md` files, including `compressed-json`
- Click a drawing preview to keep editing; when you return to the source note, a new drawing is inserted as `![[...]]` at the original cursor position
- Images, PDFs, and other media are indexed so Markdown references can resolve them

### Study Mode and Agent

- Three panes: chat with an Agent, read PDF / Markdown / web content, and edit notes. Pane widths are draggable and persisted
- Drop in a PDF to convert it into Markdown and figure assets under the vault's `pdfs/` directory
- Web pages open in a native child WebView that follows the center pane's bounds
- The Agent supports Anthropic and OpenAI-compatible providers, including OpenAI, DeepSeek, Grok, and Ollama
- MCP servers and extra skill directories are configurable; tool calls and streamed responses appear directly in the chat panel

### Python

- All Python fences in a note are aligned by line number and combined into one virtual `.py` file
- `Cmd+Enter` runs the note; output streams into a bottom panel with clear, stop, exit-code, and duration controls
- `ty` integration provides completion, hover, and diagnostics while preserving the Markdown line mapping
- Create or sync a `uv` environment for the current project, with logs shown in the same run panel

## Default Shortcuts

> These are the macOS defaults. Every command can be rebound or unbound under `Settings → Hotkeys`; the Settings UI is the source of truth when a conflict exists.

### Workspace

| Shortcut | Action |
| --- | --- |
| `Cmd+P` | Command palette |
| `Cmd+N` / `Cmd+S` | New / save note |
| `Cmd+Shift+A` | Quick add |
| `Cmd+Shift+O` | Open today's daily note; press again inside it to jump back |
| `Cmd+Shift+R` | Switch to a recent vault |
| `Cmd+,` | Open Settings |
| `Cmd+Shift+S` | Enter / leave study mode |
| `Cmd+Enter` | Run Python blocks in the current note |

### Navigation

| Shortcut | Action |
| --- | --- |
| `Cmd+[` | Go back to the previous link destination |
| `Cmd+\\` | Collapse / expand the sidebar and focus the current file when expanding |
| `Cmd+I` | Focus the sidebar |
| `Cmd+T` | Jump to the note's header todos / return to the previous position |
| `Cmd+O` | Quick switcher (if a custom binding takes this key, change it in Settings) |

### Editing

| Shortcut | Action |
| --- | --- |
| `Cmd+M` / `Cmd+Shift+M` | Insert block / inline math |
| `Cmd+Shift+C` / `` Cmd+` `` | Insert code block / inline code |
| `Cmd+Shift+B` | Insert callout |
| `Cmd+Shift+H` | Insert horizontal rule |
| `Cmd+K` | Insert wikilink; jump when the current line already has one |
| `Cmd+B` / `Cmd+Shift+I` / `Cmd+Shift+D` | Bold / italic / strikethrough |
| `Cmd+J` | Cycle heading level |
| `Cmd+1..6` | Set heading level N |
| `Cmd+L` | Toggle todo |
| `Cmd+Shift+J` | Send the current todo to today's daily note and keep it in sync |
| `Cmd+;` / `Cmd+Shift+;` | Toggle bulleted / numbered list |
| `Cmd+E` | Toggle live preview |
| `Cmd+Shift+V` / `Cmd+Shift+T` / `Cmd+Shift+L` | Toggle Vim / typewriter mode / LaTeX snippets |
| `Cmd+0` / `Cmd+-` / `Cmd+=` | Reset / decrease / increase editor font size |

## Quick Start

```bash
git clone https://github.com/Baike12/bnote.git
cd bnote
pnpm install
pnpm tauri dev
```

Choose a vault folder on first launch. Development starts Vite plus the Tauri app; browser debugging and the test harness are documented in [`AGENTS.md`](AGENTS.md).

### Requirements

- macOS
- Node.js 20+
- pnpm
- Rust stable
- Xcode Command Line Tools

### Build

```bash
pnpm tauri build
```

Tauri produces the `.app` / `.dmg` bundles.

## Configuration and Data

| File | Location | Purpose |
| --- | --- | --- |
| `config.json` | `~/Library/Application Support/com.bnote.app/` | Recent vaults, last file, settings, cursor positions |
| `keybindings.json` | `~/Library/Application Support/com.bnote.app/` | Global shortcut overrides |
| `vimrc` | `~/Library/Application Support/com.bnote.app/` | Global Vim mappings |
| `.bnote/vimrc` | Inside the vault | Vault-level Vim mappings |
| `.bnote/snippets.js` | Inside the vault | Vault-level LaTeX snippets; replaces the built-in set |
| `.bnote/keybindings.json` | Inside the vault | Vault-level shortcut overrides |
| `.bnote/daily-links.json` | Inside the vault | Cross-file todo mappings |
| `.bnote/daily-footprints.json` | Inside the vault | Today's-footprints baseline |
| `.bnote/skills/` | Inside the vault | Vault-level Agent skills for study mode |

## Architecture

```text
src/                        Frontend: React 19 + CodeMirror 6 + Zustand
  editor/                   Live preview, math scan, LaTeX snippets, Vim, typewriter
  commands/                 Command registry, built-ins, shortcuts, and key sequences
  components/               Sidebar, quick switcher, settings, canvas, study mode, and more
  daily/                    Todo model, sync engine, and daily-note opening
  footprint/                Today's-footprints diff, storage, rendering, and widget
  python/                   Python extraction, run panel, and LSP client
  state/appStore.ts         Settings, open files, vault tree, and app state

src-tauri/                 Rust backend
  src/commands/             Vault, files, config, Python, Agent, and input-source commands
  src/agent/                Providers, MCP, skills, sessions, and tool loop
  src/python/               Python runner, ty LSP, and uv environments
  src/state.rs              Vault watcher and frontend events
```

Performance choices:

- The file tree loads one directory at a time and calls `read_dir` only when expanded
- The quick switcher uses a separate flat index instead of walking the tree
- File operations run through `spawn_blocking` so the UI thread stays free
- The native filesystem watcher uses a 300 ms debounce
- Live preview only decorates the visible range and caches KaTeX HTML
- Performance-sensitive paths are guarded by [`src/editor/perf.gate.test.ts`](src/editor/perf.gate.test.ts)

## Development and Testing

```bash
pnpm dev             # Start Vite only
pnpm tauri dev       # Start the full desktop app
pnpm gate            # lint + typecheck + unit tests
cargo check --manifest-path src-tauri/Cargo.toml
```

Frontend tests use Vitest. Geometry and feel-related changes also need DOM assertions and real pixel measurements in the browser harness; unit tests alone are not sufficient.

## Roadmap

- Multiple tabs
- Vault-wide full-text search
- Knowledge graph / graph view
- Fuller vimrc support: `<leader>` prefixes and more `:set` options

## License

This repository does not currently include a License file. All rights are reserved unless a license is added later.

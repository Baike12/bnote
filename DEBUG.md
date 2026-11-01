# DEBUG.md — debugging and verification protocol

This is a subordinate document of [AGENTS.md](./AGENTS.md). It defines the **default** protocol for changing front-end behavior, measuring performance, and reproducing bugs. Read it before you start.

After a front-end change, **do not build and do not deploy** — that decision belongs to the user (historically: "debug only, do not build"). Verify in the browser without stealing focus or touching the user's mouse and keyboard. Full-screen screenshots and computer-use are forbidden; they take over the user's desktop.

Drive verification with **browseros**: keep one tab group per task and pass the session handle on every call. Never start playwright-cli or another browser tool. Screenshots occasionally contain stitching artifacts, so treat them as reference only — **DOM assertions and bytes on disk are the source of truth**. Close the tabs you opened; stop the dev server if this session started it.

## Two loops

### 1. Real backend (preferred)

With `pnpm tauri dev` running, `http://localhost:1430/` is the real app: the Tauri window loads the same build (`devUrl`). The missing `window.__TAURI_INTERNALS__` is provided by `src/dev/browserMode.ts` using the official `@tauri-apps/api/mocks`, and IPC goes to `src-tauri/src/devbridge.rs` on `127.0.0.1:1439`. You get the real vault, the real file tree, real images (`/__dev/asset` stands in for `asset://`), and the real watcher (backend events are pushed to the tab over SSE).

- **The real vault is `/Users/baike3/Documents/baike`**: the user's actual notes (daily notes in `Daily/YYYY-MM-DD.md`, sync map in `.bnote/daily-links.json`). For bugs of the form "this feature corrupted a file", read those files directly — disk bytes beat screen symptoms, and a `diff` separates "written by this operation" from "already there".
- **The reference implementation for LaTeX shortcuts is the Obsidian plugin source**: `/Users/baike3/Documents/baike/.obsidian/plugins/obsidian-vim-input-auto-switch/`. The directory name does not match its contents; the manifest id is `obsidian-latex-suite` (v1.9.4, a modified build that also switches the IME for vim). `main.js` is a bundle but keeps most variable names — check it before changing any semantics under `src/editor/snippets/`. The user's live snippet config is `data.json` in that directory (`snippets`, 214 entries); the repo-level `.bnote/snippets.js` is its port.
- **Formula snippets actually come from the vault**: `/Users/baike3/Documents/baike/.bnote/snippets.js` (214 entries). When that file exists it **replaces** the built-in set (`src/editor/snippets/default-snippets.ts`) entirely; it does not merge. Edit it directly — it hot-reloads on save, and the field semantics are documented in its header.
- **There is only one backend implementation**: `devbridge.rs::dispatch` forwards `{cmd,args}` to the same `#[tauri::command]`. To add a command, add a match arm there; never write a second implementation on the JS side.
- **Never put `/__dev` in Vite's `server.proxy`**: the proxy buffers responses of unknown length, so SSE forwards zero bytes (measured: 0 bytes through 1430).
- **Not available in the browser**: native sub-webviews (the `study_preview` commands and `open_study_url` return `BROWSER_MODE`; the creative-preview commands are absent and return `UNKNOWN_COMMAND`) and the `plugin:*` commands (dialog/opener/clipboard). These can only be verified at the logic layer; **platform behavior requires a deployed check, and the summary must say so**. The three IME commands have devbridge stubs (`list_input_sources` returns `[]`, `set_input_source` returns immediately), so the call chain works but TIS never runs — main-thread cost of mode switching **cannot** be measured in the browser; read the measurements in `src-tauri/src/commands/ime.rs` (`cargo test --lib probe_switch_sources -- --nocapture`).
- Editing in the browser writes to the real vault and shares files with the user's window — **only one side may write at a time**.

### 2. Harness (pure front end, fake data)

`http://localhost:1430/harness.html` needs no Tauri. It mounts the editor with all real extensions plus an in-memory fake vault, so assertions are deterministic. Hooks: `__view`, `__loadDoc(text)`, `__loadFileDoc(text, path?)`, `__setCursor(line, col)`/`__cursor()`, `__store`/`__api`/`__actions`, `__mountSidebar(entries)`/`__unmountSidebar()` (a real unmount — required for remount scenarios), `__mountStudyLayout()`. Add new hooks in `src/dev/harness.ts`, copying the existing pattern.

Before starting a dev server, probe 1430: if `harness.html` returns 200, reuse it and do not start a second server (`strictPort: true`; a busy port makes `pnpm dev` exit). HMR is automatic; no restart is needed.

## Traps you will hit

- `evaluate()`'s sandbox does not support dynamic `import`: to test any TS module, inject a module script that loads the real source through Vite, attach the result to `window`, then read it back.
- CodeMirror renders only the viewport, so in a long document `querySelectorAll(".cw-image")` returns 0. Live preview also replaces image source with a widget only when the caret is **not** on that line — move the caret below the target line before measuring.
- An image's `naturalWidth` is lazy and decoded asynchronously; wait about 1s before reading it, or you get 0.
- Icon assets must be rasterized with the browser's canvas (`toDataURL` to a file); `qlmanage -t -s N` paints an **opaque white background** and is only good for eyeballing composition. Measure icon pixels with Python PIL, never by eye.
- **The harness's vim only goes as far as `reconfigureVim(view, true, [])`**: `settings.vim` in the store stays at its default `false`, so the cursor-flush listener in `setup.ts` that self-gates on `settings.vim` returns early — measuring vim costs without calling `__setVim(true)` measures data with the forced reflow missing (the first measurement in 2026-09 hit exactly this). Likewise `__vimKeys`/`__typeChar` bypass the engine's own input handler: sending several keys in one task, or `__typeChar` immediately followed by `<Esc>`, desynchronizes the engine's accounting (the first Esc is swallowed, `A` does not move the caret); one key per rAF task is the only trustworthy protocol.
- **Mounting starts in normal mode** (`__vimMode()` = `"normal"`): keys that go through the real keydown path are interpreted by the engine first — Enter is `j` (move down, no newline). Call `__setVim(false)` before testing typing/Enter workflows (afterwards `__vimMode()` is null), and do it on a **freshly reloaded page** (a page mutated by earlier experiments breaks: `__setCursor` throws `Cannot read properties of undefined`).

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { codeApi, termApi, type TermExitEvent } from "./api";
import { ancestorDirs } from "./tree";
import { disposeAllTerminals, disposeTerminal, ensureTerminalOutputListener } from "./term/session";
import { closeTab as closeTermTab, nextTitle, type TermTab } from "./term/tabs";
import { useAppStore } from "@/state/appStore";
import type {
  CodeFile,
  CodeProjectInfo,
  GitStatus,
  LspDiagnostic,
  LspPosition,
  ServerConfig,
} from "./types";

/**
 * State of the code project.
 *
 * **Single writer**: every change goes through an action of this store and
 * components only read. That keeps "file tree / tabs / editor content / git
 * status" from each holding a copy, which would allow a split state where the
 * tree changed but the editor did not.
 *
 * The buffers (tabs + contents) live here, not in CodeMirror: the CodeMirror
 * instance comes and goes with the component, so state cannot live there (the
 * content would be gone after switching away and back).
 */

export interface OpenFile {
  path: string;
  /** Content as opened (used to compute "is it modified"). */
  saved: string;
  /** Current content (differs from `saved` while there are unsaved changes). */
  content: string;
  languageId: string;
  binary: boolean;
  size: number;
  /**
   * Indentation unit (guessed once from the content on open, then fixed):
   * `"  "` / `"\t"` and the like.
   *
   * Guessing again after opening would chain "content changes → indent
   * changes → editor rebuilt → undo stack gone"; guessing once and pinning it
   * is more stable.
   */
  indentUnit: string;
  /** Display width of a tab (the indent width for space indentation, tabs count as 4). */
  tabSize: number;
}

export interface CodeState {
  /** The currently open project (null = no project open). */
  project: CodeProjectInfo | null;
  /** Open tabs (project-relative paths). */
  tabs: string[];
  /** The current tab. */
  activePath: string | null;
  /** Path → open file. */
  files: Record<string, OpenFile>;
  /** Path → diagnostics. */
  diagnostics: Record<string, LspDiagnostic[]>;
  /** Git status. */
  git: GitStatus | null;
  /** Language → "running". */
  lspStates: Record<string, string>;
  /** Language server log (the most recent entries). */
  lspLog: { language: string; level: number; message: string }[];
  /** Whether the file tree drawer is open. */
  treeOpen: boolean;
  /**
   * The set of expanded directory paths in the file tree. **An empty set
   * means top level only** (no folder is expanded by default); it survives
   * closing and reopening the drawer and a rescan, and is only cleared when
   * the project changes.
   */
  expandedDirs: Set<string>;
  /**
   * A "hand the focus to the file tree" request (a null path means the first
   * row).
   *
   * A request instead of the command layer touching the DOM directly: the
   * drawer may not be mounted yet, and the file tree is virtual-scrolled — the
   * target row has to be expanded and scrolled into the window before there is
   * an element to focus. FileTree clears it after consuming it once, so
   * closing and reopening the drawer does not steal focus again.
   */
  treeFocus: { path: string | null; seq: number } | null;
  /** Whether the problems panel is open. */
  problemsOpen: boolean;
  /** The file whose diff is being viewed (null = none). */
  diffPath: string | null;
  /** Whether the diff view shows the staged side. */
  diffStaged: boolean;
  /**
   * A pending jump request: target file + target position (LSP coordinates).
   *
   * LSP coordinates rather than a document offset: the target file may not be
   * open yet, so its document offset does not exist at this point. The editor
   * converts the coordinates into an offset before placing the caret.
   */
  jump: { path: string; position: LspPosition } | null;
  /** The reference list (the result of a "jump to references" query). */
  references:
    | {
        path: string;
        position: LspPosition;
        external: boolean;
      }[]
    | null;
  /** Whether the terminal drawer (bottom of the code pane) is open. */
  termOpen: boolean;
  /** One tab per live shell; the PTY itself lives in Rust. */
  terminals: TermTab[];
  /** The tab whose emulator is mounted in the drawer body. */
  activeTermId: number | null;

  openProject: (root: string) => Promise<void>;
  closeProject: () => Promise<void>;
  rescan: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  refreshGit: () => Promise<void>;
  setDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void;
  setLspState: (language: string, state: string) => void;
  appendLspLog: (language: string, level: number, message: string) => void;
  ensureLsp: (language: string, path: string, overrides?: ServerConfig) => Promise<boolean>;
  setTreeOpen: (open: boolean) => void;
  /** Toggle the expanded state of a directory. */
  toggleDir: (path: string) => void;
  /** Ask for the focus to move to the file tree (null = the first row). */
  requestTreeFocus: (path: string | null) => void;
  /** Consume the focus request (exactly once). */
  clearTreeFocus: () => void;
  /** Expand to a file: open every one of its ancestor directories. */
  expandTo: (path: string) => void;
  setProblemsOpen: (open: boolean) => void;
  setDiff: (path: string | null, staged?: boolean) => void;
  toggleDiffStaged: () => void;
  /** Ask for the caret to land on a position (jump / click in the references panel). */
  requestJump: (path: string, position: LspPosition) => void;
  /** Consume the jump request (exactly once). */
  clearJump: () => void;
  /** Set the reference list. */
  setReferences: (
    refs: { path: string; position: LspPosition; external: boolean }[] | null,
  ) => void;
  /** Replace the file content directly (re-read from disk after a rename). */
  replaceContent: (path: string, content: string) => void;
  /**
   * Open the drawer, spawning a shell when it has no live tab left.
   *
   * One action for the shortcut and the toolbar button: "show the terminal"
   * and "give me a shell" are the same request from the user's side.
   */
  openTerminal: () => Promise<void>;
  /** Spawn an additional shell and make it the active tab (the `+`). */
  spawnTerminal: () => Promise<void>;
  /** Kill one shell and drop its tab (the panel closes when the last one goes). */
  closeTerminal: (id: number) => Promise<void>;
  setActiveTerminal: (id: number) => void;
  setTermOpen: (open: boolean) => void;
  /** The shell process ended on its own (`term-exit`). */
  markTermExited: (id: number) => void;
  /** Replace the active shell with a fresh one at the project root. */
  restartTerminal: () => Promise<void>;
}

/** How many language server log entries to keep (so a long session cannot eat all the memory). */
const LOG_LIMIT = 200;

/** How many columns a tab occupies (the tabSize when the indent unit is "\t"). */
const TAB_DISPLAY_WIDTH = 4;

/**
 * Request sequence number of `openFile`: when two files are clicked in a row,
 * only the last one counts.
 *
 * Module-level rather than state: it does not drive rendering, it is only a
 * gate that discards a stale disk read.
 */
let openSeq = 0;

/**
 * Sequence number of the file tree focus request. Pressing the shortcut again
 * for the same path has to relocate it (the user may have moved the focus
 * away), so every request increments the counter and consumers trigger on the
 * object/sequence number.
 */
let treeFocusSeq = 0;

/**
 * The `term-exit` subscription is app-wide, so it is installed once on the
 * first shell instead of per terminal tab.
 */
let termExitListening = false;

function ensureTermExitListener(): void {
  if (termExitListening) return;
  termExitListening = true;
  void listen<TermExitEvent>("term-exit", (event) => {
    useCodeStore.getState().markTermExited(event.payload.termId);
  }).catch((e) => {
    termExitListening = false;
    console.warn("[term] cannot subscribe to term-exit", e);
  });
}

/**
 * Kill every shell and drop the emulators: a shell is scoped to the project
 * root, so switching or closing the project ends them (the same rule as the
 * language servers).
 */
async function closeAllTerminals(): Promise<void> {
  disposeAllTerminals();
  await termApi.closeAll().catch((e) => console.warn("[term] close_all failed", e));
}

/**
 * Guess the indent unit from the content (the first indented line among the
 * first few lines).
 *
 * Returns **what actually gets written into the text**: a tab-indented file
 * returns `"\t"`, a space-indented file returns the matching number of
 * spaces. It feeds two places: `indentUnit` (what Enter / Tab really insert)
 * and `tabSize` (how wide one tab draws). A width without a unit would make
 * Enter insert 2 spaces in a 4-space project, mixing two indent styles in one
 * file.
 */
export function detectIndent(content: string): string {
  const lines = content.split("\n").slice(0, 200);
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (indent.length === 0) continue;
    if (indent.includes("\t")) return "\t"; // Tab indentation: one tab per level
    return " ".repeat(Math.min(indent.length, 8));
  }
  return "  ";
}

export const useCodeStore = create<CodeState>((set, get) => ({
  project: null,
  tabs: [],
  activePath: null,
  files: {},
  diagnostics: {},
  git: null,
  lspStates: {},
  lspLog: [],
  treeOpen: false,
  expandedDirs: new Set<string>(),
  treeFocus: null,
  problemsOpen: false,
  diffPath: null,
  diffStaged: false,
  jump: null,
  references: null,
  termOpen: false,
  terminals: [],
  activeTermId: null,

  async openProject(root) {
    const info = await codeApi.openProject(root);
    const previous = get().project;
    // Reopening the same project (picked the current project from the history
    // menu): swap in a fresh file tree and **leave the tabs and buffers
    // alone**. Taking the reset path below would throw away the unsaved
    // changes and the undo stacks with them.
    if (previous && previous.root === info.root) {
      set({ project: info });
      return;
    }
    // Switching project = switching the sandbox boundary. Language servers
    // started for the old project have to be stopped: they live by their root
    // path, and leaving them running is a set of orphan processes (each
    // holding its own file tree).
    if (previous) await codeApi.lspStop(previous.root).catch(() => {});
    // Shells are scoped to the project root for the same reason.
    if (previous) await closeAllTerminals();
    // The buffers are cleared together with the project: flush the modified
    // files to disk first, otherwise they are lost (the same discipline as
    // closing the project).
    for (const path of Object.keys(get().files)) {
      if (isDirty(get(), path)) await get().saveFile(path);
    }
    set({
      project: info,
      tabs: [],
      activePath: null,
      files: {},
      diagnostics: {},
      git: null,
      lspStates: {},
      lspLog: [],
      // Opening a project shows the file tree (it is where the work starts),
      // with no folder expanded: the top level only, so a deep repository does
      // not dump hundreds of rows the user has to scroll past.
      treeOpen: true,
      expandedDirs: new Set<string>(),
      treeFocus: null,
      problemsOpen: false,
      diffPath: null,
      diffStaged: false,
      jump: null,
      references: null,
      termOpen: false,
      terminals: [],
      activeTermId: null,
    });
    await get().refreshGit();
  },

  async closeProject() {
    // Flush every modified file to disk before closing the project (the
    // buffers are cleared together with the project).
    for (const path of Object.keys(get().files)) {
      if (isDirty(get(), path)) await get().saveFile(path);
    }
    const root = get().project?.root;
    if (root) {
      // Language servers are started per project: closing the project stops
      // them, leaving no orphan processes.
      await codeApi.lspStop(root).catch(() => {});
    }
    await closeAllTerminals();
    set({
      project: null,
      tabs: [],
      activePath: null,
      files: {},
      diagnostics: {},
      git: null,
      lspStates: {},
      lspLog: [],
      treeOpen: false,
      expandedDirs: new Set<string>(),
      treeFocus: null,
      problemsOpen: false,
      diffPath: null,
      jump: null,
      references: null,
      termOpen: false,
      terminals: [],
      activeTermId: null,
    });
  },

  async rescan() {
    const root = get().project?.root;
    if (!root) return;
    const tree = await codeApi.rescan(root);
    const project = get().project;
    if (!project) return;
    set({ project: { ...project, tree } });
    // Files created or deleted outside also change the git status (new
    // untracked, deleted), so refresh it while we are here.
    await get().refreshGit();
  },

  async openFile(path) {
    const root = get().project?.root;
    if (!root) return;
    const existing = get().files[path];
    if (existing) {
      // Already open: just switch to it, do not re-read from disk (that would
      // wipe the unsaved changes).
      set((s) => ({
        tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path],
        activePath: path,
      }));
      return;
    }
    // Two files clicked in a row race on the disk read: only the result of the
    // last request counts. Without the sequence check, the earlier read that
    // arrives a moment later would pull the caret back to the old file.
    const seq = ++openSeq;
    let file: CodeFile;
    try {
      file = await codeApi.readFile(root, path);
    } catch (e) {
      useAppStore.getState().showToast(`打开 ${path} 失败: ${String(e)}`);
      return;
    }
    if (seq !== openSeq) return;
    const indentUnit = detectIndent(file.content);
    set((s) => ({
      tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path],
      activePath: path,
      files: {
        ...s.files,
        [path]: {
          path,
          saved: file.content,
          content: file.content,
          languageId: file.languageId,
          binary: file.binary,
          size: file.size,
          indentUnit,
          tabSize: indentUnit === "\t" ? TAB_DISPLAY_WIDTH : indentUnit.length,
        },
      },
    }));
    // Once the language server is up, push the document to it so completion
    // and jumps work right away.
    if (!file.binary) void get().ensureLsp(file.languageId, file.path);
  },

  closeTab(path) {
    // Flush unsaved changes to disk first: the buffer disappears together
    // with the tab, so not saving loses them.
    if (isDirty(get(), path)) void get().saveFile(path);
    const root = get().project?.root;
    set((s) => {
      const tabs = s.tabs.filter((p) => p !== path);
      const files = { ...s.files };
      delete files[path];
      const activePath = s.activePath === path ? (tabs[tabs.length - 1] ?? null) : s.activePath;
      return { tabs, files, activePath };
    });
    // The document has to be closed on the server too: otherwise it keeps
    // pushing diagnostics for the closed file (a "ghost file" hanging in the
    // problems panel) and keeps holding that text.
    if (root) void codeApi.lspClose(root, path).catch(() => {});
  },

  setActiveTab(path) {
    if (get().activePath === path) return;
    set({ activePath: path, diffPath: null });
  },

  updateContent(path, content) {
    set((s) => {
      const file = s.files[path];
      if (!file || file.content === content) return s;
      return { files: { ...s.files, [path]: { ...file, content } } };
    });
  },

  async saveFile(path) {
    const root = get().project?.root;
    const file = get().files[path];
    if (!root || !file) return;
    // The content of a binary or oversized file was never read (the content is
    // an empty string). Writing it back would blank the whole file — better
    // to do nothing at all.
    if (file.binary) return;
    try {
      await codeApi.writeFile(root, path, file.content);
    } catch (e) {
      useAppStore.getState().showToast(`保存 ${path} 失败: ${String(e)}`);
      return;
    }
    set((s) => {
      const current = s.files[path];
      if (!current) return s;
      return { files: { ...s.files, [path]: { ...current, saved: current.content } } };
    });
    await get().refreshGit();
  },

  async refreshGit() {
    const root = get().project?.root;
    if (!root) return;
    try {
      const git = await codeApi.gitStatus(root);
      set({ git });
    } catch {
      set({ git: null });
    }
  },

  setDiagnostics(path, diagnostics) {
    set((s) => ({ diagnostics: { ...s.diagnostics, [path]: diagnostics } }));
  },

  setLspState(language, state) {
    set((s) => ({ lspStates: { ...s.lspStates, [language]: state } }));
  },

  appendLspLog(language, level, message) {
    set((s) => ({
      lspLog: [...s.lspLog, { language, level, message }].slice(-LOG_LIMIT),
    }));
  },

  async ensureLsp(language, path, overrides) {
    const root = get().project?.root;
    if (!root || !language || language === "plaintext") return false;
    // No "already running" shortcut: with one server per workspace (Python:
    // per subproject) `path` decides which instance this file needs, and the
    // backend's `ensure` returns the live one without spawning anything. The
    // front end does not know the workspace rule, so it must not decide here.
    //
    // A server that failed to start once (not installed on this machine) is
    // not retried: every file open would spawn a process and wait out a
    // handshake timeout, which feels terrible. To retry, reopen the project
    // (or fix the server path in the settings and reopen it).
    if (get().lspStates[language] === "off") return false;
    // Where the override comes from: an explicit one from the caller wins,
    // otherwise the global layer from the settings (a project-local
    // `.bnote/lsp.json` overrides that again on the backend, with the
    // highest priority).
    const global = useAppStore.getState().settings.codeLspServers?.[language];
    const override =
      overrides ?? (global ? { command: global.command, args: global.args ?? [] } : undefined);
    try {
      await codeApi.lspStart(root, language, path, override);
      get().setLspState(language, "running");
      // Files already in the editor need a didOpen to make the server aware of
      // the document. The backend routes each one to the server of its own
      // workspace and drops the ones that belong elsewhere (they get their
      // didOpen when their own workspace starts).
      const s = get();
      for (const file of Object.values(s.files)) {
        if (file.languageId === language) {
          await codeApi.lspSync(root, file.path, file.content).catch(() => {});
        }
      }
      return true;
    } catch {
      get().setLspState(language, "off");
      return false;
    }
  },

  setTreeOpen(open) {
    set({ treeOpen: open });
  },

  toggleDir(path) {
    set((s) => {
      const next = new Set(s.expandedDirs);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedDirs: next };
    });
  },

  requestTreeFocus(path) {
    treeFocusSeq += 1;
    set({ treeFocus: { path, seq: treeFocusSeq } });
  },

  clearTreeFocus() {
    set({ treeFocus: null });
  },

  expandTo(path) {
    const dirs = ancestorDirs(path);
    if (dirs.length === 0) return;
    set((s) => {
      const next = new Set(s.expandedDirs);
      let changed = false;
      for (const dir of dirs) {
        if (!next.has(dir)) {
          next.add(dir);
          changed = true;
        }
      }
      return changed ? { expandedDirs: next } : s;
    });
  },

  setProblemsOpen(open) {
    set({ problemsOpen: open });
  },

  setDiff(path, staged) {
    set((s) => ({
      diffPath: path,
      diffStaged: staged ?? s.diffStaged,
    }));
  },

  toggleDiffStaged() {
    set((s) => ({ diffStaged: !s.diffStaged }));
  },

  requestJump(path, position) {
    set({ jump: { path, position } });
  },

  clearJump() {
    set({ jump: null });
  },

  setReferences(refs) {
    set({ references: refs });
  },

  replaceContent(path, content) {
    set((s) => {
      const file = s.files[path];
      if (!file) return s;
      return {
        files: { ...s.files, [path]: { ...file, content, saved: content } },
      };
    });
  },

  async openTerminal() {
    const { project, terminals, activeTermId } = get();
    if (!project) return;
    // A live shell exists: "open the terminal" only reveals the drawer, it
    // does not spawn another one.
    const live = terminals.find((tab) => !tab.exited);
    if (live) {
      set({
        termOpen: true,
        activeTermId: terminals.some((tab) => tab.id === activeTermId && !tab.exited)
          ? activeTermId
          : live.id,
      });
      return;
    }
    await get().spawnTerminal();
  },

  async spawnTerminal() {
    const { project } = get();
    if (!project) return;
    ensureTermExitListener();
    // Subscribe before spawning: the shell prints its prompt immediately and a
    // listener installed after `term_open` would swallow it.
    await ensureTerminalOutputListener();
    // The initial grid is a guess; the drawer fits the real one right after
    // mounting and sends `term_resize`.
    const reply = await termApi.open(project.root, 80, 24).catch((e) => {
      useAppStore.getState().showToast(`打开终端失败: ${String(e)}`);
      return null;
    });
    if (!reply) return;
    set((s) => ({
      termOpen: true,
      terminals: [
        ...s.terminals,
        { id: reply.termId, title: nextTitle(s.terminals, reply.title), exited: false },
      ],
      activeTermId: reply.termId,
    }));
  },

  async closeTerminal(id) {
    const { terminals } = get();
    if (!terminals.some((tab) => tab.id === id)) return;
    const next = closeTermTab(terminals, get().activeTermId, id);
    set({
      terminals: next.tabs,
      activeTermId: next.activeId,
      // Closing the last shell closes the drawer: an empty drawer with no way
      // to get a shell back is a dead end (the toolbar button reopens it).
      ...(next.tabs.length === 0 ? { termOpen: false } : {}),
    });
    disposeTerminal(id);
    await termApi.close(id).catch((e) => console.warn("[term] close failed", e));
  },

  setActiveTerminal(id) {
    set({ activeTermId: id, termOpen: true });
  },

  setTermOpen(open) {
    const { terminals, activeTermId } = get();
    if (open) {
      // Opening an empty drawer must produce a shell, not an empty box.
      if (terminals.length === 0) {
        void get().openTerminal();
        return;
      }
      set({ termOpen: true, activeTermId: activeTermId ?? terminals[0].id });
      return;
    }
    set({ termOpen: false });
  },

  markTermExited(id) {
    set((s) => ({
      terminals: s.terminals.map((tab) => (tab.id === id ? { ...tab, exited: true } : tab)),
    }));
  },

  async restartTerminal() {
    const { activeTermId, terminals } = get();
    const current = terminals.find((tab) => tab.id === activeTermId);
    if (current) await get().closeTerminal(current.id);
    await get().spawnTerminal();
  },
}));

/** Whether this file has unsaved changes. */
export function isDirty(state: CodeState, path: string): boolean {
  const file = state.files[path];
  return !!file && file.content !== file.saved;
}

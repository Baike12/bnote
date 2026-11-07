import { create } from "zustand";
import { api, type FileNode, type StudyContent, type VaultInfo } from "@/lib/tauri";
import {
  emptyStudyHistory,
  pushPdfEntry,
  pushUrlEntry,
  pushWereadBook,
  type StudyHistory,
  type StudyPdfEntry,
  type StudyUrlEntry,
  type WereadBookEntry,
} from "@/study/history";
import { DEFAULT_LATEX_CONFIG, type LatexConfig } from "@/editor/snippets/config";
import { DEFAULT_TYPEWRITER_POSITION } from "@/editor/typewriterPosition";
import { TREE_DEFAULT_WIDTH } from "@/code/treeWidth";
import { TERM_DEFAULT_HEIGHT } from "@/code/term/tabs";
import { DEFAULT_AGENT_WIDTH, DEFAULT_CONTENT_WIDTH } from "@/study/layoutModel";
import { DEFAULT_DAILY_WIDTH, DEFAULT_SIDE_WIDTH } from "@/projects/layoutModel";
import type { AgentImage } from "@/study/agentImages";
import type { TimerState as FocusTimerState } from "@/focus/timer";
import { DEFAULT_CODE_VIM, type CodeVimMode } from "./codeVim";

export interface ImeSettings {
  /** The master switch of the automatic input source switching (follows the vim mode + Chinese input fields; macOS only) */
  enabled: boolean;
  /** Switch to the insert input source automatically while a Chinese input field is focused (study assistant / PDF annotations) */
  chineseFields: boolean;
  /** The id of the input source used in insert mode */
  insertSource: string;
  /** The id of the input source used in normal / visual mode */
  normalSource: string;
  /** Keep the English input source when entering insert mode with the cursor inside a formula (formula content is ASCII) */
  mathKeepsEnglish: boolean;
  /** Keep the English input source when entering insert mode with the cursor inside a fenced code block (code is ASCII) */
  codeKeepsEnglish: boolean;
}

/** A quick-add command: create a new note in a given folder with one click (modelled on Obsidian QuickAdd). */
export interface QuickAddCommand {
  /** The command name, e.g. "add bnote file" */
  name: string;
  /** The target folder below the vault root, supports the "a/b" sub-path; it is created when missing */
  folder: string;
  /** The template file (vault-relative path, usually in the folder configured under "Settings → Templates"); empty = no template */
  template?: string;
}

/** Daily notes: for now only "which template does a new daily note use". */
export interface DailySettings {
  /** The template file (vault-relative path); empty = the default `# <date>` opening. */
  template: string;
}

/** The UI theme: dark is the default when no data-theme attribute is set; light goes through the [data-theme="light"]
 *  variable overrides (global.css is the single source of color). */
export type ThemeName = "dark" | "light";

export interface Settings {
  vim: boolean;
  /**
   * The vim switch of the code editor: "inherit" follows the notes `vim`,
   * "on" / "off" pin it. The two habits can differ, but the global switch is
   * the one the user thinks in, so following is the default.
   */
  codeVim: CodeVimMode;
  /**
   * Whether the code editor wraps lines.
   *
   * The middle column is that narrow (620px by default, only 430px with the
   * file tree expanded), and without wrapping long lines can only be read
   * by scrolling sideways. Wrapping is the default; files that must align by
   * column can turn it off temporarily (⌥Z).
   */
  codeWrap: boolean;
  /**
   * The width of the file tree (px). The editor takes the remaining width;
   * when the middle column narrows, the CSS clamp shrinks the display
   * without changing this preference. Drag the right edge of the file tree
   * to resize, double-click to reset.
   */
  codeTreeWidth: number;
  /**
   * The height of the terminal drawer at the bottom of the code pane (px).
   * The editor takes the rest; CSS clamps the display when the pane is short.
   * Drag the drawer's top edge to resize, double-click to reset.
   */
  codeTermHeight: number;
  /**
   * Global overrides for the language servers: languageId → launch command.
   *
   * The built-in defaults cover common languages such as ts / rust / go /
   * python; what is changed here is "which executable to use and with which
   * arguments". A project can put another layer in `.bnote/lsp.json` (it
   * follows the vault, so a team shares it).
   */
  codeLspServers: Record<string, { command: string; args?: string[] }>;
  typewriter: boolean;
  /** The vertical cursor position of typewriter mode (a ratio of the viewport height, 0.5 = vertically centered, 20%–80%). */
  typewriterPosition: number;
  livePreview: boolean;
  mathPreview: boolean;
  snippets: boolean;
  autoSave: boolean;
  /** Auto numbering of headings: when a heading is set, renumber by level as 1 / 1.1 / 1.1.2 */
  autoNumberHeadings: boolean;
  /** The language identifier prefilled by "insert code block"; an empty string = no language */
  codeBlockLang: string;
  /** The UI theme (the whole variable set: editor + sidebar + overlays + syntax highlighting) */
  theme: ThemeName;
  /**
   * The three columns of study mode: left "study assistant", middle
   * "content", right "notes". The assistant and content widths are fixed
   * pixel values and the notes column takes the remaining width — dragging
   * the window leaves the first two columns alone, so the PDF page size and
   * the visible content do not jitter with the window. When the window is
   * too narrow the CSS shrinks the display.
   * The legacy ratio form / three-column arrays are converted once by
   * normalizeContentWidth when loading.
   */
  studyAgentWidth: number;
  studyContentWidth: number;
  /**
   * The code mode columns: agent (left) and code project (middle), in pixels.
   * Same discipline as the study columns — the notes column takes the rest,
   * and CSS clamps the display when the window is narrow.
   */
  codeAgentWidth: number;
  codeContentWidth: number;
  /**
   * The three columns of the project view: left "project navigation", middle
   * "project board", right "journal". The navigation and journal widths are
   * pixel values and the board takes the remaining width — dragging the
   * window only changes the board, so the journal's wrap width and the
   * number of columns it fits do not jitter with the window. When the
   * window is too narrow the CSS clamp shrinks the display.
   */
  projectsSideWidth: number;
  projectsDailyWidth: number;
  /** The eye-care paper color of PDFs in study mode (a light green paper). */
  studyEyeCare: boolean;
  /** The ratio of the visible height scrolled per page turn in study mode (shared by PDF and web, 0.5 by default). */
  studyPageStep: number;
  /** The page zoom of the web preview in study mode (1 = 100%, 50%–300%). */
  studyWebZoom: number;
  /**
   * The composer's permission mode for agent tool calls:
   * `confirm` asks before every file change and shell command, `auto` runs
   * autonomously and only asks for a recognized dangerous command, `full`
   * never asks, `plan` is read-only research until the plan is approved.
   */
  agentPermissionMode: "confirm" | "auto" | "full" | "plan";
  /**
   * The conversation font scale of the study assistant (1 = 100%, 85%–160%).
   * The body baseline is 15px × this factor, and headings / code / tool
   * rows are derived with the same ratio; the "Aa" in the header adjusts
   * it and the readout is a percentage.
   */
  agentFontScale: number;
  /**
   * The master switch of select-to-translate in study mode. Once off, PDF
   * and web pages do not respond to a selection; once on, a single word is
   * only looked up in the built-in dictionary and two or more words call
   * the translation API.
   */
  studyTranslate: { enabled: boolean };
  fontSize: number;
  ime: ImeSettings;
  /** The LaTeX Suite feature switches (aligned with obsidian-latex-suite, see editor/snippets/config) */
  latex: LatexConfig;
  quickAdd: QuickAddCommand[];
  /**
   * The templates folder (vault-relative path). The files in it can be
   * picked as a template by the quick-add commands and by the daily note;
   * empty = not configured.
   */
  templatesDir: string;
  /** The daily note config (the initial content of a new daily note, etc.). */
  daily: DailySettings;
}

export const DEFAULT_SETTINGS: Settings = {
  vim: false,
  codeVim: DEFAULT_CODE_VIM,
  codeWrap: true,
  codeTreeWidth: TREE_DEFAULT_WIDTH,
  codeTermHeight: TERM_DEFAULT_HEIGHT,
  codeLspServers: {},
  typewriter: false,
  typewriterPosition: DEFAULT_TYPEWRITER_POSITION,
  livePreview: true,
  mathPreview: true,
  snippets: true,
  autoSave: true,
  autoNumberHeadings: false,
  codeBlockLang: "ts",
  theme: "dark",
  studyAgentWidth: DEFAULT_AGENT_WIDTH,
  studyContentWidth: DEFAULT_CONTENT_WIDTH,
  codeAgentWidth: DEFAULT_AGENT_WIDTH,
  codeContentWidth: DEFAULT_CONTENT_WIDTH,
  projectsSideWidth: DEFAULT_SIDE_WIDTH,
  projectsDailyWidth: DEFAULT_DAILY_WIDTH,
  studyEyeCare: false,
  studyPageStep: 0.5,
  studyWebZoom: 1,
  agentFontScale: 1,
  agentPermissionMode: "auto",
  studyTranslate: { enabled: false },
  fontSize: 16,
  ime: {
    enabled: true,
    chineseFields: true,
    insertSource: "com.sogou.inputmethod.sogou.pinyin",
    normalSource: "com.apple.keylayout.ABC",
    mathKeepsEnglish: true,
    codeKeepsEnglish: true,
  },
  latex: { ...DEFAULT_LATEX_CONFIG },
  quickAdd: [],
  templatesDir: "",
  daily: { template: "" },
};

export type ModalKind = "switcher" | "palette" | "settings" | "quickadd" | "quicktodo" | null;

/**
 * One canvas session: the canvas is a full-screen overlay and while it is
 * open the command keybindings only let through the quick switcher / command
 * palette (see the canvas mode in globalKeys). An isNew session inserts the
 * finished drawing as a plain image embed at originPos when returning to the
 * source note — the insert happens during the finalization, not when the
 * canvas is opened.
 */
export interface DrawingSession {
  /** The absolute path of the drawing file (the single truth on disk, the canvas writes it on every save). */
  path: string;
  /** A file created in this session: when nothing was drawn, the file is deleted during the finalization. */
  isNew: boolean;
  /** The source note (the current note at ⌘D); the target of the embed fill-back. */
  originNote: string | null;
  /** The cursor position at ⌘D; the insertion point of the fill-back. null when an existing drawing is edited. */
  originPos: number | null;
}

/** The anchor of the link suggest panel: the viewport coordinates of the cursor's line (the panel uses them directly with position: fixed). */
export interface LinkAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** One link hop: from → to. */
export interface LinkHop {
  from: string;
  to: string;
}

/**
 * The shape of the main area. Exactly one shape exists at a time: putting it in
 * the type makes "study mode and code mode at once" unrepresentable, which the
 * three separate booleans this replaces could not do.
 */
export type AppMode = "notes" | "study" | "code" | "projects";

/** The code project open in code mode (the repository is independent of the vault). */
export interface CodeProjectRef {
  path: string;
  title: string;
}

export interface PersistedConfig {
  lastVault?: string;
  /** The legacy single global value of "last file". Replaced by lastFileByVault, it is only read once as the seed of the startup migration. */
  lastFile?: string;
  /** The "last file" of each vault: the snapshot follows the vault, so switching away and back lands on that vault's own note (cf. zed's per-project restore). */
  lastFileByVault?: Record<string, string>;
  /** The most recently opened vaults (MRU, newest first). The switch target = the first non-current vault, see vault/recent.ts. */
  recentVaults?: string[];
  /** Recently-opened absolute note paths, most recent first (quick switcher). */
  recentFiles?: string[];
  settings?: Partial<Settings>;
  /** Last cursor position per absolute note path (remember-cursor-position). */
  cursorPositions?: Record<string, { pos: number; scroll: number }>;
  /** The PDFs / web pages opened in study mode (two separate lists, see study/history.ts). */
  studyHistory?: StudyHistory;
  /** The most recently opened code projects (MRU, newest first). */
  recentCodeProjects?: string[];
  /** The project restored on startup when code mode was the last active mode. */
  codeProject?: CodeProjectRef | null;
  /**
   * The size and position of the main window (logical pixels). Written by
   * `lib/windowState.ts` after a move/resize and restored by the Rust side
   * before the first frame on startup (see
   * commands/config.rs::restore_window_bounds).
   */
  window?: WindowState;
  /**
   * The timer state of the pomodoro. `endsAt` is an absolute timestamp, so
   * even after a restart it tells whether the stretch is over (see
   * focus/store.ts).
   */
  focusTimer?: FocusTimerState;
}

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** Hard cap on remembered files — dropping the oldest entry beyond it. */
const CURSOR_POSITIONS_CAP = 100;

/**
 * Records where the user left off in a note (cursor offset + scroll top) so
 * reopening it lands in the same spot. No-op (and no re-persist) when nothing
 * changed since the last record.
 */
export function rememberCursorPosition(path: string, pos: number, scroll: number) {
  const snap = getConfigSnapshot();
  const saved = snap.cursorPositions?.[path];
  if (saved && saved.pos === pos && saved.scroll === scroll) return;
  const map: NonNullable<PersistedConfig["cursorPositions"]> = {
    ...(snap.cursorPositions ?? {}),
    [path]: { pos, scroll },
  };
  const keys = Object.keys(map);
  if (keys.length > CURSOR_POSITIONS_CAP) {
    for (const key of keys.slice(0, keys.length - CURSOR_POSITIONS_CAP)) delete map[key];
  }
  persistConfig({ ...snap, cursorPositions: map });
}

/** The commands the study assistant panel can execute (signalled by the keybinding/command layer; the panel runs them itself). */
export type AgentPanelCommand =
  "new" | "fork" | "back" | "history" | "focus-input" | "attach-images" | "toggle-creative";
export interface AgentPanelCommandRequest {
  seq: number;
  kind: AgentPanelCommand;
  /** The image payload of attach-images (the reading region screenshot goes here, bypassing the system clipboard). */
  images?: AgentImage[];
}

interface AppState {
  vaultPath: string | null;
  vaultName: string;
  tree: FileNode[];
  /** Flat note paths across the vault (quick switcher / wikilinks). */
  flatFiles: string[];
  /** Flat media paths (images/PDFs), needed when the image rendering resolves by file name. */
  flatAssets: string[];
  /** Flat directory paths across the vault (folder picker suggestions). */
  folders: string[];
  /** Absolute paths of opened notes, most recent first. */
  recentFiles: string[];
  currentFile: string | null;
  dirty: boolean;
  settings: Settings;
  modal: ModalKind;
  sidebarOpen: boolean;
  /**
   * The pending "focus sidebar" request (null = none). The sidebar takes it
   * and the slot is cleared — it is a one-shot ticket, not a counter of "how
   * often it was pressed": a counter would be read as "a freshly arrived
   * request" by a newly mounted sidebar, so expanding the sidebar with ⌘\
   * would also steal the focus and throw away the editor the user is typing
   * in.
   */
  sidebarFocusRequest: number | null;
  /**
   * A row of the tree asks for an inline rename (rename right after creating
   * a folder). The sidebar takes it and the slot is cleared, so the request
   * is consumed only once and does not come back when the sidebar remounts.
   */
  renameRequest: string | null;
  /**
   * The anchor of the link suggest panel (the cursor's line of the link
   * insert). Also a one-shot request that is cleared when taken; the panel is
   * only mounted while it is non-empty — closing unmounts it and both the
   * query and the selection return to their initial state.
   */
  linkSuggest: LinkAnchor | null;
  /**
   * The link hop chain (each entry records one hop from → to) for "go back to
   * the file before the link jump". It is only pushed on a link jump; when a
   * file is opened in between, the back walk compares `to` with the current
   * file and knows the chain is broken (see popLinkBack).
   */
  linkBack: LinkHop[];
  /**
   * The ⌘⇧O jump-back slot: the file before the most recent "jump to today's
   * daily note". Pressing ⌘⇧O again inside the daily note consumes it and
   * jumps back; every new jump overwrites it (a single slot, the toggle
   * semantics have only one level). It is not mixed with linkBack — that
   * chain is the step-by-step back of wiki links, and the lazy invalidation
   * would give a toggle an outdated landing point.
   */
  dailyBackFrom: string | null;
  toast: string | null;
  /**
   * The shape of the main area (see `AppMode`): the note editor, the study
   * three columns, the code three columns, or the project board.
   */
  mode: AppMode;
  /** The code project that code mode shows (null = the project picker). Persisted with the config. */
  codeProject: CodeProjectRef | null;
  /**
   * Creative mode: which definition the agent panel runs (writing with tools and
   * an HTML preview) instead of plain study Q&A. Independent of `mode` — the
   * creative agent applies the next time the study layout is on screen.
   */
  creativeMode: boolean;
  /** The current content of the middle column in study mode (null = empty state, waiting for a dragged-in PDF or a URL) */
  studyContent: StudyContent | null;
  /** The most recently opened code projects (MRU, newest first). */
  recentCodeProjects: string[];
  /** The recent openings of study mode (PDF and web are separate). Restored from config.json on startup. */
  studyHistory: StudyHistory;
  /**
   * The book currently being read in WeChat Reading (pushed by the in-page
   * route event; null on the bookshelf / store pages).
   * studyContent holds only the entry URL in the middle column, and only the
   * page knows which book is being read — the study assistant's sessions and
   * annotations belong to "the book", not to the bookshelf.
   */
  studyWereadBook: { url: string; title: string } | null;
  /** The canvas session (null = not open). A full-screen overlay + the command keybindings are suspended. */
  drawingSession: DrawingSession | null;
  /**
   * The number of saves of the Agent config (model/Key/MCP). An open session
   * runs with the model config snapshot it started with; saving the config
   * **does not** rebuild the session — AgentPanel listens to this counter
   * only to re-read the "current config" (the footnote fallback and the
   * "session config ≠ current config" hint).
   */
  agentConfigVersion: number;
  /**
   * The request counter of "the study assistant switches session (main ↔
   * auxiliary)". The command/keybinding layer only writes this counter and
   * AgentPanel listens to it to perform the switch — the session list is
   * private panel state and does not enter the global store.
   */
  agentSwitchSessionSignal: number;
  /**
   * The command request of the study assistant panel (new / fork / back /
   * history / focus input). The command layer only writes this signal and
   * the panel runs it itself — the session and the input are private panel
   * state.
   */
  agentPanelCommand: AgentPanelCommandRequest | null;
  /**
   * Which column sits in the middle of the three-column layout: the content
   * column by default, the assistant column once the user works in it. The
   * swap is **sticky** — it follows explicit actions (a click inside a column
   * or a focus-region command), never "where the focus happens to be", so
   * switching to the notes column does not undo it. The page-turn command
   * scrolls the column that sits in the middle.
   */
  mainColumn: "agent" | "content";

  setVault: (info: VaultInfo) => void;
  closeVault: () => void;
  setTree: (tree: FileNode[]) => void;
  setFlatFiles: (files: string[]) => void;
  setFlatAssets: (assets: string[]) => void;
  setFolders: (folders: string[]) => void;
  openFile: (path: string) => void;
  closeFile: () => void;
  markDirty: (dirty: boolean) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  replaceSettings: (s: Settings) => void;
  setModal: (m: ModalKind) => void;
  toggleSidebar: () => void;
  focusSidebar: () => void;
  clearSidebarFocus: () => void;
  requestRename: (relPath: string) => void;
  clearRenameRequest: () => void;
  openLinkSuggest: (anchor: LinkAnchor) => void;
  closeLinkSuggest: () => void;
  pushLinkBack: (from: string, to: string) => void;
  /** Go back one level: returns the path to open; returns null when the chain is broken or the current file was the start. */
  popLinkBack: () => string | null;
  /** The writer of the ⌘⇧O jump-back slot (null = cleared). */
  setDailyBackFrom: (path: string | null) => void;
  showToast: (msg: string) => void;
  clearToast: () => void;
  /** The only writer of the main-area shape; entering a full-screen shape collapses the sidebar. */
  setMode: (mode: AppMode) => void;
  /** Command surface: leaves the target shape when it is already active, enters it otherwise. */
  toggleMode: (target: Exclude<AppMode, "notes">) => void;
  setCodeProject: (project: CodeProjectRef | null) => void;
  setCreativeMode: (active: boolean) => void;
  setStudyContent: (content: StudyContent | null) => void;
  /** The most recently opened code projects (MRU, newest first). */
  setRecentCodeProjects: (recentCodeProjects: string[]) => void;
  setStudyHistory: (history: StudyHistory) => void;
  setStudyWereadBook: (book: { url: string; title: string } | null) => void;
  /** Record an opened PDF (de-duplicated, moved to the top, persisted). */
  recordStudyPdf: (entry: Omit<StudyPdfEntry, "at">) => void;
  recordStudyUrl: (entry: Omit<StudyUrlEntry, "at">) => void;
  recordWereadBook: (entry: Omit<WereadBookEntry, "at">) => void;
  openDrawingSession: (session: DrawingSession) => void;
  closeDrawingSession: () => void;
  /** The Agent config was saved: let study mode re-read the current config (no session rebuild, see agentConfigVersion). */
  bumpAgentConfigVersion: () => void;
  /** The request of "the study assistant switches session (main ↔ auxiliary)" (see agentSwitchSessionSignal). */
  bumpAgentSwitchSessionSignal: () => void;
  /** The study assistant panel command (see agentPanelCommand). */
  runAgentPanelCommand: (kind: AgentPanelCommand, images?: AgentImage[]) => void;
  /** Put one column in the middle (see mainColumn). */
  setMainColumn: (column: "agent" | "content") => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced persistence of app config (vault, last file, settings). The
 * in-memory snapshot is kept identical to the latest write intent, so a later
 * partial save (e.g. a cursor-position update) never rolls back fields that
 * an earlier save had changed.
 */
export function persistConfig(config: PersistedConfig) {
  configSnapshot = config;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void api.saveAppConfig(configSnapshot).catch((e) => console.warn("persist failed", e));
  }, 300);
}

/** True while a debounced write is still pending (flush before quitting). */
export function hasPendingPersist() {
  return persistTimer !== null;
}

/** Writes the pending config to disk immediately (app close / blur). */
export function flushPersistConfig() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  void api.saveAppConfig(configSnapshot).catch((e) => console.warn("persist failed", e));
}

export const useAppStore = create<AppState>((set, get) => ({
  vaultPath: null,
  vaultName: "",
  tree: [],
  flatFiles: [],
  flatAssets: [],
  folders: [],
  recentFiles: [],
  currentFile: null,
  dirty: false,
  settings: { ...DEFAULT_SETTINGS },
  modal: null,
  sidebarOpen: true,
  sidebarFocusRequest: null,
  renameRequest: null,
  linkSuggest: null,
  linkBack: [],
  dailyBackFrom: null,
  toast: null,
  mode: "notes",
  codeProject: null,
  creativeMode: false,
  studyContent: null,
  recentCodeProjects: [],
  studyHistory: emptyStudyHistory(),
  studyWereadBook: null,
  drawingSession: null,
  agentConfigVersion: 0,
  agentSwitchSessionSignal: 0,
  agentPanelCommand: null,
  mainColumn: "content",

  setVault: (info) =>
    set({
      vaultPath: info.path,
      vaultName: info.name,
      tree: [],
      flatFiles: [],
      flatAssets: [],
      folders: [],
      currentFile: null,
      dirty: false,
      linkBack: [],
      dailyBackFrom: null,
    }),
  closeVault: () =>
    set({
      vaultPath: null,
      vaultName: "",
      tree: [],
      flatFiles: [],
      flatAssets: [],
      folders: [],
      currentFile: null,
      dirty: false,
      linkBack: [],
      dailyBackFrom: null,
    }),
  setTree: (tree) => set({ tree }),
  setFlatFiles: (flatFiles) => set({ flatFiles }),
  setFlatAssets: (flatAssets) => set({ flatAssets }),
  setFolders: (folders) => set({ folders }),
  openFile: (path) => {
    if (get().currentFile === path) return;
    // Most-recent-first list (quick switcher ordering); persisted in config.
    const recentFiles = [path, ...get().recentFiles.filter((p) => p !== path)].slice(0, 100);
    set({ currentFile: path, dirty: false, recentFiles });
    // The "last file" is remembered per vault: switching away and back
    // lands on that vault's own note.
    const vault = get().vaultPath;
    const lastFileByVault = vault
      ? { ...(getConfigSnapshot().lastFileByVault ?? {}), [vault]: path }
      : getConfigSnapshot().lastFileByVault;
    persistConfig({ ...getConfigSnapshot(), lastFileByVault, recentFiles });
  },
  closeFile: () => {
    set({ currentFile: null, dirty: false });
    // The current file is closed (deleted / changed externally): this vault's
    // restore point is cleared as well, so the next vault open does not
    // report "failed to open the last file" for a path that no longer
    // exists.
    const vault = get().vaultPath;
    if (vault && getConfigSnapshot().lastFileByVault?.[vault]) {
      const lastFileByVault = { ...getConfigSnapshot().lastFileByVault };
      delete lastFileByVault[vault];
      persistConfig({ ...getConfigSnapshot(), lastFileByVault });
    }
  },
  // No-op when unchanged: the dirty flag flips on every keystroke, and a
  // redundant set() would re-render every subscribed component per keypress.
  markDirty: (dirty) => {
    if (get().dirty !== dirty) set({ dirty });
  },
  patchSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    persistConfig({ ...getConfigSnapshot(), settings });
  },
  replaceSettings: (settings) => {
    set({ settings });
    persistConfig({ ...getConfigSnapshot(), settings });
  },
  setModal: (modal) => set({ modal }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  focusSidebar: () =>
    set({ sidebarOpen: true, sidebarFocusRequest: (get().sidebarFocusRequest ?? 0) + 1 }),
  clearSidebarFocus: () => {
    if (get().sidebarFocusRequest !== null) set({ sidebarFocusRequest: null });
  },
  // When the sidebar is collapsed, Sidebar is not mounted and the request
  // would hang forever — expand the sidebar as well so that someone
  // consumes it.
  requestRename: (relPath) => set({ sidebarOpen: true, renameRequest: relPath }),
  clearRenameRequest: () => {
    if (get().renameRequest !== null) set({ renameRequest: null });
  },
  openLinkSuggest: (anchor) => set({ linkSuggest: anchor }),
  closeLinkSuggest: () => {
    if (get().linkSuggest !== null) set({ linkSuggest: null });
  },
  pushLinkBack: (from, to) => set({ linkBack: [...get().linkBack, { from, to }] }),
  // The chain is still valid only when the landing of the last hop is the
  // current file; otherwise a file was opened in between in another way
  // (sidebar, quick switcher, new file, ...) and the chain is broken — clear
  // it on the way so no outdated path is kept around.
  popLinkBack: () => {
    const { linkBack, currentFile } = get();
    const top = linkBack[linkBack.length - 1];
    if (!top || top.to !== currentFile) {
      if (linkBack.length > 0) set({ linkBack: [] });
      return null;
    }
    set({ linkBack: linkBack.slice(0, -1) });
    return top.from;
  },
  setDailyBackFrom: (path) => set({ dailyBackFrom: path }),
  showToast: (msg) => set({ toast: msg }),
  clearToast: () => set({ toast: null }),
  // Entering a full-screen shape collapses the vault directory first: the left
  // side already holds three columns, and one more tree would be too crowded.
  // It is collapsed only at this moment; the user can expand it as usual
  // inside the mode afterwards. Leaving does not expand it back.
  setMode: (mode) => set(mode === "notes" ? { mode } : { mode, sidebarOpen: false }),
  toggleMode: (target) =>
    set(get().mode === target ? { mode: "notes" } : { mode: target, sidebarOpen: false }),
  setCodeProject: (codeProject) => {
    set({ codeProject });
    persistConfig({ ...getConfigSnapshot(), codeProject });
  },
  setCreativeMode: (active) => set({ creativeMode: active }),
  setStudyContent: (content) => set({ studyContent: content, studyWereadBook: null }),
  setRecentCodeProjects: (recentCodeProjects: string[]) => {
    set({ recentCodeProjects });
    persistConfig({ ...getConfigSnapshot(), recentCodeProjects });
  },
  setStudyHistory: (studyHistory) => set({ studyHistory }),
  setStudyWereadBook: (studyWereadBook) => set({ studyWereadBook }),
  recordStudyPdf: (entry) => {
    const studyHistory = pushPdfEntry(get().studyHistory, entry);
    set({ studyHistory });
    persistConfig({ ...getConfigSnapshot(), studyHistory });
  },
  recordStudyUrl: (entry) => {
    const studyHistory = pushUrlEntry(get().studyHistory, entry);
    set({ studyHistory });
    persistConfig({ ...getConfigSnapshot(), studyHistory });
  },
  recordWereadBook: (entry) => {
    const studyHistory = pushWereadBook(get().studyHistory, entry);
    set({ studyHistory });
    persistConfig({ ...getConfigSnapshot(), studyHistory });
  },
  openDrawingSession: (session) => set({ drawingSession: session }),
  closeDrawingSession: () => {
    if (get().drawingSession !== null) set({ drawingSession: null });
  },
  bumpAgentConfigVersion: () => set({ agentConfigVersion: get().agentConfigVersion + 1 }),
  bumpAgentSwitchSessionSignal: () =>
    set({ agentSwitchSessionSignal: get().agentSwitchSessionSignal + 1 }),
  runAgentPanelCommand: (kind, images) =>
    set({
      agentPanelCommand: { seq: (get().agentPanelCommand?.seq ?? 0) + 1, kind, images },
    }),
  // A real transition is what the layouts react to; repeated clicks inside
  // the same column must not re-render them.
  setMainColumn: (column) => {
    if (get().mainColumn !== column) set({ mainColumn: column });
  },
}));

export function toggleStudyMode() {
  useAppStore.getState().toggleMode("study");
}

/** The project management view switch (the same main area as the other shapes). */
export function toggleProjectsMode() {
  useAppStore.getState().toggleMode("projects");
}

/** The code mode switch (the project is remembered across restarts). */
export function toggleCodeMode() {
  useAppStore.getState().toggleMode("code");
}

let configSnapshot: PersistedConfig = {};
export function setConfigSnapshot(c: PersistedConfig) {
  configSnapshot = c;
}
export function getConfigSnapshot(): PersistedConfig {
  return configSnapshot;
}

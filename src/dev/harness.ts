import { EditorView } from "@codemirror/view";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { insertNewlineAndIndent, redo, undo } from "@codemirror/commands";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import "katex/dist/katex.min.css";
import "@/styles/global.css";
import { createEditor, loadDocument, reconfigureTypewriter, reconfigureVim } from "@/editor/setup";
import { editorApi } from "@/editor/api";
import {
  cycleHeading,
  enterContinueListItem,
  insertCallout,
  insertCodeBlock,
  insertMathBlock,
  jumpHeaderTodos,
  toggleList,
  toggleTodo,
} from "@/editor/ops";
import { renumberHeadings } from "@/editor/numbering";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { currentVimMode, getCM, Vim } from "@/editor/vim/vim";
import { getContextAt, mathRegions } from "@/editor/context";
import { autoFraction } from "@/editor/snippets/autofraction";
import { tryAutoExpand } from "@/editor/snippets/extension";
import { snippetStore } from "@/editor/snippets/engine";
import { getConfigSnapshot, setConfigSnapshot, useAppStore } from "@/state/appStore";
import { api, agentApi, focusApi, type FileNode } from "@/lib/tauri";
import { FocusChip } from "@/components/focus/FocusChip";
import { createTimerState } from "@/focus/timer";
import { useFocusStore } from "@/focus/store";
import { EditorPane } from "@/components/EditorPane";
import { relDirname } from "@/lib/path";
import * as actions from "@/app/actions";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "@/components/Sidebar";
import { LinkSuggest } from "@/components/study/LinkSuggest";
import "@/commands/builtin";
import { installGlobalKeybindings } from "@/commands/globalKeys";
import { applyOverrides, normalizeOverrides } from "@/commands/keys";
import { installEditingChords } from "@/lib/editingChords";
import { setClipboardOverrides } from "@/lib/clipboard";
import { renderAgentMarkdown } from "@/study/agentMarkdown";
import { StudyLayout } from "@/components/study/StudyLayout";
import { CodeLayout } from "@/components/code/CodeLayout";
import { useCodeStore } from "@/code/store";
import { AgentHeader } from "@/components/agent/AgentHeader";
import { HtmlPreview } from "@/components/agent/HtmlPreview";
import { AgentTranscript } from "@/components/agent/Transcript";
import {
  appendText,
  appendThinking,
  closeThinking,
  newTurn,
  pushToolStep,
  type ChatEntry,
} from "@/components/agent/model";
import { ProjectsLayout } from "@/components/projects/ProjectsLayout";
import { runCommand } from "@/commands/registry";
import { SettingsModal } from "@/components/SettingsModal";
import {
  footprintDay,
  footprintRevision,
  setFootprintHistoryForTest,
  setFootprintIndexForTest,
  todayFootprintEntries,
} from "@/footprint/store";
import type { FootprintBlock } from "@/footprint/model";
import { documentPath } from "@/editor/docPath";
import { dailyPathFor, isDailyPath } from "@/daily/model";
import { todayStamp } from "@/lib/todoStamp";

const DOC = `# 公式与光标

上面的普通文本行。

\$\$
L_{total}(\\theta) = L_{data}(\\theta) + \\frac{\\lambda}{2}||\\theta||^2
\$\$

块后第一行。

块后第二行。

\$\$
\\begin{align}
g_{t} &= \\nabla L_{data}(\\theta) + \\lambda \\theta \\\\
m_{t} &= \\beta_1 m_{t-1} + (1 - \\beta_1) g_{t}
\\end{align}
\$\$

第二个块后第一行。

第二个块后第二行。

最后一行。
`;

declare global {
  interface Window {
    __view: EditorView;
    __cursor: () => { line: number; col: number; pos: number };
    __setCursor: (line: number, col: number) => void;
    __loadDoc: (text: string) => number;
    __toggleTodo: () => void;
    __cycleHeading: () => void;
    __toggleList: (kind: "bullet" | "numbered") => void;
    __setTypewriter: (on: boolean) => void;
    __setTypewriterPosition: (position: number) => void;
    __enterAt: (text: string, line: number, col: number) => { which: string; after: string };
    /** Repeated Enter (the multi-press version of `__enterAt`), to observe the step-by-step fallback. */
    __enterTimes: (
      text: string,
      line: number,
      col: number,
      times: number,
    ) => { which: string[]; steps: string[]; cursors: { line: number; col: number }[] };
    /** The real file-switch path (setState, the syntax tree is reset), to reproduce/verify the first-frame render. */
    __loadFileDoc: (text: string, path?: string | null) => void;
    /** Set currentFile (commands keyed by file, such as the round-trip memory, need it set explicitly). */
    __setCurrentFile: (path: string | null) => void;
    /** Run the Enter key sequence right after loadDocument -- a deterministic reproduction of the empty-tree window. */
    __enterAfterLoad: (
      text: string,
      line: number,
      col: number,
    ) => { which: string; after: string; cursor: { line: number; col: number } };
    /** Probe for the empty-tree window: isActiveAt / tree coverage. */
    __freshProbe: (
      text: string,
      pos: number,
    ) => {
      activeNeg: boolean;
      activePos: boolean;
      treeLen: number;
      docLen: number;
      treeComplete: boolean;
    };
    __setAutoNumber: (on: boolean) => void;
    __renumber: () => void;
    __undo: () => boolean;
    __redo: () => boolean;
    /** Round-trip jump between the header question and the todo. */
    __jumpHeaderTodos: () => void;
    /** Insert a code block (the language comes from the codeBlockLang setting; a selection wraps the selected lines). */
    __insertCodeBlock: () => void;
    /** Insert a math block (shares the whole-line block insertion geometry with the code block). */
    __insertMathBlock: () => void;
    /** Insert a Callout block (the caret lands right after the `::: ` opening fence, next to the title slot; a selection wraps the selected lines). */
    __insertCallout: () => void;
    /** Change the code block language setting (through the real patchSettings path). */
    __setCodeBlockLang: (lang: string) => void;
    /** The current vim mode; null when vim is not installed (the compartment is empty). */
    __vimMode: () => string | null;
    /** Turn vim on/off according to the setting (same path as the real setting). */
    __setVim: (on: boolean) => void;
    /** Feed a key sequence to the vim engine (the real handleKey path). */
    __vimKeys: (keys: string[]) => { mode: string | null; doc: string; panel: string | null };
    /** A real Tab / Shift+Tab: goes through the CM keymap (snippet session -> matrix -> tabout). */
    __tab: (shift?: boolean, times?: number) => { heads: number[]; docs: string[] };
    /** Real typing (an input.type transaction); the closing-bracket jump-over goes through exactly this. */
    __typeChar: (ch: string) => { doc: string; head: number };
    /** Mount the settings modal (the real component plus the page's own store instance), returns the visible text. */
    __mountSettings: () => Promise<string>;
    /** Mount the focus chip (the real component plus the status bar shell), returns the unmount function. */
    __mountFocusChip: (durations?: number[]) => () => void;
    /** Mount the note pane (the real component), returns the status bar text (for layout checks). */
    __mountEditorPane: () => Promise<string>;
    __unmountSettings: () => void;
    /** Call the engine's openNotification directly, returns the bottom panel content (null when there is no panel). */
    __vimNotify: (text: string, durationMs?: number) => string | null;
    /** Profiling entry point: the module instances the page itself loaded (an injected script that uses a dynamic import gets a split instance). */
    __perfHooks: () => {
      getCM: typeof getCM;
      Vim: typeof Vim;
      enterContinueListItem: typeof enterContinueListItem;
      insertNewlineContinueMarkup: typeof insertNewlineContinueMarkup;
      insertNewlineAndIndent: typeof insertNewlineAndIndent;
      mathRegions: typeof mathRegions;
      getContextAt: typeof getContextAt;
      autoFraction: typeof autoFraction;
      tryAutoExpand: typeof tryAutoExpand;
      snippetStore: { enabled: boolean };
    };
    /** A fake vault (in-memory directory tree) plus the real Sidebar (waits for the index to be ready). */
    __mountSidebar: (entries: string[]) => Promise<string[]>;
    /** Really unmount the sidebar (this is the shape of collapsing it with Cmd-\: the component disappears together with its store subscription). */
    __unmountSidebar: () => void;
    /** A fake vault (in-memory directory tree) without the sidebar -- the editor-side chain only needs the vault. */
    __fakeVault: (entries: string[]) => Promise<string[]>;
    /** Mount the real <LinkSuggest/>, returns the unmount function (for A/B measurement). */
    __mountLinkSuggest: () => () => void;
    /** The panel's current render state (null when it is not mounted). */
    __linkPanel: () => LinkPanelState | null;
    /** Install the real keybinding dispatch (globalKeys -> runCommand). */
    __installGlobalKeys: () => void;
    /** The keybinding override table (not written to disk): to verify which region owns a given key. */
    __applyKeyOverrides: (overrides: unknown) => void;
    /** The current tree rows (including the inline rename state). */
    __treeRows: () => TreeRow[];
    /** Run the real newFolder and wait for the chain to settle. */
    __newFolder: (parent?: string, timeoutMs?: number) => Promise<TreeRow[]>;
    /** Type name into the rename input and press Enter. */
    __renameCommit: (name: string) => boolean;
    /** In-memory clipboard: inject content (for the Cmd-C/Cmd-X/Cmd-V assertions of the editor and forms). */
    __setClipboard: (text: string) => void;
    /** Read back the in-memory clipboard (assert the written content after Cmd-C/Cmd-X). */
    __readClipboard: () => string;
    /** The application store (read/drive the sidebar-related state). */
    __store: typeof useAppStore;
    /** The code project store (a fake project can be injected for layout checks). */
    __codeStore: typeof useCodeStore;
    /** The application-level actions (openNote / openWikiLink / goBackLink...). */
    __actions: typeof actions;
    /** The IPC layer (the object the fake vault replaces). */
    __api: typeof api;
    /** Mount the real study mode components (AgentPanel + ContentPane), returns the unmount function. */
    __mountStudyLayout: () => () => void;
    /** Mount the code mode layout (agent | code project | notes), returns the unmount function. */
    __mountCodeLayout: () => () => void;
    /** Mount the study assistant header (a pure presentational component with fake session data), to verify the dropdown/auxiliary bar geometry. */
    __mountAgentHeader: (spec: {
      convs: {
        key: string;
        label: string;
        parent: string | null;
        basedOn: string;
      }[];
      activeKey?: string;
      width?: number;
      /** Conversation font scale (--agent-fs, 1 by default). */
      fontScale?: number;
    }) => () => void;
    /** Mount the real project management view (project list / card lane / daily notes), returns the unmount function.
     *  contents preloads the file contents of the fake vault (vault-relative path -> text). */
    __mountProjects: (entries: string[], contents?: Record<string, string>) => Promise<() => void>;
    /** Run one command (the direct entry point of the keybinding chain, bypassing the synthesized keydown). */
    __runCommand: (id: string) => void;
    /** Read the document text of the focused editor (project card / daily note). */
    __paneDoc: () => string | null;
    /** The text of a line (1-based) in the focused editor. */
    __paneLine: (line: number) => string | null;
    /** Put the focused editor at a line and column (1-based line, 0-based column). */
    __paneCursor: (line: number, col?: number) => void;
    /** The file path of the currently focused editor. */
    __panePath: () => string | null;
    /** The focused editor instance (the project view has two: the project card / the daily note). */
    __editorApi: typeof editorApi;
    /**
     * Seed the remembered cursor positions (the map the remember-cursor-position
     * replay reads). `rememberCursorPosition` writes it, but a test needs to
     * start from a known value.
     */
    __setCursorMemory: (positions: Record<string, { pos: number; scroll: number }>) => void;
    /** The remembered cursor positions as they are now (read back after a save). */
    __cursorMemory: () => Record<string, { pos: number; scroll: number }>;
    /** Replace a line (1-based) of the focused editor, to simulate "editing a todo in the daily note". */
    __paneReplaceLine: (line: number, text: string) => void;
    /** Study mode PDF verification: inject a PDF's bytes and open the reader (mount the study layout first). */
    __openStudyPdf: (base64: string, relPath?: string, annotationsJson?: string) => Promise<string>;
    /** Read the content of a file in the fake vault (for the annotation persistence assertions); null when it does not exist. */
    __readFakeFile: (path: string) => string | null;
    /** The mini markdown renderer for study mode agent replies (returns HTML). */
    __renderAgentMd: (text: string) => string;
    /** Mount one real HtmlPreview (the live render of an agent `html` code block); returns the unmount function. */
    __mountHtmlPreview: (code: string) => () => void;
    /**
     * Mount the real agent transcript with one synthetic assistant turn built
     * through the real model helpers; returns the unmount function. Verifies
     * the work rows' stream order (thinking / narration / tool calls) in the
     * real DOM without a backend.
     */
    __mountAgentTranscript: (spec: {
      rows: (
        | { kind: "thinking"; text: string }
        | { kind: "text"; text: string }
        | { kind: "tool"; id: string; name: string; input?: unknown; output?: string; ok?: boolean }
      )[];
      /** Mark the turn as live (the work section starts open). */
      busy?: boolean;
      width?: number;
    }) => () => void;
    /** The syntax tree node names of the current document (for debugging). */
    __treeNames: () => string[];
    /** The syntax tree node names@range of a given line (1-based) (for debugging the render chain). */
    __treeAt: (line: number) => string[];
    /** Every decoration of the current view (widget class name/line class + range), grouped by source (for debugging the render chain). */
    __decos: () => Record<string, string[]>;
    /** Inject a fake footprint index (bypassing the baseline/rotation by building the module singleton directly and broadcasting).
     *  With a day, the injected index is that historical day's frozen archive. */
    __setFootprints: (entries: { path: string; blocks: FootprintBlock[] }[], day?: string) => void;
    /** Footprint debugging entry point: the internal state of the same-origin instance in the app. */
    __fpDebug: () => {
      vault: string | null;
      entries: { path: string; blocks: FootprintBlock[] }[];
      day: string | null;
      revision: number;
      docPath: string | null;
      wantDaily: string | null;
      isDaily: boolean | null;
    };
  }
}

interface TreeRow {
  relPath: string | null;
  name: string | null;
  renaming: boolean;
  value: string | null;
  selection: [number | null, number | null] | null;
  focused: boolean;
  kbdCursor: boolean;
}

interface LinkPanelState {
  /** The viewport coordinates of the panel's outer box (to assert it sticks to the caret line / flips above / is clamped into the viewport). */
  rect: { left: number; top: number; right: number; bottom: number };
  query: string | null;
  rows: { name: string; path: string; active: boolean }[];
  /** The caret line (viewport coordinates) -- used to compare against the panel position. */
  caretRect: { left: number; top: number; bottom: number } | null;
}

const view = createEditor(document.getElementById("editor-host")!, DOC, {
  onDocChanged: () => {},
  onCursorMoved: () => {},
});
reconfigureVim(view, true, []);
editorApi.view = view; // Same as in App: the hooks and the guards work on a single editor instance
view.focus();

window.__view = view;
window.__cursor = () => {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, col: head - line.from, pos: head };
};
window.__setCursor = (line: number, col: number) => {
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: Math.min(l.from + col, l.to) } });
  view.focus();
};
window.__loadDoc = (text: string) => {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  return view.state.doc.lines;
};
window.__toggleTodo = () => toggleTodo(view);
window.__cycleHeading = () => cycleHeading(view);
window.__toggleList = (kind) => toggleList(view, kind);
window.__setTypewriter = (on) => {
  useAppStore.getState().patchSettings({ typewriter: on });
  reconfigureTypewriter(view, on);
};
// The position setting goes through the same reconfigure: the plugin re-lays the top and bottom padding for the new ratio and re-centers immediately.
window.__setTypewriterPosition = (position) => {
  useAppStore.getState().patchSettings({ typewriterPosition: position });
  reconfigureTypewriter(view, useAppStore.getState().settings.typewriter);
};
// The real Enter key order (bnote list continuation -> lang-markdown continuation -> defaultKeymap), used to debug the continuation behavior.
const runEnterChain = () =>
  enterContinueListItem(view)
    ? "bnote"
    : insertNewlineContinueMarkup(view)
      ? "md"
      : (insertNewlineAndIndent(view), "default");
window.__enterAt = (text, line, col) => {
  window.__loadDoc(text);
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: col < 0 ? l.to : Math.min(l.from + col, l.to) } });
  const which = runEnterChain();
  return { which, after: view.state.doc.toString() };
};
// Repeated Enter: the step-by-step fallback (same level -> parent -> ... -> the top level drops the marker) is only
// observable with repeated presses, a single __enterAt does not show it. steps holds the full document after each press.
window.__enterTimes = (text, line, col, times) => {
  window.__loadDoc(text);
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: col < 0 ? l.to : Math.min(l.from + col, l.to) } });
  const which: string[] = [];
  const steps: string[] = [];
  const cursors: { line: number; col: number }[] = [];
  for (let i = 0; i < times; i++) {
    which.push(runEnterChain());
    steps.push(view.state.doc.toString());
    const c = window.__cursor();
    cursors.push({ line: c.line, col: c.col });
  }
  return { which, steps, cursors };
};
window.__loadFileDoc = (text, path = null) => {
  // path decides the base directory of relative image references (see editor/docPath.ts).
  loadDocument(view, text, path);
};
/** Set currentFile (commands keyed by file, such as the round-trip memory, need it set explicitly in the harness). */
window.__setCurrentFile = (path: string | null) => {
  useAppStore.setState({ currentFile: path });
};
window.__enterAfterLoad = (text, line, col) => {
  loadDocument(view, text);
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: col < 0 ? l.to : Math.min(l.from + col, l.to) } });
  const which = runEnterChain();
  const cur = window.__cursor();
  return { which, after: view.state.doc.toString(), cursor: { line: cur.line, col: cur.col } };
};
window.__freshProbe = (text, pos) => {
  loadDocument(view, text);
  const tree = syntaxTree(view.state);
  return {
    activeNeg: markdownLanguage.isActiveAt(view.state, pos, -1),
    activePos: markdownLanguage.isActiveAt(view.state, pos, 1),
    treeLen: tree.length,
    docLen: view.state.doc.length,
    treeComplete: syntaxTreeAvailable(view.state, view.state.doc.length),
  };
};
window.__setAutoNumber = (on) => {
  useAppStore.getState().patchSettings({ autoNumberHeadings: on });
};
window.__renumber = () => renumberHeadings(view);
window.__undo = () => undo(view);
window.__redo = () => redo(view);
window.__jumpHeaderTodos = () => jumpHeaderTodos(view);
window.__insertCodeBlock = () => insertCodeBlock(view);
window.__insertCallout = () => insertCallout(view);
window.__insertMathBlock = () => insertMathBlock(view);
window.__setCodeBlockLang = (lang) => {
  useAppStore.getState().patchSettings({ codeBlockLang: lang });
};
window.__vimMode = () => currentVimMode(view);
window.__setVim = (on) => {
  useAppStore.getState().patchSettings({ vim: on });
  reconfigureVim(view, on, []);
};
/** A real Tab / Shift+Tab key: goes through the CM keymap (snippet session -> matrix -> tabout, three layers),
    returns the caret position and the document after each press, to check in the browser where the "jump out of the bracket" lands. */
window.__tab = (shift = false, times = 1) => {
  const heads: number[] = [];
  const docs: string[] = [];
  for (let i = 0; i < times; i++) {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      }),
    );
    heads.push(view.state.selection.main.head);
    docs.push(view.state.doc.toString());
  }
  return { heads, docs };
};
/** Real typing (an input.type transaction, where the vim and non-vim input entries both converge):
    the closing-bracket jump-over listener goes through exactly this. Returns the document and the caret. */
window.__typeChar = (ch: string) => {
  const r = view.state.selection.main;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: ch },
    selection: { anchor: r.from + ch.length },
    userEvent: "input.type",
    scrollIntoView: true,
  });
  return { doc: view.state.doc.toString(), head: view.state.selection.main.head };
};
/** Feed a key sequence to the vim engine, exactly the path a real keydown takes
    (the wrapper's handleKey -> Vim.multiSelectHandleKey), returns the document/mode/bottom panel content. */
window.__vimKeys = (keys: string[]) => {
  const cm = getCM(view);
  if (!cm) throw new Error("vim engine not attached");
  for (const k of keys) Vim.multiSelectHandleKey(cm, k, "user");
  return {
    mode: currentVimMode(view),
    doc: view.state.doc.toString(),
    panel: document.querySelector(".cm-vim-panel")?.textContent ?? null,
  };
};

/** Call the engine's openNotification directly (the only exit of showConfirm), reproducing its element shape. */
window.__vimNotify = (text: string, durationMs = 1500) => {
  const cm = getCM(view);
  if (!cm) throw new Error("vim engine not attached");
  const pre = document.createElement("div");
  pre.className = "cm-vim-message";
  pre.textContent = text;
  cm.openNotification(pre, { bottom: true, duration: durationMs });
  return document.querySelector(".cm-vim-panel")?.textContent ?? null;
};

/** Profiling entry point: returns the module instances the page itself loaded. An injected script that uses a
 *  dynamic import gets a different instance split out by vite (the getCM WeakMap is empty), so it must be taken from here. */
window.__perfHooks = () => ({
  getCM,
  Vim,
  enterContinueListItem,
  insertNewlineContinueMarkup,
  insertNewlineAndIndent,
  mathRegions,
  getContextAt,
  autoFraction,
  tryAutoExpand,
  snippetStore,
});
/** Read/modify the application state directly (for debugging the sidebar flow). */
window.__store = useAppStore;
window.__codeStore = useCodeStore;
/** The application-level actions (openNote / openWikiLink / goBackLink...), driven along the real chain. */
window.__actions = actions;
/** The IPC layer (the fake vault intercepts exactly this) -- used for measurement/counting. */
window.__api = api;

// Study materials own one directory (annotations + sessions). The fake vault
// has no backend to resolve it, so pin one fixed directory: the annotation
// persistence test writes to the same file the reader reads.
const FAKE_MATERIAL_REL_DIR = "materials/pdfs/harness";
Object.assign(agentApi, {
  materialEnsure: async () => ({
    kind: "pdfs" as const,
    dir: "harness",
    relDir: FAKE_MATERIAL_REL_DIR,
    title: "harness.pdf",
  }),
});

// ---- Sidebar file tree: there is no Tauri (and no vault) in the browser, so an in-memory fake vault stands in for
// the IPC; the real <Sidebar/> is mounted and the real actions run, to verify the "new folder -> auto rename" chain.
const FAKE_ROOT = "/fake-vault";
/** The relPath the fake createDir finally lands on -- that is what the rename has to be watched on (not the name in the request). */
let lastCreatedDir: string | null = null;
/** The bytes used for the study mode PDF verification (the real backend reads them from disk by path, in the browser they can only be injected). */
let pdfBase64: string | null = null;
/** The file content table of the current fake vault (for the annotation persistence assertions). */
let fakeContents: Map<string, string> | null = null;

function installFakeVault(entries: string[]) {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const contents = new Map<string, string>();
  fakeContents = contents;
  for (const e of entries) (e.endsWith("/") ? dirs : files).add(e.replace(/\/$/, ""));

  const nodeOf = (rel: string, kind: "file" | "dir"): FileNode => ({
    name: rel.slice(rel.lastIndexOf("/") + 1),
    relPath: rel,
    kind,
    children: null,
  });
  const childrenOf = (parent: string): FileNode[] => [
    ...[...dirs]
      .filter((d) => relDirname(d) === parent)
      .sort()
      .map((d) => nodeOf(d, "dir")),
    ...[...files]
      .filter((f) => relDirname(f) === parent)
      .sort()
      .map((f) => nodeOf(f, "file")),
  ];
  const created = (rel: string) => ({ path: `${FAKE_ROOT}/${rel}`, relPath: rel });

  Object.assign(api, {
    setVault: async () => ({ path: FAKE_ROOT, name: "fake-vault" }),
    readTree: async () => childrenOf(""),
    readDir: async (rel: string) => childrenOf(rel),
    listFiles: async () => ({ files: [...files].sort(), dirs: [...dirs].sort() }),
    createDir: async (parent: string, name: string) => {
      let rel = parent ? `${parent}/${name}` : name;
      let counter = 2;
      while (dirs.has(rel) || files.has(rel))
        rel = `${parent ? `${parent}/` : ""}${name} ${counter++}`;
      dirs.add(rel);
      lastCreatedDir = rel;
      return created(rel);
    },
    createFile: async (parent: string, name: string) => {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let rel = parent ? `${parent}/${name}` : name;
      let counter = 2;
      while (dirs.has(rel) || files.has(rel))
        rel = `${parent ? `${parent}/` : ""}${stem} ${counter++}${ext}`;
      files.add(rel);
      return created(rel);
    },
    renamePath: async (path: string, newName: string) => {
      const rel = path.slice(FAKE_ROOT.length + 1);
      const to = `${relDirname(rel) ? `${relDirname(rel)}/` : ""}${newName}`;
      if (dirs.delete(rel)) dirs.add(to);
      else {
        files.delete(rel);
        files.add(to);
      }
      return `${FAKE_ROOT}/${to}`;
    },
    trashPath: async (path: string) => {
      const rel = path.slice(FAKE_ROOT.length + 1);
      for (const set of [dirs, files]) {
        for (const p of set) if (p === rel || p.startsWith(`${rel}/`)) set.delete(p);
      }
    },
    // A link jump has to really change the file: readFile/writeFile go through the same in-memory content table; a
    // missing file throws -- the real backend does the same, do not paper over a "deleted" file with default content.
    readFile: async (path: string) => {
      const rel = path.startsWith(FAKE_ROOT) ? path.slice(FAKE_ROOT.length + 1) : path;
      if (!files.has(rel)) throw new Error(`文件不存在: ${rel}`);
      return contents.get(rel) ?? `# ${rel}\n`;
    },
    // The PDF reader reads from disk as base64 (JSON IPC cannot carry the raw bytes); in the browser they are
    // pre-injected with __openStudyPdf.
    readFileBase64: async (path: string) => {
      if (pdfBase64) return pdfBase64;
      throw new Error(`没有 PDF 字节: ${path}`);
    },
    writeFile: async (path: string, text: string) => {
      const rel = path.startsWith(FAKE_ROOT) ? path.slice(FAKE_ROOT.length + 1) : path;
      contents.set(rel, text);
      files.add(rel); // a written file must be readable back by readFile (annotation persistence verification)
    },
    ensureDir: async (relPath: string) => {
      const parts = relPath.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    },
    saveAppConfig: async () => {},
  });

  useAppStore.getState().setVault({ path: FAKE_ROOT, name: "fake-vault" });
  return [...dirs].sort();
}

/**
 * A fake vault plus the real Sidebar; returns the initial directory list once the index is ready.
 * setVault clears the tree, so without a refresh the tree holds not a single row (refreshTree is what produces the root level).
 */
let sidebarRoot: ReturnType<typeof createRoot> | null = null;
let settingsRoot: ReturnType<typeof createRoot> | null = null;

window.__mountSidebar = async (entries: string[]) => {
  const dirs = installFakeVault(entries);
  const host = document.createElement("div");
  host.id = "sidebar-host";
  // display:flex is copied from the real .app: the sidebar is stretched to a fixed height, only then does .sidebar-tree scroll.
  host.style.cssText =
    "position:fixed;left:0;top:0;width:280px;height:100vh;z-index:99;display:flex";
  document.body.appendChild(host);
  sidebarRoot = createRoot(host);
  sidebarRoot.render(createElement(Sidebar));
  await actions.refreshTree();
  return dirs;
};

/** A real unmount: only removing the DOM would leave the old instance subscribed to the store (collapsing with Cmd-\ and reopening it would not show that). */
/**
 * Mount the real <EditorPane/>: the layout of the status bar (pomodoro chip + vim mode + caret position)
 * lives here, the returned status bar text makes it easy to assert "the path is gone, the chip is on the left, vim on the right".
 */
window.__mountEditorPane = async () => {
  const host = document.createElement("div");
  host.id = "editor-pane-host";
  host.style.cssText = "position:fixed;left:0;top:0;width:900px;height:600px;z-index:98";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(EditorPane));
  await new Promise((r) => setTimeout(r, 150));
  const bar = host.querySelector<HTMLElement>(".status-bar");
  return bar ? bar.innerText : "";
};

/**
 * Mount the focus chips (the real component plus the status bar shell).
 *
 * The native side (full screen / window level / event tap) does not exist in the browser -- a fake implementation
 * is installed on focusApi here, so the chip's rendering, panel and countdown can all be verified; the real window behavior can only be measured after a deployment.
 *
 * `durations` sets the offered durations through the store this page actually
 * renders (importing the store from outside the page graph yields a second
 * instance, whose state the component never sees).
 */
let focusChipRoot: ReturnType<typeof createRoot> | null = null;
window.__mountFocusChip = (durations?: number[]) => {
  if (durations) {
    // Idle, so the chip row renders the whole list instead of the running chip.
    useFocusStore.setState({
      timer: createTimerState({ focusDurations: durations }),
      now: Date.now(),
    });
  }
  Object.assign(focusApi, {
    status: async () => ({
      locked: false,
      hard_lock: false,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    }),
    lock: async () => ({
      locked: true,
      hard_lock: false,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    }),
    unlock: async () => ({
      locked: false,
      hard_lock: false,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    }),
    setHardLock: async (enabled: boolean) => ({
      locked: false,
      hard_lock: enabled,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    }),
    setHardLockActive: async (active: boolean) => ({
      locked: false,
      hard_lock: true,
      hard_active: active,
      trusted: true,
      seen: 0,
      swallowed: 0,
    }),
  });
  const host = document.createElement("div");
  host.id = "focus-chip-host";
  host.className = "status-bar";
  host.style.cssText = "position:fixed;left:0;bottom:0;width:420px;z-index:99";
  document.body.appendChild(host);
  focusChipRoot = createRoot(host);
  focusChipRoot.render(createElement(FocusChip));
  return () => {
    focusChipRoot?.unmount();
    focusChipRoot = null;
    document.getElementById("focus-chip-host")?.remove();
  };
};

/** Mount the settings modal (the real component plus the page's own store instance), to check the wiring of the settings.
    Returns the visible text of the rendered container, so it is easy to assert whether a section shows up. */
window.__mountSettings = async () => {
  const host = document.createElement("div");
  host.id = "settings-host";
  host.style.cssText =
    "position:fixed;right:0;top:0;width:520px;height:100vh;overflow:auto;z-index:99;background:var(--bg)";
  document.body.appendChild(host);
  settingsRoot = createRoot(host);
  settingsRoot.render(createElement(SettingsModal));
  useAppStore.getState().setModal("settings");
  await new Promise((r) => setTimeout(r, 50));
  return host.innerText;
};
window.__unmountSettings = () => {
  settingsRoot?.unmount();
  settingsRoot = null;
  document.getElementById("settings-host")?.remove();
  useAppStore.getState().setModal(null);
};
window.__unmountSidebar = () => {
  sidebarRoot?.unmount();
  sidebarRoot = null;
  document.querySelectorAll("#sidebar-host").forEach((el) => el.remove());
};

/** A fake vault (without the sidebar) plus a ready index: the link completion panel reads flatFiles/recentFiles. */
window.__fakeVault = async (entries: string[]) => {
  const dirs = installFakeVault(entries);
  await actions.refreshTree();
  return dirs;
};

/** Mount the real <LinkSuggest/>: whether the panel is mounted is decided by the store's linkSuggest anchor. Returns the unmount function. */
window.__mountLinkSuggest = () => {
  const host = document.createElement("div");
  host.id = "link-suggest-host";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(LinkSuggest));
  return () => {
    root.unmount();
    host.remove();
  };
};

window.__linkPanel = () => {
  const box = document.querySelector<HTMLElement>(".link-suggest");
  if (!box) return null;
  const caret = view.coordsAtPos(view.state.selection.main.head);
  const r = box.getBoundingClientRect();
  return {
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    query: document.querySelector<HTMLInputElement>(".link-suggest-input")?.value ?? null,
    rows: [...document.querySelectorAll(".link-suggest-row")].map((el) => ({
      name: el.querySelector(".link-suggest-name")?.textContent ?? "",
      path: el.querySelector(".link-suggest-path")?.textContent ?? "",
      active: el.classList.contains("active"),
    })),
    caretRect: caret ? { left: caret.left, top: caret.top, bottom: caret.bottom } : null,
  };
};

/** Install the real keybinding dispatch (globalKeys -> runCommand), to verify the whole Cmd-K chain. */
window.__installGlobalKeys = () => installGlobalKeybindings();

/** Keybinding overrides (not written to disk): to verify the regional dispatch (the same key binds different commands in different regions). */
window.__applyKeyOverrides = (overrides) => {
  applyOverrides(normalizeOverrides(overrides));
};

/** The currently rendered tree rows (including the inline rename input state). */
window.__treeRows = () =>
  [...document.querySelectorAll(".sidebar-tree .tree-row")].map((row) => {
    const input = row.querySelector<HTMLInputElement>(".rename-input");
    return {
      relPath: (row as HTMLElement).dataset.path ?? null,
      name: row.querySelector(".tree-name")?.textContent ?? null,
      renaming: input !== null,
      value: input?.value ?? null,
      selection: input ? [input.selectionStart, input.selectionEnd] : null,
      focused: input !== null && document.activeElement === input,
      kbdCursor: row.classList.contains("kbd-cursor"),
    };
  });

/**
 * Run the real newFolder and return the tree rows once the chain settled: what is waited for is exactly "the row of the just-created
 * relPath has an input box and holds the focus" -- other rename inputs (a leftover from a previous run) do not count. On a timeout
 * the current rows are returned as well and the caller asserts, so the wait does not turn into an assertion.
 */
window.__newFolder = async (parent?: string, timeoutMs = 1000) => {
  lastCreatedDir = null;
  await actions.newFolder(parent);
  const want = lastCreatedDir;
  const settled = () => {
    const input = document.querySelector<HTMLInputElement>(".rename-input");
    const row = input?.closest(".tree-row") as HTMLElement | null;
    return input !== null && row?.dataset.path === want && document.activeElement === input;
  };
  const deadline = performance.now() + timeoutMs;
  while (!settled() && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return window.__treeRows();
};

window.__renameCommit = (name: string) => {
  const input = document.querySelector<HTMLInputElement>(".rename-input");
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, name);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return true;
};

// In-memory clipboard (no Tauri IPC, navigator.clipboard is unreliable in a controlled environment) plus a global Cmd chord fallback
let clipboardStub = "";
setClipboardOverrides({
  read: async () => clipboardStub,
  write: async (text) => {
    clipboardStub = text;
    return true;
  },
});
window.__setClipboard = (text) => {
  clipboardStub = text;
};
window.__readClipboard = () => clipboardStub;
installEditingChords();

// Study mode debug hook: mounts the real three-column layout (invoke is unavailable in the browser, the components have to heal themselves).
window.__mountStudyLayout = () => {
  const host = document.createElement("div");
  host.id = "study-layout-host";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "9999";
  host.style.display = "flex";
  host.style.background = "var(--panel, #faf8f3)";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(StudyLayout));
  return () => {
    root.unmount();
    host.remove();
  };
};

window.__mountCodeLayout = () => {
  const host = document.createElement("div");
  host.id = "code-layout-host";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "9999";
  host.style.display = "flex";
  host.style.background = "var(--bg0)";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(CodeLayout));
  return () => {
    root.unmount();
    host.remove();
  };
};

/**
 * The study assistant header (a pure presentational component, it does not talk to the backend): to verify the geometry and the
 * interaction of the session dropdown / the auxiliary session bar. The convs of the real panel come from backend sessions, which
 * the harness cannot produce, so this layer is mounted on its own. The interaction result is written to the host's dataset.lastAction (select:<key> / back / ...).
 */
window.__mountAgentHeader = (spec) => {
  // Keep only one: on a repeated mount the old host would grab the same id (what gets measured would be the geometry of the previous one).
  for (const stale of document.querySelectorAll("#agent-header-host")) stale.remove();
  const host = document.createElement("div");
  host.id = "agent-header-host";
  host.style.cssText = `position:fixed;left:0;top:0;width:${spec.width ?? 360}px;height:100vh;z-index:9999;display:flex;background:var(--bg1)`;
  document.body.appendChild(host);
  const panel = document.createElement("aside");
  // The header geometry depends on the variables on .study-layout (--study-head-h / --study-lead):
  // only when mounted under that class do the measured pixels match the ones in the real app.
  host.className = "study-layout";
  panel.className = "agent-panel";
  panel.style.flex = "1";
  panel.style.minWidth = "0";
  host.appendChild(panel);
  const root = createRoot(panel);
  const activeKey = spec.activeKey ?? spec.convs[0]?.key ?? null;
  const active = spec.convs.find((c) => c.key === activeKey) ?? null;
  const parent = active?.parent ? (spec.convs.find((c) => c.key === active.parent) ?? null) : null;
  const record = (action: string) => {
    host.dataset.lastAction = action;
  };
  const fontScale = spec.fontScale ?? 1;
  // The font size panel measures real pixels: --agent-fs is written on the panel root element, just like in the real panel.
  panel.style.setProperty("--agent-fs", String(fontScale));
  root.render(
    createElement(AgentHeader, {
      convs: spec.convs,
      activeKey,
      onSelect: (key: string) => record(`select:${key}`),
      historyOpen: false,
      onToggleHistory: () => record("history"),
      onNewSession: () => record("new"),
      parent,
      onBack: () => record("back"),
      fontScale,
      onFontStep: (direction: 1 | -1) => record(`font:${direction}`),
      onFontReset: () => record("font:reset"),
    }),
  );
  return () => {
    root.unmount();
    host.remove();
  };
};

/**
 * The project management view: a fake vault plus the real ProjectsLayout (project navigation / kanban / daily notes).
 * entries are vault-relative paths (files or directories). Returns the unmount function.
 */
window.__mountProjects = async (entries: string[], contents: Record<string, string> = {}) => {
  installFakeVault(entries);
  for (const [rel, text] of Object.entries(contents)) {
    await api.writeFile(`${FAKE_ROOT}/${rel}`, text);
  }
  // flatFiles is the data source of the daily note dropdown (the index of listFiles is written into the store by refreshTree).
  await actions.refreshTree();
  const host = document.createElement("div");
  host.id = "projects-layout-host";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "9999";
  host.style.display = "flex";
  host.style.background = "var(--bg0, #0b0b0d)";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(ProjectsLayout));
  return () => {
    root.unmount();
    host.remove();
  };
};

window.__runCommand = (id: string) => {
  runCommand(id);
};

window.__paneDoc = () => {
  const v = editorApi.view;
  return v ? v.state.doc.toString() : null;
};

window.__paneLine = (line: number) => {
  const v = editorApi.view;
  if (!v) return null;
  const n = Math.min(Math.max(1, line), v.state.doc.lines);
  return v.state.doc.line(n).text;
};

window.__paneCursor = (line: number, col = 0) => {
  const v = editorApi.view;
  if (!v) return;
  const n = Math.min(Math.max(1, line), v.state.doc.lines);
  const l = v.state.doc.line(n);
  v.dispatch({ selection: { anchor: Math.min(l.from + col, l.to) } });
  v.focus();
};

window.__panePath = () => {
  const v = editorApi.view;
  return v ? documentPath(v.state) : null;
};

window.__editorApi = editorApi;
window.__setCursorMemory = (positions) => {
  setConfigSnapshot({ ...getConfigSnapshot(), cursorPositions: positions });
};
window.__cursorMemory = () => getConfigSnapshot().cursorPositions ?? {};

window.__paneReplaceLine = (line: number, text: string) => {
  const v = editorApi.view;
  if (!v) return;
  const n = Math.min(Math.max(1, line), v.state.doc.lines);
  const l = v.state.doc.line(n);
  v.dispatch({ changes: { from: l.from, to: l.to, insert: text } });
};

window.__renderAgentMd = renderAgentMarkdown;

/**
 * One real HtmlPreview (the live render of an agent `html` code block). The
 * browser has no packaged CSP and no custom scheme, so this exercises the
 * blob: fallback plus the height channel and the preview/code toggle; the
 * agent-preview protocol path is native-only.
 */
window.__mountHtmlPreview = (code: string) => {
  for (const stale of document.querySelectorAll("#html-preview-host")) stale.remove();
  const host = document.createElement("div");
  host.id = "html-preview-host";
  host.style.cssText =
    "position:fixed;left:0;top:0;width:420px;height:100vh;z-index:9999;background:var(--bg1)";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(HtmlPreview, { code }));
  return () => {
    root.unmount();
    host.remove();
  };
};

/**
 * One real assistant turn in the real transcript. The turn is assembled by the
 * same helpers the stream reducer uses, so the mounted rows are what the panel
 * would draw for that event order — the ordering has no other renderer to
 * disagree with.
 */
window.__mountAgentTranscript = (spec) => {
  for (const stale of document.querySelectorAll("#agent-transcript-host")) stale.remove();
  const host = document.createElement("div");
  host.id = "agent-transcript-host";
  host.style.cssText = `position:fixed;left:0;top:0;width:${spec.width ?? 520}px;height:100vh;z-index:9999;display:flex;background:var(--bg1)`;
  document.body.appendChild(host);

  const turn = newTurn(Date.now() - 90_000);
  turn.turnMs = 90_000;
  for (const row of spec.rows) {
    if (row.kind === "thinking") {
      appendThinking(turn, row.text, Date.now() - 80_000);
      closeThinking(turn, Date.now() - 70_000);
    } else if (row.kind === "text") {
      appendText(turn, row.text);
    } else {
      turn.tools.push({
        id: row.id,
        name: row.name,
        input: row.input,
        output: row.output,
        ok: row.ok ?? true,
      });
      pushToolStep(turn, row.id, Date.now());
    }
  }
  const entry: ChatEntry = {
    role: "assistant",
    text: turn.text,
    at: Date.now(),
    turn,
    items: null,
  };

  const root = createRoot(host);
  root.render(
    createElement(AgentTranscript, {
      scrollRef: { current: null },
      entries: [entry],
      busy: spec.busy ?? false,
      welcome: null,
      onFork: () => {},
    }),
  );
  return () => {
    root.unmount();
    host.remove();
  };
};

/**
 * Study mode PDF: put a PDF's bytes into the fake vault and open the reader.
 * __mountStudyLayout() must be called first; the annotation persistence goes through the same fake readFile/writeFile.
 */
window.__openStudyPdf = async (
  base64: string,
  relPath = "pdfs/harness.pdf",
  annotationsJson?: string,
) => {
  pdfBase64 = base64;
  installFakeVault(["pdfs/", relPath]);
  // Write the annotation file to disk first, then open the reader: what the component reads on mount is the restored data.
  // One file per PDF, the path matches pdfAnnotationRelPath.
  if (annotationsJson) {
    await api.writeFile(
      `${FAKE_ROOT}/.bnote/${FAKE_MATERIAL_REL_DIR}/annotations.json`,
      annotationsJson,
    );
  }
  const path = `${FAKE_ROOT}/${relPath}`;
  useAppStore.getState().setStudyContent({ kind: "pdf", path, title: "harness.pdf" });
  return path;
};

/** Read the content of a file in the fake vault (for the annotation persistence assertions); null when it does not exist. */
window.__readFakeFile = (path: string) => {
  const rel = path.startsWith(FAKE_ROOT) ? path.slice(FAKE_ROOT.length + 1) : path;
  return fakeContents?.get(rel) ?? null;
};

window.__treeNames = () => {
  const names: string[] = [];
  const walk = (
    node: { name: string; from: number; to: number; firstChild: unknown; nextSibling: unknown },
    depth: number,
  ) => {
    names.push("  ".repeat(depth) + node.name);
    for (
      let child = node.firstChild as typeof node;
      child;
      child = child.nextSibling as typeof node
    ) {
      walk(child, depth + 1);
    }
  };
  const tree = syntaxTree(editorApi.view!.state);
  walk(tree.topNode, 0);
  return names;
};

window.__treeAt = (line) => {
  const view = editorApi.view!;
  const doc = view.state.doc;
  const l = doc.line(Math.min(Math.max(1, line), doc.lines));
  const names: string[] = [];
  syntaxTree(view.state).iterate({
    from: l.from,
    to: l.to,
    enter: (node) => {
      names.push(`${node.name}@${node.from}-${node.to}`);
      return true;
    },
  });
  return names;
};

window.__decos = () => {
  const view = editorApi.view!;
  const doc = view.state.doc;
  const grouped: Record<string, string[]> = {};
  for (const set of view.state.facet(EditorView.decorations)) {
    if (
      typeof set !== "object" ||
      set === null ||
      typeof (set as { between?: unknown }).between !== "function"
    )
      continue;
    const label =
      (set as { debugSource?: string }).debugSource ?? `set@${(set as object).constructor.name}`;
    const out = grouped[label] ?? (grouped[label] = []);
    set.between(0, doc.length, (from, to, deco) => {
      const kind =
        (deco as { widget?: { constructor: { name: string } } }).widget?.constructor.name ??
        (deco as { class?: string }).class ??
        "line";
      out.push(`${kind} ${from}..${to}`);
    });
  }
  return grouped;
};

/** Inject a fake footprint index (use it with __loadFileDoc to open today's daily note path, to verify the footprint area rendering/folding/jumping);
 *  with a day, a historical day's archive is injected (open that day's daily note to verify the historical aggregation). */
window.__setFootprints = (entries, day) => {
  const vault = useAppStore.getState().vaultPath;
  if (!vault) throw new Error("no vault: call __fakeVault([...]) first");
  const index = new Map(entries.map((e) => [e.path, e.blocks]));
  if (day) setFootprintHistoryForTest(vault, day, index);
  else setFootprintIndexForTest(vault, index);
};

/** Footprint debugging entry point: the internal state of the same-origin instance in the app (docPath/index/decision inputs). */
window.__fpDebug = () => {
  const vault = useAppStore.getState().vaultPath;
  return {
    vault,
    entries: todayFootprintEntries(),
    day: footprintDay(),
    revision: footprintRevision(),
    docPath: documentPath(editorApi.view!.state),
    wantDaily: vault ? dailyPathFor(vault, todayStamp()) : null,
    isDaily:
      documentPath(editorApi.view!.state) !== null
        ? isDailyPath(documentPath(editorApi.view!.state)!)
        : null,
  };
};

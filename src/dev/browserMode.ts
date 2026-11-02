/**
 * Runs the app UI in a plain browser tab against the **real** backend.
 *
 * Vite serves the same build at :1430 for the Tauri window and for a browser,
 * but only the window gets `window.__TAURI_INTERNALS__` injected, so a tab
 * renders the chrome and then goes inert. When the internals are missing this
 * installs Tauri's own test interceptors (`@tauri-apps/api/mocks`) and points
 * them at the debug bridge inside the Rust process (`src-tauri/src/devbridge.rs`).
 *
 * Nothing here reaches production: `import.meta.env.DEV` is replaced with
 * `false` at build time, so the guard never runs.
 *
 * Known limits of the mock layer (not ours to fix):
 * `mockIPC`'s `plugin:event|unlisten` handler looks up an `id` field while
 * `@tauri-apps/api/event` sends `eventId`, so `unlisten()` is a no-op and each
 * listener stays registered for the tab's lifetime. A dev preview leaks one
 * closure per component mount; harmless.
 */

import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";

/**
 * The Rust dev bridge, hit cross-origin (it answers with `Access-Control-Allow-Origin: *`).
 * Not routed through Vite's `server.proxy` on purpose: the proxy buffers a
 * response it cannot size, so `/__dev/events` arrives as headers-never — 0
 * bytes through :1430 against a working stream on :1439, chunked encoding or
 * not.
 */
const BASE = "http://127.0.0.1:1439/__dev";

/** Backend events to relay; keep in sync with `devbridge.rs::subscribe_events`. */
const EVENTS = [
  "vault-changed",
  "agent-event",
  "ime-fallback",
  "python-run-output",
  "python-run-exit",
  "python-lsp-diagnostics",
  "python-lsp-status",
  "code-lsp-diagnostics",
  "code-lsp-status",
  "code-lsp-log",
  "term-output",
  "term-exit",
] as const;

type Internals = {
  convertFileSrc: (path: string, protocol?: string) => string;
};

export function installBrowserMode(): void {
  if (!import.meta.env.DEV) return;
  if ("__TAURI_INTERNALS__" in window) return; // real webview: nothing to do

  mockWindows("main");
  mockIPC(invokeOverHttp, { shouldMockEvents: true });
  // The official mock produces `asset://localhost/…`, which a browser cannot
  // load. The bridge serves the same bytes over HTTP; `convertFileSrc` is the
  // one hook `mockIPC` does not cover, so it is overridden here.
  mockConvertFileSrc("macos");
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals })
    .__TAURI_INTERNALS__;
  internals.convertFileSrc = (path: string) => `${BASE}/asset?p=${encodeURIComponent(path)}`;

  subscribeEvents();
  installDevHooks();
  console.info(`[bnote] browser mode: IPC → ${BASE} (real vault)`);
}

/**
 * Debug hooks for browser mode.
 *
 * The browser has no native folder picker, so the "open code project" path
 * cannot work -- these hooks let the browser open a project directly and read its
 * state. In a production build `import.meta.env.DEV` is false, so the whole block never runs.
 */
function installDevHooks(): void {
  const hooks = window as unknown as Record<string, unknown>;
  hooks.__bnoteDev = {
    /** Open a code project (path -> the middle column switches to the code view). */
    openCodeProject: async (root: string) => {
      const { openProjectAt } = await import("@/code/commands");
      await openProjectAt(root);
    },
    /** The current state of the code project. */
    codeState: () => {
      // Dynamic import: browserMode is an entry module, so a static import would drag the whole code module into the first paint.
      return import("@/code/store").then((m) => m.useCodeStore.getState());
    },
    /** Run one command (the direct entry point of the keybinding chain). */
    runCommand: async (id: string) => {
      const { runCommand } = await import("@/commands/registry");
      runCommand(id);
    },
    /** Put the caret in the code editor (1-based line, 0-based column). */
    setCodeCursor: async (line: number, column: number) => {
      const { activeCodeEditor } = await import("@/code/editor/registry");
      const handle = activeCodeEditor();
      if (!handle) return false;
      const doc = handle.view.state.doc;
      const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
      const offset = Math.min(l.from + Math.max(0, column), l.to);
      handle.view.dispatch({ selection: { anchor: offset } });
      handle.view.focus();
      return true;
    },
    /** Insert a piece of text into the code editor (simulates typing). */
    insertCodeText: async (text: string) => {
      const { activeCodeEditor } = await import("@/code/editor/registry");
      const handle = activeCodeEditor();
      if (!handle) return false;
      const pos = handle.view.state.selection.main.head;
      handle.view.dispatch({
        changes: { from: pos, to: pos, insert: text },
        selection: { anchor: pos + text.length },
        userEvent: "input.type",
      });
      return true;
    },
    /** The text of the code editor. */
    codeText: async () => {
      const { activeCodeEditor } = await import("@/code/editor/registry");
      const handle = activeCodeEditor();
      return handle ? handle.view.state.doc.toString() : null;
    },
  };
}

/** Every `invoke()` from `@tauri-apps/api` ends up here. */
async function invokeOverHttp(cmd: string, args?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args: args ?? null }),
  });
  if (!res.ok) {
    // Command failures reject with the backend's own string, as Tauri does.
    throw new Error(await res.text());
  }
  return res.json();
}

/** One long-lived SSE stream; EventSource reconnects on its own. */
function subscribeEvents(): void {
  const source = new EventSource(`${BASE}/events`);
  for (const name of EVENTS) {
    source.addEventListener(name, (event) => {
      // `mockIPC`'s event mocking delivers this to every local `listen()`.
      void emit(name, JSON.parse((event as MessageEvent).data));
    });
  }
}

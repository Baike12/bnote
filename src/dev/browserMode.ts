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
  console.info(`[bnote] browser mode: IPC → ${BASE} (real vault)`);
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

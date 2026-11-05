import { listen } from "@tauri-apps/api/event";
import { useCodeStore } from "./store";
import { activeCodeEditor } from "./editor/registry";
import { refreshDiagnostics } from "./editor/lsp";
import type { LspDiagnostic } from "./types";

/**
 * Event subscriptions for the language servers.
 *
 * The backend pushes diagnostics, server state and logs back; they land in the
 * store:
 * - diagnostics are keyed by file path (the editor reads them from the store
 *   and draws the inline marks);
 * - server state is keyed by language (the status bar shows whether the LSP is
 *   alive);
 * - logs keep the last few entries (to see what the server said when it
 *   misbehaves).
 *
 * The subscription is **application-scoped**, not component-scoped: language
 * servers stay alive while the project is open, so they keep pushing events
 * across panel remounts.
 */
/**
 * The server of the previous project keeps running until it is stopped, so its
 * events keep arriving after the switch. Every one of them carries `root`, and
 * only the events of the project currently open may reach the store — a late
 * diagnostic or log from the old project otherwise shows up under the new one
 * (the paths are project-relative, so they can collide outright).
 */
function fromThisProject(root: unknown): boolean {
  return sameProject(root, useCodeStore.getState().project?.root);
}

/** Whether an event of `payloadRoot` belongs to the project open as `currentRoot`. */
export function sameProject(payloadRoot: unknown, currentRoot: string | undefined): boolean {
  return (
    typeof payloadRoot === "string" && currentRoot !== undefined && payloadRoot === currentRoot
  );
}

export async function installCodeEvents(): Promise<() => void> {
  const offs: Array<() => void> = [];

  const add = async (event: string, handler: (payload: unknown) => void): Promise<void> => {
    try {
      const off = await listen(event, (e) => handler(e.payload));
      offs.push(off);
    } catch {
      // Outside Tauri (browser harness): no event source, skip silently.
    }
  };

  await add("code-lsp-diagnostics", (payload) => {
    const data = payload as { root?: unknown; path?: unknown; diagnostics?: unknown } | null;
    if (!data || !fromThisProject(data.root) || typeof data.path !== "string") return;
    const diagnostics = Array.isArray(data.diagnostics)
      ? (data.diagnostics as LspDiagnostic[])
      : [];
    useCodeStore.getState().setDiagnostics(data.path, diagnostics);
    // Diagnostics are pushed, so the editor never learns they changed on its
    // own — tell it to redraw them.
    const handle = activeCodeEditor();
    if (handle && handle.path === data.path) refreshDiagnostics(handle.view);
  });

  await add("code-lsp-status", (payload) => {
    const data = payload as { root?: unknown; language?: unknown; state?: unknown } | null;
    if (!data || !fromThisProject(data.root) || typeof data.language !== "string") return;
    useCodeStore
      .getState()
      .setLspState(data.language, typeof data.state === "string" ? data.state : "unknown");
  });

  await add("code-lsp-log", (payload) => {
    const data = payload as {
      root?: unknown;
      language?: unknown;
      level?: unknown;
      message?: unknown;
    } | null;
    if (!data || !fromThisProject(data.root)) return;
    useCodeStore
      .getState()
      .appendLspLog(
        typeof data.language === "string" ? data.language : "?",
        typeof data.level === "number" ? data.level : 3,
        typeof data.message === "string" ? data.message : "",
      );
  });

  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}

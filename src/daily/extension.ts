import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { documentPath } from "@/editor/docPath";
import { useAppStore } from "@/state/appStore";
import {
  applyIntents,
  intentsForRange,
  SYNC_USER_EVENT,
  type DailyDeps,
  type Intent,
} from "./engine";
import { peekLinks } from "./links";
import { isDailyPath } from "./model";
import { runtimeDeps } from "./runtime";

/**
 * Editor entry point of the cross-file todo sync: an updateListener watches the
 * document transactions, extracts sync intents with a line level diff (check
 * flips, edits inside a block, renames, disappearances), and after 250ms of
 * debouncing applies the mirrors and the records.
 *
 * Cost discipline per keystroke: without intents the only price is the constant
 * cost of "parse the line + compare the text" (locked by the gate in
 * perf.gate.test.ts); while the link store is not loaded yet (a startup race) the
 * whole round is skipped and the state converges on the next real edit, so
 * nothing is written wrong.
 *
 * Multiple instances: an intent records the view that produced it (`u.view`) and
 * execution proves itself against that view - the page can hold a note editor, a
 * project card editor and a daily note editor at the same time, and only the
 * transaction itself can say which one is being edited, a global singleton
 * cannot.
 */

const SEND_SUPPRESS_EVENTS = ["input.paste", "input.drop"];

export interface DailySyncOptions {
  /**
   * Allow "editing a todo that is not linked yet -> copy it into today's daily
   * note automatically". On by default for normal notes; project files pass false:
   * a project todo only reaches the daily note by being dragged there or by the
   * send shortcut.
   */
  allowAutoSend?: boolean;
}

export function dailySyncExtension(options: DailySyncOptions = {}): Extension {
  const allowAutoSend = options.allowAutoSend !== false;
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const path = documentPath(u.state);
    if (!path) return;
    const vaultRoot = useAppStore.getState().vaultPath;
    if (!vaultRoot) return;
    const store = peekLinks(vaultRoot);
    if (!store) return; // not loaded yet: no sync in this round (openVault triggers the load)
    const fileLinks = store.forFile(path);
    const allowSend = allowAutoSend && !isDailyPath(path); // a daily note never produces a "send" (mirroring still runs)
    if (fileLinks.length === 0 && !allowSend) return;
    const intents: Intent[] = [];
    for (const tr of u.transactions) {
      if (!tr.docChanged) continue;
      if (tr.isUserEvent(SYNC_USER_EVENT)) continue; // a transaction the engine wrote back itself
      const allowSendTr =
        allowSend && !SEND_SUPPRESS_EVENTS.some((e) => tr.isUserEvent(e));
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        intents.push(
          ...intentsForRange(tr.startState.doc, tr.state.doc, fromA, toA, fromB, toB, fileLinks, allowSendTr),
        );
      });
    }
    if (intents.length === 0) return;
    scheduleDailySync(u.view, path, intents);
  });
}

// ---------------------------------------------------------------- debounced execution

const PENDING_DELAY = 250;
const pending = new Map<
  string,
  { view: EditorView; timer: ReturnType<typeof setTimeout>; intents: Intent[] }
>();

function scheduleDailySync(view: EditorView, path: string, intents: Intent[]): void {
  const cur = pending.get(path);
  if (cur) {
    cur.view = view; // the same file is now edited in another instance: the newest transaction source wins
    cur.intents.push(...intents);
    clearTimeout(cur.timer);
    cur.timer = setTimeout(() => void fireDailySync(path), PENDING_DELAY);
    return;
  }
  const entry = {
    view,
    timer: setTimeout(() => void fireDailySync(path), PENDING_DELAY),
    intents: [...intents],
  };
  pending.set(path, entry);
}

async function fireDailySync(path: string): Promise<void> {
  const entry = pending.get(path);
  pending.delete(path);
  if (!entry) return;
  const view = entry.view;
  // Staleness proof: only run when the view is still alive and still holds the file that produced the intent
  if (!view.dom.isConnected || documentPath(view.state) !== path) return;
  const vaultRoot = useAppStore.getState().vaultPath;
  if (!vaultRoot) return;
  const store = peekLinks(vaultRoot);
  if (!store) return;
  const deps: DailyDeps = runtimeDeps();
  try {
    await applyIntents(view, path, entry.intents, deps, store);
  } catch (e) {
    console.warn("daily sync failed", e);
  }
}

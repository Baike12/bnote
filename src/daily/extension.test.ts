import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { docPathField, setDocPath } from "@/editor/docPath";

/**
 * The editor face of the cross-file sync: every document transaction is diffed
 * into intents, debounced by 250ms, and applied against the view that produced
 * it. This file drives the real listener (`state.facet(updateListener)`) with
 * real transactions, so the guard order itself is locked:
 *
 *  1. a transaction that does not change the document costs nothing;
 *  2. without a file path, a vault, or a loaded link store the round is skipped
 *     (the state converges on the next real edit - nothing is written wrong);
 *  3. paste / drop never auto-send, and a transaction the engine wrote back is
 *     ignored (the loop guard);
 *  4. several transactions inside the debounce merge into one apply round;
 *  5. a view that no longer holds the file at fire time drops its intents.
 *
 * The view is a stub: the listener only asks it for `dom.isConnected`, its state
 * and `dispatch`; a real EditorView needs a DOM and the behavior under test has
 * no geometry. Every test owns a fresh vault path because the link store is a
 * module singleton keyed by vault.
 */

const disk = vi.hoisted(() => new Map<string, string>());
const appState = vi.hoisted(() => ({
  vaultPath: null as string | null,
  toasts: [] as string[],
}));

vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: async (p: string) => {
      const text = disk.get(p);
      if (text === undefined) throw new Error("missing");
      return text;
    },
    writeFile: async (p: string, content: string) => {
      disk.set(p, content);
    },
  },
}));

vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({
      vaultPath: appState.vaultPath,
      settings: { daily: { template: "" } },
      showToast: (msg: string) => appState.toasts.push(msg),
    }),
  },
}));

import { dailySyncExtension, type DailySyncOptions } from "./extension";
import { SYNC_USER_EVENT } from "./engine";
import { ensureLinks, type DailyLink } from "./links";

const DAY = "2026-09-23";

/** A view stub: enough for the listener and for the staleness proof. */
function harness(doc: string, path: string, options: DailySyncOptions = {}) {
  let state = EditorState.create({
    doc,
    extensions: [docPathField, dailySyncExtension(options)],
    selection: EditorSelection.cursor(0),
  });
  state = state.update({ effects: setDocPath.of(path) }).state;
  const listeners = state.facet(EditorView.updateListener);
  const view = {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
  };

  /** Apply a change like a real edit: a real Transaction fed to the real listener. */
  function edit(from: number, insert: string, userEvent?: string): void {
    const tr = state.update({ changes: { from, to: from, insert }, userEvent });
    state = tr.state;
    feedTransactions([tr]);
  }

  /** Swap the document path (the same instance now holds another file). */
  function goTo(next: string): void {
    state = state.update({ effects: setDocPath.of(next) }).state;
  }

  function feedTransactions(transactions: Transaction[]): void {
    const last = transactions[transactions.length - 1];
    const update = {
      view,
      state: last.state,
      transactions,
      docChanged: transactions.some((t) => t.docChanged),
      viewportChanged: false,
    } as unknown as ViewUpdate;
    for (const listener of listeners) listener(update);
  }

  return {
    view,
    edit,
    goTo,
    feedTransactions,
    lineEnd: (lineNo = 1) => state.doc.line(lineNo).to,
    text: () => state.doc.toString(),
  };
}

let vault = "/vault-0";
let n = 0;
let src = "";
let daily = "";

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(2026, 8, 23, 10, 0, 0) });
  disk.clear();
  appState.toasts.length = 0;
  n++;
  vault = `/vault-${n}`;
  src = `${vault}/p.md`;
  daily = `${vault}/Daily/${DAY}.md`;
  appState.vaultPath = vault;
  await ensureLinks(vault);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Past the 250ms debounce of the extension. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
}

function link(patch: Partial<DailyLink> = {}): DailyLink {
  return {
    id: "c1",
    kind: "copied",
    day: DAY,
    srcPath: src,
    dailyPath: daily,
    text: "甲",
    srcLine: 1,
    dailyLine: 3,
    ...patch,
  };
}

describe("the update listener guards", () => {
  it("a transaction that does not change the document schedules nothing", async () => {
    const h = harness("- [ ] 甲\n", src);
    const tr = h.view.state.update({ selection: EditorSelection.cursor(2) });
    h.feedTransactions([tr]);
    await settle();
    expect(disk.size).toBe(0);
  });

  it("without a document path the round is skipped (a bare editor has no file to sync)", async () => {
    const bare = EditorState.create({
      doc: "- [ ] 甲\n",
      extensions: [docPathField, dailySyncExtension()],
    });
    const listeners = bare.facet(EditorView.updateListener);
    const at = bare.doc.line(1).to;
    const tr = bare.update({ changes: { from: at, to: at, insert: "!" } });
    const update = {
      view: { state: tr.state, dom: { isConnected: true }, dispatch: () => {} },
      state: tr.state,
      transactions: [tr],
      docChanged: true,
      viewportChanged: false,
    } as unknown as ViewUpdate;
    for (const listener of listeners) listener(update);
    await settle();
    expect(disk.size).toBe(0);
  });

  it("without a vault the round is skipped", async () => {
    appState.vaultPath = null;
    const h = harness("- [ ] 甲\n", src);
    h.edit(h.lineEnd(), "!");
    await settle();
    expect(disk.size).toBe(0);
  });

  it("while the link store is not loaded the round is skipped instead of syncing against an empty table", async () => {
    // A vault that was never loaded: peekLinks answers null for it
    appState.vaultPath = "/never-loaded";
    const h = harness("- [ ] 甲\n", "/never-loaded/p.md");
    h.edit(h.lineEnd(), "!");
    await settle();
    expect(disk.size).toBe(0);
  });

  it("a transaction the engine wrote back itself is ignored (loop guard)", async () => {
    const h = harness("- [ ] 甲\n", src);
    h.edit(h.lineEnd(), "!", SYNC_USER_EVENT);
    await settle();
    expect(disk.size).toBe(0);
  });

  it("a paste or drop transaction never auto-sends", async () => {
    for (const userEvent of ["input.paste", "input.drop"]) {
      const h = harness("- [ ] 甲\n", src);
      h.edit(h.lineEnd(), "!", userEvent);
      await settle();
      expect(disk.size).toBe(0);
    }
  });

  it("a touched daily note without links writes nothing (a daily note never sends itself)", async () => {
    const h = harness("# 2026-09-23\n\n- [ ] 甲\n", daily);
    h.edit(h.lineEnd(3), "!");
    await settle();
    expect(disk.size).toBe(0);
  });
});

describe("the debounced apply", () => {
  it("touching an unlinked todo sends the block to today's daily note once, after 250ms", async () => {
    const h = harness("- [ ] 甲\n", src);
    h.edit(h.lineEnd(), "!");
    expect(disk.has(daily)).toBe(false); // nothing moves inside the debounce
    await vi.advanceTimersByTimeAsync(249);
    expect(disk.has(daily)).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(disk.get(daily)).toBe("# 2026-09-23\n\n- [ ] 甲!\n");
  });

  it("two edits inside the window merge into one round: the daily note holds the final text once", async () => {
    const store = await ensureLinks(vault);
    const h = harness("- [ ] 甲\n", src);
    h.edit(h.lineEnd(), "!");
    await vi.advanceTimersByTimeAsync(200);
    h.edit(h.lineEnd(), "?");
    await settle();
    expect(disk.get(daily)).toBe("# 2026-09-23\n\n- [ ] 甲!?\n");
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({ kind: "auto", text: "甲!?" });
  });

  it("the newest instance wins when the same file is edited in another view inside the window", async () => {
    const h = harness("- [ ] 甲\n", src);
    h.edit(h.lineEnd(), "!");
    const other = harness("- [ ] 甲!\n", src);
    other.edit(other.lineEnd(), "?");
    h.goTo(`${vault}/other.md`);
    await settle();
    expect(disk.get(daily)).toBe("# 2026-09-23\n\n- [ ] 甲!?\n");
  });

  it("a view that switched files before the fire time drops its stale intents", async () => {
    const h = harness("- [ ] 甲\n", src);
    h.edit(h.lineEnd(), "!");
    h.goTo(`${vault}/other.md`);
    await settle();
    expect(disk.size).toBe(0);
    expect(appState.toasts).toEqual([]);
  });

  it("allowAutoSend=false (project files): an unlinked todo is not sent, a linked one still mirrors", async () => {
    const store = await ensureLinks(vault);
    const h = harness("- [ ] 甲\n", src, { allowAutoSend: false });
    h.edit(h.lineEnd(), "!");
    await settle();
    expect(disk.size).toBe(0);

    // The same file once linked: the mirror path is independent of allowAutoSend
    disk.set(daily, "# 2026-09-23\n\n- [ ] 甲!\n");
    store.upsert(link({ text: "甲!" }));
    h.edit(h.lineEnd(), "?");
    await settle();
    expect(disk.get(daily)).toBe("# 2026-09-23\n\n- [ ] 甲!?\n");
  });
});

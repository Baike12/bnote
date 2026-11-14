// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { docPathField, setDocPath } from "@/editor/docPath";

/**
 * The plugin face of the daily marks: a live EditorView mounts the extension, the
 * subscription to the link store wakes it through a tagged empty transaction, and
 * a document or path change rebuilds the decorations. The pure mark rules are
 * locked in marks.test.ts; this file locks the wiring that decides *when* those
 * rules run, which a pure test cannot see.
 *
 * A real EditorView is used because the plugin reads `view.dom.isConnected`,
 * `view.visibleRanges` and `view.state`. jsdom has no layout, so the visible
 * range covers the whole document.
 *
 * The link store is a module singleton keyed by vault, so every test owns a fresh
 * vault path: the store the plugin peeks and the store the test writes are the
 * same object by construction (ensureLinks is the only writer of the cache).
 */

const api = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<string> => {
    throw new Error("missing");
  }),
  writeFile: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
}));
const appState = vi.hoisted(() => ({ vaultPath: null as string | null }));

vi.mock("@/lib/tauri", () => ({ api }));
vi.mock("@/state/appStore", () => ({
  useAppStore: { getState: () => ({ vaultPath: appState.vaultPath }) },
}));

import { dailyMarksExtension } from "./marks";
import { ensureLinks, type DailyLink, type LinkStore } from "./links";

const DAY = "2026-09-30";

let n = 0;
let vault = "";
let srcPath = "";
let today = "";

function mount(doc: string, path: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  let state = EditorState.create({ doc, extensions: [docPathField, dailyMarksExtension()] });
  state = state.update({ effects: setDocPath.of(path) }).state;
  return new EditorView({ state, parent });
}

function link(patch: Partial<DailyLink> = {}): DailyLink {
  return {
    id: "l1",
    kind: "copied",
    day: DAY,
    srcPath,
    dailyPath: today,
    text: "甲",
    srcLine: 1,
    dailyLine: 3,
    ...patch,
  };
}

/** Let the microtask that the store broadcast queues run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(2026, 8, 30, 10, 0, 0) });
  n++;
  vault = `/marks-${n}`;
  srcPath = `${vault}/p.md`;
  today = `${vault}/Daily/${DAY}.md`;
  appState.vaultPath = vault;
  api.readFile.mockRejectedValue(new Error("missing"));
  await ensureLinks(vault);
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("the marks plugin", () => {
  it("mounts with no links and marks nothing", () => {
    const view = mount("- [ ] 甲\n", srcPath);
    expect(view.dom.querySelectorAll(".md-daily-link")).toHaveLength(0);
    view.destroy();
  });

  it("a store change wakes the plugin and the linked todo line is marked", async () => {
    const store: LinkStore = await ensureLinks(vault);
    const view = mount("- [ ] 甲\n- [ ] 乙\n", srcPath);
    store.upsert(link({ text: "乙", srcLine: 2 }));
    await flush();
    const marked = view.dom.querySelectorAll<HTMLElement>(".md-daily-link");
    expect(marked).toHaveLength(1);
    // The source side carries the "sent" marker the project card styles
    expect(marked[0].dataset.dailySent).toBe("1");
    view.destroy();
  });

  it("a path swap rebuilds the marks: the same view now holds the daily note side", async () => {
    const store: LinkStore = await ensureLinks(vault);
    const view = mount("# 2026-09-30\n\n- [ ] 甲\n", srcPath);
    store.upsert(link());
    await flush();
    expect(view.dom.querySelectorAll(".md-daily-link")).toHaveLength(1);

    view.dispatch({ effects: setDocPath.of(today) });
    await flush();
    const marked = view.dom.querySelectorAll<HTMLElement>(".md-daily-link");
    expect(marked).toHaveLength(1);
    // The daily side names the source note instead of the "sent" marker
    expect(marked[0].dataset.dailySrc).toBe("p");
    expect(marked[0].dataset.dailySent).toBeUndefined();
    view.destroy();
  });

  it("a document edit rebuilds the marks from the new text", async () => {
    const store: LinkStore = await ensureLinks(vault);
    const view = mount("- [ ] 甲\n", srcPath);
    store.upsert(link());
    await flush();
    expect(view.dom.querySelectorAll(".md-daily-link")).toHaveLength(1);

    // The todo is turned into prose: the mark goes away with the identity text
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "- 甲\n" } });
    await flush();
    expect(view.dom.querySelectorAll(".md-daily-link")).toHaveLength(0);
    view.destroy();
  });

  it("removing the link clears the mark on the next broadcast", async () => {
    const store: LinkStore = await ensureLinks(vault);
    const view = mount("- [ ] 甲\n", srcPath);
    store.upsert(link());
    await flush();
    expect(view.dom.querySelectorAll(".md-daily-link")).toHaveLength(1);

    store.remove("l1");
    await flush();
    expect(view.dom.querySelectorAll(".md-daily-link")).toHaveLength(0);
    view.destroy();
  });

  it("without a vault nothing is marked even when the store holds the link", async () => {
    const store: LinkStore = await ensureLinks(vault);
    appState.vaultPath = null;
    const view = mount("- [ ] 甲\n", srcPath);
    store.upsert(link());
    await flush();
    expect(view.dom.querySelectorAll(".md-daily-link")).toHaveLength(0);
    view.destroy();
  });

  it("a destroyed view stops listening to the store", async () => {
    const store: LinkStore = await ensureLinks(vault);
    const view = mount("- [ ] 甲\n", srcPath);
    view.destroy();
    // A broadcast after destroy must not dispatch on the dead view
    expect(() => store.upsert(link({ id: "late" }))).not.toThrow();
    await flush();
    expect(document.querySelectorAll(".md-daily-link")).toHaveLength(0);
  });
});

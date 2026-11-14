// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { docPathField, setDocPath } from "@/editor/docPath";
import { registerNoteOpener } from "@/lib/navigation";

/**
 * The daily side of the footprint extension: a block widget is attached to the
 * end of a daily note's document (today from the live index, a historical day
 * from the frozen archive), the click routing on data-footprint-* folds and
 * jumps, and a plain note gets no zone at all.
 *
 * A real EditorView is required: the StateField reads `state.doc.length`, the
 * mousedown handler is registered through `EditorView.domEventHandlers`, and the
 * widget DOM (buildZoneValue → FootprintWidget) is what the assertions read.
 * jsdom has no layout, so nothing here depends on geometry.
 *
 * The store is a module singleton keyed by vault: every test owns a vault path.
 */

const appState = vi.hoisted(() => ({ vaultPath: null as string | null }));

vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: async () => {
      throw new Error("missing");
    },
    writeFile: async () => {},
    listFiles: async () => ({ files: [], truncated: false }),
  },
}));
vi.mock("@/state/appStore", () => ({
  useAppStore: { getState: () => ({ vaultPath: appState.vaultPath }) },
}));

import { footprintMarksExtension, footprintZoneExtension } from "./extension";
import { ensureFootprints, setFootprintHistoryForTest, setFootprintIndexForTest } from "./store";
import { currentFold, flipGroupFold, flipZoneFold } from "./widget";

const DAY = "2026-09-30";

let n = 0;
let vault = "";
let daily = "";
let note = "";
let opened: { path: string; line?: number }[] = [];

function mount(doc: string, path: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  let state = EditorState.create({ doc, extensions: [docPathField, footprintZoneExtension()] });
  state = state.update({ effects: setDocPath.of(path) }).state;
  return new EditorView({ state, parent });
}

const zoneOf = (view: EditorView) => view.contentDOM.querySelector<HTMLElement>(".footprint-zone");
const blocks = (text: string, start = 1) => [{ text, start, end: start }];

/** Unfold the session state so one test cannot leak into the next (the fold is module level). */
function resetFold(): void {
  if (currentFold().zoneCollapsed) flipZoneFold();
  for (const path of [...currentFold().groups]) flipGroupFold(path);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 30, 10, 0, 0) });
  n++;
  vault = `/fz-${n}`;
  daily = `${vault}/Daily/${DAY}.md`;
  note = `${vault}/Job/job todo.md`;
  appState.vaultPath = vault;
  opened = [];
  registerNoteOpener((path, line) => opened.push({ path, line }));
  resetFold();
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("the zone widget on a daily note", () => {
  it("today's daily note attaches the zone at the end of the document with the live index", () => {
    setFootprintIndexForTest(vault, new Map([[note, blocks("今天写的段落")]]));
    const view = mount(`# ${DAY}`, daily);
    const zone = zoneOf(view);
    expect(zone).not.toBeNull();
    expect(zone?.textContent).toContain("今日足迹");
    expect(zone?.textContent).toContain("1 个文件");
    expect(zone?.textContent).toContain("今天写的段落");
    // The widget is a block decoration at the end of the document, after the content
    expect(view.contentDOM.querySelector(".cm-line")?.nextElementSibling).toBe(zone);
    view.destroy();
  });

  it("a historical daily note reads the frozen archive and titles the zone with its date", async () => {
    // The archive is only consulted once the store knows its baseline day
    await ensureFootprints(vault);
    setFootprintHistoryForTest(vault, "2026-09-21", new Map([[note, blocks("那天的段落")]]));
    const view = mount("# 2026-09-21", `${vault}/Daily/2026-09-21.md`);
    const zone = zoneOf(view);
    expect(zone?.textContent).toContain("2026-09-21 足迹");
    expect(zone?.textContent).toContain("那天的段落");
    view.destroy();
  });

  it("a day with no footprint attaches no widget at all", () => {
    // The store is loaded for this vault first, so "no entries" is the real
    // answer and not just an unloaded store
    setFootprintIndexForTest(vault, new Map());
    const view = mount(`# ${DAY}`, daily);
    expect(zoneOf(view)).toBeNull();
    view.destroy();
  });

  it("a plain note gets no zone, even when its own footprint exists", () => {
    setFootprintIndexForTest(vault, new Map([[note, blocks("正文")]]));
    const view = mount("正文\n", note);
    expect(zoneOf(view)).toBeNull();
    view.destroy();
  });

  it("a document path swap into a daily note attaches the zone, and swapping away removes it", () => {
    setFootprintIndexForTest(vault, new Map([[note, blocks("正文")]]));
    const view = mount("正文\n", note);
    expect(zoneOf(view)).toBeNull();

    view.dispatch({ effects: setDocPath.of(daily) });
    expect(zoneOf(view)).not.toBeNull();

    view.dispatch({ effects: setDocPath.of(note) });
    expect(zoneOf(view)).toBeNull();
    view.destroy();
  });
});

describe("the click routing", () => {
  const HIST_DAY = "2026-09-21";
  const histDaily = () => `${vault}/Daily/${HIST_DAY}.md`;

  /**
   * The click tests read the widget after an async wake, and today's daily note
   * additionally runs the full-refresh fallback (which rebuilds the index from
   * disk). A historical note reads the frozen archive instead, which the fallback
   * never touches, so the widget stays exactly what the test arranged.
   */
  async function mountHistory(
    archived: Map<string, { text: string; start: number; end: number }[]>,
  ) {
    await ensureFootprints(vault);
    setFootprintHistoryForTest(vault, HIST_DAY, archived);
    return mount(`# ${HIST_DAY}`, histDaily());
  }

  function mousedownOn(view: EditorView, selector: string): void {
    const el = view.contentDOM.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`missing ${selector}`);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  }

  it("clicking the zone head folds the zone and the widget redraws collapsed", async () => {
    const view = await mountHistory(new Map([[note, blocks("正文")]]));
    mousedownOn(view, ".footprint-zone-head");
    await vi.advanceTimersByTimeAsync(0);
    expect(currentFold().zoneCollapsed).toBe(true);
    expect(view.contentDOM.querySelectorAll(".footprint-group")).toHaveLength(0);
    view.destroy();

    // Unfold so the next test starts expanded (the fold is module level)
    flipZoneFold();
  });

  it("clicking a group head folds that group only", async () => {
    const other = `${vault}/b.md`;
    const view = await mountHistory(
      new Map([
        [note, blocks("甲")],
        [other, blocks("乙")],
      ]),
    );
    mousedownOn(view, `.footprint-group-head[data-footprint-path="${note}"]`);
    await vi.advanceTimersByTimeAsync(0);
    expect(currentFold().groups.has(note)).toBe(true);
    const groups = [...view.contentDOM.querySelectorAll<HTMLElement>(".footprint-group")];
    expect(groups).toHaveLength(2);
    // The folding is per group: the folded one keeps its header but loses its
    // block, the sibling stays open (the render order is locale dependent, so the
    // groups are looked up by path)
    const folded = groups.find(
      (g) => g.querySelector(".footprint-group-head")?.getAttribute("data-footprint-path") === note,
    );
    const sibling = groups.find((g) => g !== folded);
    expect(folded?.querySelector(".footprint-block")).toBeNull();
    expect(folded?.querySelector(".footprint-group-head")).not.toBeNull();
    expect(sibling?.querySelector(".footprint-block")).not.toBeNull();
    view.destroy();
    flipGroupFold(note);
  });

  it("clicking a group name opens the source note at its first line", async () => {
    const view = await mountHistory(new Map([[note, blocks("正文", 5)]]));
    mousedownOn(view, ".footprint-group-title");
    expect(opened).toEqual([{ path: note, line: undefined }]);
    view.destroy();
  });

  it("clicking a block body opens the source note at the block start line", async () => {
    const view = await mountHistory(new Map([[note, blocks("正文", 5)]]));
    mousedownOn(view, ".footprint-block");
    expect(opened).toEqual([{ path: note, line: 5 }]);
    view.destroy();
  });

  it("a click without a footprint action reaches the editor untouched", async () => {
    const view = await mountHistory(new Map([[note, blocks("正文")]]));
    const line = view.contentDOM.querySelector(".cm-line") as HTMLElement;
    const notHandled = line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(notHandled).toBe(true); // not preventDefault'ed by the handler
    expect(opened).toEqual([]);
    view.destroy();
  });
});

describe("the source side pip", () => {
  it("a plain note marks the first line of every block collected today", async () => {
    setFootprintIndexForTest(
      vault,
      new Map([[note, [...blocks("甲", 1), { text: "乙", start: 3, end: 3 }]]]),
    );
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let state = EditorState.create({
      doc: "甲\n\n乙\n",
      extensions: [docPathField, footprintMarksExtension()],
    });
    state = state.update({ effects: setDocPath.of(note) }).state;
    const view = new EditorView({ state, parent });
    await vi.waitFor(() => {
      expect(view.dom.querySelectorAll(".md-footprint")).toHaveLength(2);
    });
    const pips = view.dom.querySelectorAll<HTMLElement>(".md-footprint");
    expect(pips[0].title).toBe("今日足迹已收录到今日日记");
    view.destroy();
  });

  it("a daily note never carries a pip (it is the aggregation page itself)", () => {
    setFootprintIndexForTest(vault, new Map([[note, blocks("甲")]]));
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let state = EditorState.create({
      doc: "# d\n\n- [ ] 甲\n",
      extensions: [docPathField, footprintMarksExtension()],
    });
    state = state.update({ effects: setDocPath.of(daily) }).state;
    const view = new EditorView({ state, parent });
    expect(view.dom.querySelectorAll(".md-footprint")).toHaveLength(0);
    view.destroy();
  });

  it("a note without a footprint carries no pip", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let state = EditorState.create({
      doc: "正文\n",
      extensions: [docPathField, footprintMarksExtension()],
    });
    state = state.update({ effects: setDocPath.of(`${vault}/clean.md`) }).state;
    const view = new EditorView({ state, parent });
    expect(view.dom.querySelectorAll(".md-footprint")).toHaveLength(0);
    view.destroy();
  });
});

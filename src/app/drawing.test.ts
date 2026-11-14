import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The canvas session's orchestration: one serialized writer with a 600ms
 * debounce, unchanged content skipped, and the Obsidian-style "a drawing is a
 * file" finalization. The failure shape being locked is a late or concurrent
 * write overwriting the note the user switched to, plus "an empty new drawing
 * must not stay on disk" and "the fill-back is dropped when the source note is
 * gone".
 *
 * The module owns a save scheduler, so every test starts from a fresh module
 * instance (the app store is re-imported with it to keep one store).
 */

const fs = vi.hoisted(() => {
  const state = {
    files: new Map<string, string>(),
    writes: [] as { path: string; json: string }[],
    pngs: [] as { path: string; base64: string }[],
    trashed: [] as string[],
    failWrite: false,
    failCreate: false,
    holdWrites: false,
    pending: null as null | (() => void),
    write(path: string, json: string) {
      state.files.set(path, json);
      state.writes.push({ path, json });
    },
  };
  return state;
});

const actions = vi.hoisted(() => ({
  saveNote: vi.fn(async () => {}),
  refreshTree: vi.fn(async () => {}),
}));

const toasts = vi.hoisted(() => ({ messages: [] as string[] }));
const editor = vi.hoisted(() => ({ view: null as unknown }));

vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: async (path: string) => {
      const text = fs.files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    writeFile: async (path: string, json: string) => {
      if (fs.failWrite) throw new Error("DISK_FULL");
      if (fs.holdWrites) await new Promise<void>((resolve) => (fs.pending = resolve));
      fs.write(path, json);
    },
    ensureDir: async () => {},
    createFile: async (parent: string, name: string) => {
      if (fs.failCreate) throw new Error("READ_ONLY");
      const path = `/v/${parent}/${name}`;
      fs.files.set(path, "");
      return { path, relPath: `${parent}/${name}` };
    },
    writeFileBase64: async (path: string, base64: string) => {
      fs.pngs.push({ path, base64 });
    },
    trashPath: async (path: string) => {
      fs.trashed.push(path);
      fs.files.delete(path);
    },
    saveAppConfig: async () => {},
  },
}));

// The PNG export is a heavy browser-only dependency: the session logic only
// needs "a blob comes back and its base64 half reaches the disk".
vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
}));

vi.mock("@/editor/api", () => ({ getView: () => editor.view }));
vi.mock("@/editor/docPath", () => ({
  documentPath: (state: { path?: string }) => state.path ?? null,
  setDocPath: { of: (p: string) => ({ type: "setDocPath", path: p }) },
}));
vi.mock("@/app/actions", () => ({ saveNote: actions.saveNote, refreshTree: actions.refreshTree }));

import type * as AppStore from "@/state/appStore";
import type * as Drawing from "./drawing";

const DRAWING = "/v/Excalidraw/d.excalidraw";
const SCENE = {
  elements: [{ id: "rect", isDeleted: false }],
  appState: { viewBackgroundColor: "#fff" },
  files: null,
};

type Store = typeof AppStore.useAppStore;
type DrawingModule = typeof Drawing;

let store: Store;
let drawing: DrawingModule;

class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: unknown = null;

  readAsDataURL(): void {
    this.result = "data:image/png;base64,AQID";
    queueMicrotask(() => this.onload?.());
  }
}

function fakeDoc(text: string, path: string | null) {
  const lines = text.split("\n");
  return {
    length: text.length,
    lines: lines.length,
    path: path ?? "",
    lineAt(pos: number) {
      let from = 0;
      for (let i = 0; i < lines.length; i++) {
        const to = from + lines[i].length;
        if (pos <= to) return { number: i + 1, from, to, text: lines[i] };
        from = to + 1;
      }
      const last = lines.length - 1;
      return { number: lines.length, from, to: text.length, text: lines[last] ?? "" };
    },
    toString: () => text,
  };
}

function fakeView(text: string, cursor = 0, path: string | null = "/v/note.md") {
  const doc = fakeDoc(text, path);
  const dispatches: Record<string, unknown>[] = [];
  const view = {
    state: { doc, selection: { main: { head: cursor } }, path },
    dispatches,
    dispatch(spec: Record<string, unknown>) {
      dispatches.push(spec);
    },
    coordsAtPos: () => null,
    requestMeasure: () => {},
    scrollDOM: {},
    focus: () => {},
  };
  return view;
}

type FakeView = ReturnType<typeof fakeView>;

/** The dispatches that change the document (the decoration refresh is an effect). */
function edits(view: FakeView) {
  return view.dispatches.filter((spec) => "changes" in spec);
}

function sessionState(overrides: Record<string, unknown> = {}) {
  store.setState({
    drawingSession: {
      path: DRAWING,
      isNew: true,
      originNote: "/v/note.md",
      originPos: 0,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const appStore = await import("@/state/appStore");
  drawing = await import("./drawing");
  store = appStore.useAppStore;

  fs.files.clear();
  fs.writes.length = 0;
  fs.pngs.length = 0;
  fs.trashed.length = 0;
  fs.failWrite = false;
  fs.failCreate = false;
  fs.holdWrites = false;
  fs.pending = null;
  actions.saveNote.mockClear();
  actions.refreshTree.mockClear();
  toasts.messages.length = 0;
  editor.view = null;
  (globalThis as { FileReader?: unknown }).FileReader = FakeFileReader;
  store.setState({ vaultPath: "/v", currentFile: "/v/note.md", drawingSession: null });
  vi.spyOn(store.getState(), "showToast").mockImplementation((msg: string) => {
    toasts.messages.push(msg);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("save scheduling", () => {
  it("debounces a burst of canvas changes into one write", async () => {
    sessionState();
    const second = { ...SCENE, elements: [...SCENE.elements, { id: "b" }] };

    drawing.beginDrawingSave(SCENE);
    drawing.beginDrawingSave(second);
    expect(fs.writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(600);

    expect(fs.writes).toHaveLength(1);
    expect(JSON.parse(fs.writes[0]?.json ?? "{}").elements).toHaveLength(2);
  });

  it("skips a write whose serialization is identical (idempotent re-save)", async () => {
    sessionState();
    drawing.beginDrawingSave(SCENE);
    await vi.advanceTimersByTimeAsync(600);
    expect(fs.writes).toHaveLength(1);

    drawing.beginDrawingSave({ ...SCENE, elements: [...SCENE.elements] });
    await vi.advanceTimersByTimeAsync(600);
    expect(fs.writes).toHaveLength(1);
  });

  it("a failed write is reported and the next save rewrites the whole file", async () => {
    sessionState();
    fs.failWrite = true;
    drawing.beginDrawingSave(SCENE);
    await vi.advanceTimersByTimeAsync(600);

    expect(toasts.messages).toHaveLength(1);
    expect(toasts.messages[0]).toContain("画布保存失败");
    expect(fs.writes).toEqual([]);

    fs.failWrite = false;
    drawing.beginDrawingSave({ ...SCENE, elements: [...SCENE.elements, { id: "later" }] });
    await vi.advanceTimersByTimeAsync(600);
    expect(fs.writes).toHaveLength(1);
  });

  it("never writes concurrently: a change during a write triggers exactly one follow-up round", async () => {
    sessionState();
    fs.holdWrites = true;
    drawing.beginDrawingSave(SCENE);
    await vi.advanceTimersByTimeAsync(600);
    expect(fs.pending).not.toBeNull();

    drawing.beginDrawingSave({ ...SCENE, elements: [...SCENE.elements, { id: "c" }] });
    await vi.advanceTimersByTimeAsync(600);
    // The debounce fired while the first write was still in flight.
    expect(fs.writes).toHaveLength(0);

    fs.holdWrites = false;
    fs.pending?.();
    await vi.waitFor(() => expect(fs.writes).toHaveLength(2));
    expect(JSON.parse(fs.writes[1]?.json ?? "{}").elements).toHaveLength(2);
  });

  it("flushDrawingSave writes immediately and cancels the pending debounce", async () => {
    sessionState();
    drawing.beginDrawingSave(SCENE);
    await drawing.flushDrawingSave();
    expect(fs.writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600);
    expect(fs.writes).toHaveLength(1);
  });

  it("flushing with nothing pending is a silent no-op", async () => {
    await drawing.flushDrawingSave();
    sessionState();
    await drawing.flushDrawingSave();
    expect(fs.writes).toEqual([]);
  });

  it("saving without a session does nothing", async () => {
    drawing.beginDrawingSave(SCENE);
    await vi.advanceTimersByTimeAsync(600);
    expect(fs.writes).toEqual([]);
  });

  it("reports busy spans to subscribers and releases them after a failure too", async () => {
    sessionState();
    const busy: boolean[] = [];
    const off = drawing.subscribeDrawingSave((b) => busy.push(b));
    fs.failWrite = true;

    drawing.beginDrawingSave(SCENE);
    await vi.advanceTimersByTimeAsync(600);

    expect(busy).toEqual([true, false]);
    off();
    fs.failWrite = false;
    drawing.beginDrawingSave({ ...SCENE, elements: [...SCENE.elements, { id: "after" }] });
    await vi.advanceTimersByTimeAsync(600);
    expect(busy).toEqual([true, false]);
  });

  it("exports the preview PNG next to the drawing when elements survive", async () => {
    sessionState();
    drawing.beginDrawingSave(SCENE);
    await vi.advanceTimersByTimeAsync(600);

    expect(fs.pngs).toEqual([{ path: "/v/Excalidraw/d.png", base64: "AQID" }]);
  });

  it("does not export a PNG for an all-deleted scene", async () => {
    sessionState();
    drawing.beginDrawingSave({ ...SCENE, elements: [{ id: "x", isDeleted: true }] });
    await vi.advanceTimersByTimeAsync(600);

    expect(fs.writes).toHaveLength(1);
    expect(fs.pngs).toEqual([]);
  });
});

describe("loadDrawingScene", () => {
  it("reads a plain JSON drawing", async () => {
    const { emptySceneJson } = await import("@/lib/excalidrawFile");
    fs.files.set(DRAWING, emptySceneJson());
    const scene = await drawing.loadDrawingScene(DRAWING);
    expect(scene.elements).toEqual([]);
  });

  it("keeps the Obsidian markdown wrapper so a write-back does not lose it", async () => {
    const { emptySceneJson } = await import("@/lib/excalidrawFile");
    const wrapper = "---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---";
    const path = "/v/Excalidraw/d.excalidraw.md";
    fs.files.set(
      path,
      `${wrapper}\n\n# Excalidraw Data\n\n## Drawing\n\`\`\`json\n${emptySceneJson()}\n\`\`\`\n%%\n`,
    );

    await drawing.loadDrawingScene(path);
    sessionState({ path, isNew: false });
    drawing.beginDrawingSave(SCENE);
    await vi.advanceTimersByTimeAsync(600);

    expect(fs.writes[0]?.json.startsWith(wrapper)).toBe(true);
    expect(fs.writes[0]?.json).toContain("```json");
  });

  it("rejects a malformed scene file instead of producing the wrong drawing", async () => {
    fs.files.set("/v/Excalidraw/bad.excalidraw", "{not json");
    await expect(drawing.loadDrawingScene("/v/Excalidraw/bad.excalidraw")).rejects.toThrow(
      "合法 JSON",
    );
  });

  it("forgets the previous wrapper when another drawing is opened", async () => {
    const { emptySceneJson } = await import("@/lib/excalidrawFile");
    const wrapper = "---\nexcalidraw-plugin: parsed\n---";
    const md = "/v/Excalidraw/old.excalidraw.md";
    fs.files.set(md, `${wrapper}\n\n\`\`\`json\n${emptySceneJson()}\n\`\`\`\n`);
    await drawing.loadDrawingScene(md);

    fs.files.set(DRAWING, emptySceneJson());
    await drawing.loadDrawingScene(DRAWING);
    sessionState();
    drawing.beginDrawingSave(SCENE);
    await vi.advanceTimersByTimeAsync(600);

    expect(fs.writes[0]?.json.startsWith("---")).toBe(false);
    expect(JSON.parse(fs.writes[0]?.json ?? "{}").type).toBe("excalidraw");
  });
});

describe("openNewDrawing", () => {
  it("creates the file in the Excalidraw folder and remembers the origin cursor", async () => {
    editor.view = fakeView("# note\n", 4);

    await drawing.openNewDrawing();

    const session = store.getState().drawingSession;
    expect(session).toMatchObject({ isNew: true, originNote: "/v/note.md", originPos: 4 });
    expect(session?.path.startsWith("/v/Excalidraw/")).toBe(true);
    expect(fs.files.get(session?.path ?? "")).toContain('"type":"excalidraw"');
  });

  it("asks for a note first when there is no open editor", async () => {
    await drawing.openNewDrawing();
    expect(store.getState().drawingSession).toBeNull();
    expect(toasts.messages).toEqual(["先打开一篇笔记,再新建画图"]);
  });

  it("requires an open file, not only a view", async () => {
    editor.view = fakeView("# note\n", 0);
    store.setState({ currentFile: null });
    await drawing.openNewDrawing();
    expect(store.getState().drawingSession).toBeNull();
    expect(toasts.messages).toEqual(["先打开一篇笔记,再新建画图"]);
  });

  it("ignores the shortcut while a canvas is already open", async () => {
    editor.view = fakeView("# note\n", 0);
    sessionState();
    const before = store.getState().drawingSession;

    await drawing.openNewDrawing();

    expect(store.getState().drawingSession).toBe(before);
  });

  it("a failed creation is reported and leaves no session behind", async () => {
    editor.view = fakeView("# note\n", 0);
    fs.failCreate = true;
    await drawing.openNewDrawing();
    expect(store.getState().drawingSession).toBeNull();
    expect(toasts.messages[0]).toContain("新建画图失败");
  });
});

describe("openDrawingFile", () => {
  it("edits an existing embed in place without a fill-back position", () => {
    drawing.openDrawingFile("/v/Excalidraw/old.excalidraw");
    expect(store.getState().drawingSession).toEqual({
      path: "/v/Excalidraw/old.excalidraw",
      isNew: false,
      originNote: "/v/note.md",
      originPos: null,
    });
  });

  it("does not replace an open session", () => {
    sessionState();
    drawing.openDrawingFile("/v/Excalidraw/other.excalidraw");
    expect(store.getState().drawingSession?.path).toBe(DRAWING);
  });
});

describe("finalizeDrawingSession", () => {
  it("an empty new drawing is trashed, not kept as an empty file", async () => {
    sessionState({ originPos: 0 });
    drawing.beginDrawingSave({
      elements: [{ id: "x", isDeleted: true }],
      appState: {},
      files: null,
    });

    await drawing.finalizeDrawingSession();

    expect(fs.trashed).toEqual([DRAWING]);
    expect(actions.saveNote).not.toHaveBeenCalled();
    expect(store.getState().drawingSession).toBeNull();
    expect(actions.refreshTree).toHaveBeenCalledTimes(1);
  });

  it("a drawn new drawing is inserted as an embed at the remembered position and saved", async () => {
    const view = fakeView("# note\n", 0);
    editor.view = view;
    sessionState({ originPos: 0 });
    drawing.beginDrawingSave(SCENE);

    await drawing.finalizeDrawingSession();

    const [edit] = edits(view) as {
      changes: { from: number; insert: string };
      selection: { anchor: number };
    }[];
    expect(edit?.changes.from).toBe(0);
    expect(edit?.changes.insert).toBe("![[d.excalidraw]]\n");
    expect(edit?.selection.anchor).toBe("![[d.excalidraw]]\n".length);
    expect(actions.saveNote).toHaveBeenCalledTimes(1);
  });

  it("inserts on a new line when the cursor sits inside a line", async () => {
    const view = fakeView("# note\n", 3);
    editor.view = view;
    sessionState({ originPos: 3 });
    drawing.beginDrawingSave(SCENE);

    await drawing.finalizeDrawingSession();

    const [edit] = edits(view) as { changes: { insert: string } }[];
    expect(edit?.changes.insert).toBe("\n![[d.excalidraw]]\n");
  });

  it("clamps a cursor past the end of the document (the note shrank meanwhile)", async () => {
    const view = fakeView("# n\n", 0);
    editor.view = view;
    sessionState({ originPos: 99 });
    drawing.beginDrawingSave(SCENE);

    await drawing.finalizeDrawingSession();

    const [edit] = edits(view) as { changes: { from: number } }[];
    expect(edit?.changes.from).toBe(4);
  });

  it("drops the fill-back when the source note is no longer the open document", async () => {
    const view = fakeView("# other\n", 0, "/v/other.md");
    editor.view = view;
    sessionState({ originPos: 0 });
    drawing.beginDrawingSave(SCENE);

    await drawing.finalizeDrawingSession();

    expect(edits(view)).toEqual([]);
  });

  it("drops the fill-back when the origin cursor is gone (an existing drawing)", async () => {
    const view = fakeView("# note\n", 0);
    editor.view = view;
    sessionState({ isNew: true, originPos: null });
    drawing.beginDrawingSave(SCENE);

    await drawing.finalizeDrawingSession();

    expect(edits(view)).toEqual([]);
  });

  it("an existing drawing is never filled back, only refreshed in the asset index", async () => {
    const view = fakeView("# note\n", 0);
    editor.view = view;
    sessionState({ isNew: false, originPos: null });
    drawing.beginDrawingSave(SCENE);

    await drawing.finalizeDrawingSession();

    expect(edits(view)).toEqual([]);
    expect(actions.refreshTree).toHaveBeenCalledTimes(1);
    expect(actions.saveNote).not.toHaveBeenCalled();
  });

  it("nothing happens without a session", async () => {
    await drawing.finalizeDrawingSession();
    expect(actions.refreshTree).not.toHaveBeenCalled();
  });
});

describe("drawingPngPath", () => {
  it("places the preview PNG next to the drawing file", () => {
    expect(drawing.drawingPngPath(DRAWING)).toBe("/v/Excalidraw/d.png");
    expect(drawing.drawingPngPath("/v/Excalidraw/old.excalidraw.md")).toBe("/v/Excalidraw/old.png");
  });

  it("a bare file name stays at the root", () => {
    expect(drawing.drawingPngPath("d.excalidraw")).toBe("d.png");
  });
});

// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { docPathField, setDocPath } from "@/editor/docPath";

/**
 * The interactive half of the ty bridge: completion inside python fences. Four
 * promises are locked here, and each one is a race the module's header claims
 * to close:
 *
 *   - the virtual text is pushed BEFORE the request, so ty answers about the
 *     document the caret is in;
 *   - the same text is never pushed twice;
 *   - the answer is dropped when the document changed while it was in flight;
 *   - prose, pathless editors and projects with the LSP off never reach the
 *     server at all.
 *
 * A real EditorView drives the real extension; jsdom has no layout, which is
 * enough because the sources only read state, selection and document text.
 */

const apiMock = vi.hoisted(() => ({
  pythonLspSync: vi.fn(),
  pythonLspClose: vi.fn(),
  pythonLspRequest: vi.fn(),
}));
const app = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ api: apiMock }));
vi.mock("@/state/appStore", () => ({
  useAppStore: { getState: () => ({ showToast: app.toast }) },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { editorApi } from "@/editor/api";
import { lspHoverText } from "./extract";
import { pythonLspExtension, resetLspStateForPath } from "./lsp";

const DOC = "# note\n\n```python\npri\n```\n";
const PY_LINE_CHAR = 3;

const views: EditorView[] = [];
let pathSeq = 0;

/**
 * Each test owns a unique note path: the module keeps per-path caches (last
 * sent text, the extraction, the disabled list), so a shared path would let
 * one test decide the next one's behavior.
 */
function newPath(): string {
  pathSeq += 1;
  return `/vault/note-${pathSeq}.md`;
}

function mount(doc = DOC, path: string | null = newPath()): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  let state = EditorState.create({ doc, extensions: [docPathField, pythonLspExtension()] });
  if (path !== null) state = state.update({ effects: setDocPath.of(path) }).state;
  const view = new EditorView({ state, parent });
  views.push(view);
  editorApi.view = view;
  return view;
}

function caretAfter(view: EditorView, token: string): void {
  const pos = view.state.doc.toString().indexOf(token) + token.length;
  view.dispatch({ selection: { anchor: pos } });
}

const turn = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Trigger a completion at the caret and let the two async legs (the virtual
 * text push, then the request) run. CodeMirror also needs one turn after the
 * selection before `startCompletion` takes effect.
 */
async function completeAt(view: EditorView, token = "pri"): Promise<void> {
  caretAfter(view, token);
  await turn(10);
  startCompletion(view);
  await turn();
}

beforeAll(() => {
  // The extension factory is the entry point the editor setup uses; the
  // backend event listeners install on first use.
  pythonLspExtension();
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.pythonLspSync.mockResolvedValue({ enabled: true });
  apiMock.pythonLspClose.mockResolvedValue(undefined);
  apiMock.pythonLspRequest.mockResolvedValue({
    items: [{ label: "print", detail: "builtin" }],
  });
});

afterEach(async () => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
  editorApi.view = null;
  // Drain the async legs of the finished test before the next one resets.
  await turn(30);
});

describe("completion inside a python fence", () => {
  it("pushes the current virtual text before asking for completions", async () => {
    const path = newPath();
    const view = mount(DOC, path);

    await completeAt(view);

    expect(apiMock.pythonLspSync).toHaveBeenCalledWith(path, "\n\n\npri\n\n");
    expect(apiMock.pythonLspRequest).toHaveBeenCalledWith(path, "textDocument/completion", {
      position: { line: 3, character: PY_LINE_CHAR },
    });
    expect(completionStatus(view.state)).toBe("active");
  });

  it("does not push the virtual text again when it is already current", async () => {
    const view = mount();
    await completeAt(view);
    vi.clearAllMocks();

    // The caret moves inside the same fence: the text ty sees is unchanged.
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("pri") + 1 } });
    await turn(10);
    startCompletion(view);
    await turn();

    expect(apiMock.pythonLspSync).not.toHaveBeenCalled();
    expect(apiMock.pythonLspRequest).toHaveBeenCalledTimes(1);
  });

  it("prose outside a fence never reaches the server", async () => {
    const view = mount("# note\n\njust prose here\n");

    await completeAt(view, "prose");

    expect(apiMock.pythonLspSync).not.toHaveBeenCalled();
    expect(apiMock.pythonLspRequest).not.toHaveBeenCalled();
  });

  it("an editor without a document path is skipped (the study middle column)", async () => {
    const view = mount(DOC, null);

    await completeAt(view);

    expect(apiMock.pythonLspSync).not.toHaveBeenCalled();
    expect(apiMock.pythonLspRequest).not.toHaveBeenCalled();
  });

  it("an empty completion answer produces no panel", async () => {
    apiMock.pythonLspRequest.mockResolvedValue({ items: [] });
    const view = mount();

    await completeAt(view);

    expect(completionStatus(view.state)).not.toBe("active");
  });

  it("a request failure is silent (no panel, no toast)", async () => {
    apiMock.pythonLspRequest.mockRejectedValue("server down");
    const view = mount();

    await completeAt(view);

    expect(completionStatus(view.state)).not.toBe("active");
    expect(app.toast).not.toHaveBeenCalled();
  });

  it("an answer that arrives after the document changed is dropped", async () => {
    // The answer is held open on purpose: the edit has to happen WHILE the
    // request is in flight, which is the race the module guards against.
    const gate: { answer: ((value: unknown) => void) | null } = { answer: null };
    apiMock.pythonLspRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.answer = resolve;
        }),
    );

    const view = mount();
    caretAfter(view, "pri");
    await turn(10);
    startCompletion(view);
    await vi.waitFor(() => expect(apiMock.pythonLspRequest).toHaveBeenCalled());

    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" } });
    gate.answer?.({ items: [{ label: "stale.print" }] });
    await turn();

    expect(completionStatus(view.state)).not.toBe("active");
  });

  it("a project with the LSP disabled is not asked again", async () => {
    apiMock.pythonLspSync.mockResolvedValue({ enabled: false });
    const view = mount();

    await completeAt(view);
    expect(apiMock.pythonLspSync).toHaveBeenCalled();
    expect(apiMock.pythonLspRequest).not.toHaveBeenCalled();

    // From now on the path sits on the do-not-disturb list, so neither the
    // sync nor the request may be attempted again until the config switch
    // clears it with resetLspStateForPath.
    vi.clearAllMocks();
    startCompletion(view);
    await turn();
    expect(apiMock.pythonLspSync).not.toHaveBeenCalled();
    expect(apiMock.pythonLspRequest).not.toHaveBeenCalled();
  });
});

describe("hover replies", () => {
  it("strips the fences of a markdown hover so the tooltip shows code, not markdown", () => {
    expect(
      lspHoverText({ contents: { kind: "markdown", value: "```python\nint\n```\nbuiltin int" } }),
    ).toBe("int\nbuiltin int");
  });

  it("joins the parts of a MarkedString array and drops empty ones", () => {
    expect(lspHoverText({ contents: ["int", "", { kind: "plaintext", value: "builtin" }] })).toBe(
      "int\n\nbuiltin",
    );
  });

  it("an empty or malformed reply has no text (the tooltip must not open)", () => {
    expect(lspHoverText(null)).toBeNull();
    expect(lspHoverText({})).toBeNull();
    expect(lspHoverText({ contents: "   " })).toBeNull();
    expect(lspHoverText({ contents: [42] })).toBeNull();
  });
});

describe("resetting a path", () => {
  it("clears the disabled state so the next request goes through again", async () => {
    apiMock.pythonLspSync.mockResolvedValue({ enabled: false });
    const path = newPath();
    const view = mount(DOC, path);
    await completeAt(view);
    expect(apiMock.pythonLspRequest).not.toHaveBeenCalled();

    resetLspStateForPath(path);
    apiMock.pythonLspSync.mockResolvedValue({ enabled: true });
    startCompletion(view);
    await turn();

    expect(apiMock.pythonLspRequest).toHaveBeenCalled();
  });

  it("closing a path that never had an LSP session is harmless", () => {
    apiMock.pythonLspClose.mockRejectedValue("nothing to close");
    expect(() => resetLspStateForPath("/vault/never.md")).not.toThrow();
  });
});

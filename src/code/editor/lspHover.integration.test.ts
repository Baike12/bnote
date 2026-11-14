// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, activateHover, hasHoverTooltips } from "@codemirror/view";

/**
 * The hover tooltip shows the language server's MarkupContent **as text**.
 * A server may answer with markdown; injecting it as HTML is an injection
 * surface (the content comes from a repository the user did not write), so the
 * DOM must contain the markup as text nodes. An empty answer or a failed
 * request must not open an empty box.
 */

const mocks = vi.hoisted(() => ({ lspRequest: vi.fn() }));

vi.mock("../api", () => ({ codeApi: { lspRequest: mocks.lspRequest } }));
vi.mock("../store", () => ({ useCodeStore: { getState: () => ({ diagnostics: {} }) } }));

import { lspHoverTooltip } from "./lsp";
import { registerCodeEditor, unregisterCodeEditor, type CodeEditorHandle } from "./registry";

const views: EditorView[] = [];
const handles: CodeEditorHandle[] = [];

function mount(): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: "abc\ndef\n", extensions: [lspHoverTooltip] }),
    parent,
  });
  views.push(view);
  const handle = {
    root: "/proj",
    path: "src/a.ts",
    language: "typescript",
    view,
  } as unknown as CodeEditorHandle;
  handles.push(handle);
  registerCodeEditor(handle);
  return view;
}

/** jsdom has no layout: the tooltip only needs a position, not real glyphs. */
function stubGeometry(view: EditorView): void {
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 0, top: 0, bottom: 10 });
}

/** Ask for the tooltip at `pos` and wait for the server's answer to be drawn. */
async function hover(view: EditorView, pos = 1): Promise<string | null> {
  activateHover(view, pos, 1);
  await vi.waitFor(
    () => {
      const answered = mocks.lspRequest.mock.calls.length > 0;
      expect(answered).toBe(true);
    },
    { timeout: 2000, interval: 20 },
  );
  await Promise.resolve();
  await Promise.resolve();
  return document.querySelector(".cm-code-hover")?.outerHTML ?? null;
}

beforeEach(() => {
  mocks.lspRequest.mockReset();
});

afterEach(() => {
  for (const handle of handles.splice(0)) unregisterCodeEditor(handle);
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("the hover tooltip", () => {
  it("renders the server's markdown as escaped text, one line per row", async () => {
    const view = mount();
    stubGeometry(view);
    mocks.lspRequest.mockResolvedValue({
      contents: { kind: "markdown", value: "**bold**\n<script>x</script>" },
    });
    expect(await hover(view)).toBe(
      '<div class="cm-code-hover cm-tooltip-section"><div>**bold**</div><div>&lt;script&gt;x&lt;/script&gt;</div></div>',
    );
    expect(mocks.lspRequest).toHaveBeenCalledWith(
      "/proj",
      "typescript",
      "textDocument/hover",
      "src/a.ts",
      { position: { line: 0, character: 1 } },
    );
  });

  it("an empty answer opens no tooltip", async () => {
    const view = mount();
    stubGeometry(view);
    mocks.lspRequest.mockResolvedValue({ contents: "" });
    expect(await hover(view)).toBeNull();
    expect(hasHoverTooltips(view.state)).toBe(false);
  });

  it("a failed request opens no tooltip instead of an error", async () => {
    const view = mount();
    stubGeometry(view);
    mocks.lspRequest.mockRejectedValue(new Error("LSP_NOT_RUNNING"));
    expect(await hover(view)).toBeNull();
  });

  it("a view without a registered file never reaches the server", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "abc\n", extensions: [lspHoverTooltip] }),
      parent,
    });
    views.push(view);
    stubGeometry(view);
    activateHover(view, 1, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.lspRequest).not.toHaveBeenCalled();
  });
});

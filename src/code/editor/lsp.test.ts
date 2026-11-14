import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState, type Text } from "@codemirror/state";

/**
 * The bridge between the language server and CodeMirror.
 *
 * Three promises are locked here, each one a user-visible failure when broken:
 * the candidate a server returns becomes the text that is actually inserted
 * (the `textEdit` range wins over the typed word), the request is only sent
 * when there is something to complete (a punctuation keystroke must not spawn
 * one), and a dead server yields no popup instead of an error.
 */

const mocks = vi.hoisted(() => ({
  lspRequest: vi.fn(),
  diagnostics: {} as Record<string, unknown[]>,
  forceLinting: vi.fn(),
}));

vi.mock("../api", () => ({ codeApi: { lspRequest: mocks.lspRequest } }));
vi.mock("../store", () => ({
  useCodeStore: { getState: () => ({ diagnostics: mocks.diagnostics }) },
}));
vi.mock("@codemirror/lint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codemirror/lint")>()),
  forceLinting: mocks.forceLinting,
}));

import {
  documentationToText,
  lspCompletion,
  refreshDiagnostics,
  toCmDiagnostic,
  toCompletion,
} from "./lsp";
import { registerCodeEditor, unregisterCodeEditor, type CodeEditorHandle } from "./registry";
import type { LspDiagnostic } from "../types";

const DOC = "const value = obj\n";

function stateOf(doc = DOC): EditorState {
  return EditorState.create({ doc });
}

let handle: CodeEditorHandle | null = null;

function register(doc = DOC): EditorState {
  const state = stateOf(doc);
  handle = {
    root: "/proj",
    path: "src/a.ts",
    language: "typescript",
    view: { state, dom: { isConnected: true } },
  } as unknown as CodeEditorHandle;
  registerCodeEditor(handle);
  return state;
}

function contextAt(state: EditorState, pos: number, explicit = false): CompletionContext {
  return new CompletionContext(state, pos, explicit);
}

beforeEach(() => {
  mocks.lspRequest.mockReset();
  mocks.forceLinting.mockReset();
  mocks.diagnostics = {};
});

afterEach(() => {
  if (handle) unregisterCodeEditor(handle);
  handle = null;
});

describe("documentationToText", () => {
  it("passes a plain string through", () => {
    expect(documentationToText("docs")).toBe("docs");
  });

  it("joins the array form with a blank line, dropping empty entries", () => {
    expect(documentationToText(["a", { value: "b" }, "", null, "c"])).toBe("a\n\nb\n\nc");
  });

  it("reads the MarkupContent value", () => {
    expect(documentationToText({ kind: "markdown", value: "`x` is a number" })).toBe(
      "`x` is a number",
    );
  });

  it("returns an empty string for anything it cannot read", () => {
    expect(documentationToText(null)).toBe("");
    expect(documentationToText(undefined)).toBe("");
    expect(documentationToText(42)).toBe("");
    expect(documentationToText({ value: 42 })).toBe("");
  });
});

describe("toCmDiagnostic", () => {
  const doc = () => stateOf("abc\ndef\n") as unknown as { doc: Text };

  function diagnostic(over: Partial<LspDiagnostic>): LspDiagnostic {
    return {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      code: null,
      source: null,
      message: "boom",
      ...over,
    };
  }

  it("maps the LSP severity onto the editor's", () => {
    const text = doc().doc;
    for (const [severity, expected] of [
      [1, "error"],
      [2, "warning"],
      [3, "info"],
      [4, "hint"],
    ] as const) {
      expect(toCmDiagnostic(diagnostic({ severity }), text).severity).toBe(expected);
    }
    expect(toCmDiagnostic(diagnostic({ severity: 9 }), text).severity).toBe("error");
    expect(toCmDiagnostic(diagnostic({ severity: 0 }), text).severity).toBe("error");
  });

  it("converts the range to document offsets", () => {
    const text = doc().doc;
    const out = toCmDiagnostic(
      diagnostic({ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } } }),
      text,
    );
    expect(out).toMatchObject({ from: 5, to: 7, message: "boom" });
  });

  it("a range-less diagnostic collapses to the document start instead of throwing", () => {
    const text = doc().doc;
    const out = toCmDiagnostic(
      { ...diagnostic({}), range: undefined as unknown as LspDiagnostic["range"] },
      text,
    );
    expect(out).toMatchObject({ from: 0, to: 0 });
  });

  it("a missing source stays undefined, not null", () => {
    const out = toCmDiagnostic(diagnostic({ source: null }), doc().doc);
    expect(out.source).toBeUndefined();
    expect(toCmDiagnostic(diagnostic({ source: "ts" }), doc().doc).source).toBe("ts");
  });
});

describe("toCompletion", () => {
  it("an item without a label cannot be completed", () => {
    expect(toCompletion({})).toBeNull();
    expect(toCompletion({ label: 42 })).toBeNull();
  });

  it("maps the item kind onto the editor's completion type", () => {
    for (const [kind, type] of [
      [1, "text"],
      [2, "method"],
      [3, "function"],
      [7, "class"],
      [12, "constant"],
      [14, "keyword"],
      [15, "snippet"],
      [24, "operator"],
    ] as const) {
      expect(toCompletion({ label: "x", kind }), String(kind)).toMatchObject({ type });
    }
    expect(toCompletion({ label: "x", kind: 99 })).toMatchObject({ type: "text" });
    expect(toCompletion({ label: "x" })).toMatchObject({ type: "text" });
  });

  it("carries the detail, the documentation and the preselect boost", () => {
    const completion = toCompletion({
      label: "value",
      detail: "number",
      documentation: { kind: "markdown", value: "the value" },
      preselect: true,
    });
    expect(completion).toMatchObject({
      label: "value",
      detail: "number",
      info: "the value",
      boost: 1,
    });
    expect(toCompletion({ label: "value" })).toMatchObject({ boost: 0 });
    expect(toCompletion({ label: "value" })).not.toHaveProperty("info");
  });

  it("the textEdit range decides what the insertion replaces", () => {
    const completion = toCompletion({
      label: "value",
      textEdit: {
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } },
        newText: "obj.value",
      },
    });
    expect(completion?.apply).toBeTypeOf("function");
    const dispatch = vi.fn();
    const view = {
      state: stateOf(DOC),
      dispatch,
    };
    // The signature is CodeMirror's own; the test only exercises the parts a
    // real call passes.
    type Apply = (view: unknown, completion: unknown, from: number, to: number) => void;
    (completion?.apply as Apply)(view, completion, 14, 17);
    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 14, to: 17, insert: "obj.value" },
      selection: { anchor: 14 + "obj.value".length },
      userEvent: "input.complete",
    });
  });

  it("an insertText that differs from the label becomes the applied text", () => {
    expect(toCompletion({ label: "len", insertText: "len(" })?.apply).toBe("len(");
  });

  it("the legacy textEditText field is honoured the same way", () => {
    expect(toCompletion({ label: "len", textEditText: "len(" })?.apply).toBe("len(");
  });

  it("an insertion identical to the label is left to CodeMirror", () => {
    expect(toCompletion({ label: "len", insertText: "len" })).not.toHaveProperty("apply");
    expect(toCompletion({ label: "len", textEditText: "len" })).not.toHaveProperty("apply");
  });
});

describe("lspCompletion", () => {
  it("asks only when a word has been typed", async () => {
    const state = register("const va");
    mocks.lspRequest.mockResolvedValue([{ label: "value" }]);
    const result = await lspCompletion(contextAt(state, state.doc.length));
    expect(mocks.lspRequest).toHaveBeenCalledWith(
      "/proj",
      "typescript",
      "textDocument/completion",
      "src/a.ts",
      { position: { line: 0, character: 8 }, context: { triggerKind: 1 } },
    );
    expect(result).toMatchObject({ from: 6, options: [{ label: "value" }] });
  });

  it("does not bother the server on a bare punctuation keystroke", async () => {
    const state = register("const x = 1;");
    const result = await lspCompletion(contextAt(state, state.doc.length));
    expect(result).toBeNull();
    expect(mocks.lspRequest).not.toHaveBeenCalled();
  });

  it("a trigger character with no word yet still asks, with the LSP trigger kind", async () => {
    const state = register("obj.");
    mocks.lspRequest.mockResolvedValue({ items: [{ label: "value" }] });
    const result = await lspCompletion(contextAt(state, state.doc.length));
    expect(mocks.lspRequest).toHaveBeenCalledWith(
      "/proj",
      "typescript",
      "textDocument/completion",
      "src/a.ts",
      {
        position: { line: 0, character: 4 },
        context: { triggerKind: 2, triggerCharacter: "." },
      },
    );
    expect(result).not.toBeNull();
  });

  it("an explicit request without a trigger character is Invoked", async () => {
    const state = register("obj. ");
    mocks.lspRequest.mockResolvedValue([{ label: "value" }]);
    const result = await lspCompletion(contextAt(state, state.doc.length, true));
    expect(mocks.lspRequest).toHaveBeenCalledWith(
      "/proj",
      "typescript",
      "textDocument/completion",
      "src/a.ts",
      { position: { line: 0, character: 5 }, context: { triggerKind: 1 } },
    );
    expect(result?.from).toBe(state.doc.length);
  });

  it("no active editor means no request", async () => {
    if (handle) unregisterCodeEditor(handle);
    handle = null;
    const state = stateOf("const va");
    expect(await lspCompletion(contextAt(state, state.doc.length))).toBeNull();
    expect(mocks.lspRequest).not.toHaveBeenCalled();
  });

  it("a dead server yields no popup instead of an error", async () => {
    const state = register("const va");
    mocks.lspRequest.mockRejectedValue(new Error("LSP_NOT_RUNNING"));
    expect(await lspCompletion(contextAt(state, state.doc.length))).toBeNull();
  });

  it("a null or empty answer yields no popup", async () => {
    const state = register("const va");
    mocks.lspRequest.mockResolvedValue(null);
    expect(await lspCompletion(contextAt(state, state.doc.length))).toBeNull();
    mocks.lspRequest.mockResolvedValue([]);
    expect(await lspCompletion(contextAt(state, state.doc.length))).toBeNull();
    mocks.lspRequest.mockResolvedValue({ items: [] });
    expect(await lspCompletion(contextAt(state, state.doc.length))).toBeNull();
  });

  it("items without a label are dropped instead of becoming empty rows", async () => {
    const state = register("const va");
    mocks.lspRequest.mockResolvedValue([{ detail: "no label" }, { label: "value" }]);
    const result = await lspCompletion(contextAt(state, state.doc.length));
    expect(result?.options).toEqual([
      { label: "value", detail: undefined, type: "text", boost: 0 },
    ]);
  });

  it("an answer made only of unusable items is no result", async () => {
    const state = register("const va");
    mocks.lspRequest.mockResolvedValue([{}, { label: 1 }]);
    expect(await lspCompletion(contextAt(state, state.doc.length))).toBeNull();
  });
});

describe("refreshDiagnostics", () => {
  it("asks the linter to run again for a live view", () => {
    const view = { state: stateOf(), dom: { isConnected: true } };
    refreshDiagnostics(view as unknown as Parameters<typeof refreshDiagnostics>[0]);
    expect(mocks.forceLinting).toHaveBeenCalledTimes(1);
  });

  it("no view is not an error", () => {
    refreshDiagnostics(null);
    expect(mocks.forceLinting).not.toHaveBeenCalled();
  });
});

describe("lspCompletion: the answer shapes", () => {
  it("an object without an items array is an empty answer, not a crash", async () => {
    const state = register("const va");
    mocks.lspRequest.mockResolvedValue({ result: [] });
    expect(await lspCompletion(contextAt(state, state.doc.length))).toBeNull();
    mocks.lspRequest.mockResolvedValue("nope");
    expect(await lspCompletion(contextAt(state, state.doc.length))).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";

/**
 * The diagnostics the backend pushes are cut into the editor by a linter. The
 * source runs per view, so it has to find the file **by the view** (the
 * focused one may be another tab, or none at all): reading "the active editor"
 * lands the marks under the wrong file, and an unknown file must yield no marks
 * rather than the last file's.
 */

const mocks = vi.hoisted(() => ({ diagnostics: {} as Record<string, unknown[]> }));

vi.mock("../api", () => ({ codeApi: { lspRequest: vi.fn() } }));
vi.mock("../store", () => ({
  useCodeStore: { getState: () => ({ diagnostics: mocks.diagnostics }) },
}));

import { lspDiagnosticsLinter, refreshDiagnostics } from "./lsp";
import { registerCodeEditor, unregisterCodeEditor, type CodeEditorHandle } from "./registry";

const views: EditorView[] = [];
const handles: CodeEditorHandle[] = [];

function mount(path: string, doc = "abc\ndef\nghi\n"): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [lspDiagnosticsLinter] }),
    parent,
  });
  views.push(view);
  const handle = {
    root: "/proj",
    path,
    language: "typescript",
    view,
  } as unknown as CodeEditorHandle;
  handles.push(handle);
  registerCodeEditor(handle);
  return view;
}

interface Mark {
  from: number;
  to: number;
  message: string;
  severity: string | undefined;
}

async function marks(view: EditorView): Promise<Mark[]> {
  // The linter runs on a 120 ms delay once the view is mounted; the wait is
  // the editor's own scheduling, not a synchronization guess.
  await vi.waitFor(
    () => {
      const found = collect(view);
      expect(found.length).toBeGreaterThan(0);
    },
    { timeout: 2000, interval: 20 },
  );
  return collect(view);
}

function collect(view: EditorView): Mark[] {
  const found: Mark[] = [];
  forEachDiagnostic(view.state, (d, from, to) => {
    found.push({ from, to, message: d.message, severity: d.severity });
  });
  return found;
}

afterEach(() => {
  for (const handle of handles.splice(0)) unregisterCodeEditor(handle);
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  mocks.diagnostics = {};
});

describe("the diagnostics linter", () => {
  it("marks the pushed diagnostic of its own file", async () => {
    mocks.diagnostics = {
      "src/a.ts": [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          severity: 2,
          code: null,
          source: "ts",
          message: "unused",
        },
      ],
    };
    const view = mount("src/a.ts");
    expect(await marks(view)).toEqual([{ from: 4, to: 7, message: "unused", severity: "warning" }]);
  });

  it("a view whose file has no diagnostics gets no marks, even when another file has some", async () => {
    mocks.diagnostics = {
      "src/other.ts": [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          code: null,
          source: null,
          message: "wrong file",
        },
      ],
    };
    const view = mount("src/a.ts");
    // Give the linter its delay; the marks must still be absent.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(collect(view)).toEqual([]);
  });

  it("a push while a lint run is pending is drawn without waiting out the delay", async () => {
    mocks.diagnostics = {};
    const view = mount("src/a.ts");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(collect(view)).toEqual([]);
    mocks.diagnostics = {
      "src/a.ts": [
        {
          range: { start: { line: 2, character: 1 }, end: { line: 2, character: 2 } },
          severity: 4,
          code: null,
          source: null,
          message: "hint",
        },
      ],
    };
    // Typing schedules the next lint; the forced run is what makes the push
    // visible now instead of one debounce later. The appended character sits
    // after the marked line, so the offsets stay where the diagnostic named
    // them.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    refreshDiagnostics(view);
    await Promise.resolve();
    await Promise.resolve();
    const found = collect(view);
    expect(found).toEqual([{ from: 9, to: 10, message: "hint", severity: "hint" }]);
  });
});

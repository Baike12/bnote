// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { docPathField, setDocPath } from "@/editor/docPath";

vi.mock("@/lib/tauri", () => ({ api: {} }));

import { TODO_DRAG_MIME, projectTodoDragExtension } from "./drag";

/**
 * The drag gutter is the mouse half of "send this todo to today": it must
 * appear only on todo lines, and the payload it puts on the dataTransfer must
 * name the card and the line (the drop target resolves the text from the card
 * path, not from the clipboard). The pure codec is covered in drag.test.ts;
 * this file locks the wiring that decides which lines get a handle at all.
 */

const views: EditorView[] = [];

function mount(doc: string, path = "/vault/.bnote/projects-manager/读书.md"): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  let state = EditorState.create({ doc, extensions: [docPathField, projectTodoDragExtension()] });
  state = state.update({ effects: setDocPath.of(path) }).state;
  const view = new EditorView({ state, parent });
  views.push(view);
  return view;
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

describe("the todo drag gutter", () => {
  it("renders one handle per todo line and none for prose", async () => {
    const view = mount("- [ ] 甲\n正文\n  - [x] 乙\n- 普通项目\n");
    await turn();

    const handles = view.dom.querySelectorAll(".cm-project-drag-handle");
    expect(handles).toHaveLength(2);
  });

  it("a note without todos gets no handle", async () => {
    const view = mount("# 标题\n\n正文\n");
    await turn();
    expect(view.dom.querySelectorAll(".cm-project-drag-handle")).toHaveLength(0);
  });

  it("dragstart writes the card path, the line number and the line text", async () => {
    const view = mount("# 标题\n- [ ] 甲\n");
    await turn();

    const handle = view.dom.querySelector(".cm-project-drag-handle");
    expect(handle).not.toBeNull();
    const setData = vi.fn();
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { setData, effectAllowed: "none" },
    });

    handle?.dispatchEvent(event);

    expect(setData).toHaveBeenCalledWith(
      TODO_DRAG_MIME,
      JSON.stringify({ srcPath: "/vault/.bnote/projects-manager/读书.md", line: 2 }),
    );
    expect(setData).toHaveBeenCalledWith("text/plain", "- [ ] 甲");
  });

  it("without a document path the drag carries no payload (the drop would be unverifiable)", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc: "- [ ] 甲\n",
      extensions: [docPathField, projectTodoDragExtension()],
    });
    const view = new EditorView({ state, parent });
    views.push(view);
    await turn();

    const handle = view.dom.querySelector(".cm-project-drag-handle");
    const setData = vi.fn();
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: { setData, effectAllowed: "none" } });

    handle?.dispatchEvent(event);

    expect(setData).not.toHaveBeenCalled();
  });
});

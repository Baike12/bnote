import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { readOnlyExtensions } from "./readOnly";

/**
 * A read-only file must stay **navigable**: the bug this locks is the one where
 * `EditorView.editable(false)` made the document unfocusable and vim motions
 * stopped moving the cursor.
 */
describe("readOnlyExtensions", () => {
  const state = (external: boolean) =>
    EditorState.create({ doc: "one\ntwo\nthree", extensions: readOnlyExtensions(external) });

  it("marks the state read-only", () => {
    expect(state(true).readOnly).toBe(true);
    expect(state(false).readOnly).toBe(false);
  });

  it("drops a transaction that would change the document", () => {
    const s = state(true);
    const next = s.update({ changes: { from: 0, insert: "x" } });
    expect(next.state.doc.toString()).toBe("one\ntwo\nthree");
  });

  it("lets selection and scrolling through, so motions keep working", () => {
    const s = state(true);
    const next = s.update({ selection: { anchor: 9 } });
    expect(next.state.selection.main.head).toBe(9);
    expect(next.state.doc.toString()).toBe("one\ntwo\nthree");
  });

  it("adds nothing for a project file", () => {
    const s = state(false);
    const next = s.update({ changes: { from: 0, insert: "x" } });
    expect(next.state.doc.toString()).toBe("xone\ntwo\nthree");
  });
});

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { activeLineDecos } from "./vim";

/**
 * Gate: the visibility criterion for the active line shade must match the
 * engine's block cursor (`cm-vimMode` class) verbatim — `!insertMode || overwrite`.
 * A regression has two shapes: shade emitted again in insert mode (the criterion
 * was written back as highlightActiveLine's unconditional paint), or gating on the
 * scroller's `.cm-vimMode` ancestor class (the wide-scope invalidation comes
 * back and Esc/i wraps the whole viewport subtree every time).
 */

const state = (cursors: number[]) =>
  EditorState.create({
    doc: "第一行\n第二行\n第三行\n",
    // Multiple selections only survive EditorState.create with this facet
    // enabled — the same wiring as the real setup.ts assembly (vim blockwise
    // depends on the same one).
    extensions: [EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create(cursors.map((h) => EditorSelection.cursor(h))),
  });

describe("activeLine decorations", () => {
  it("insert mode (no block cursor) emits no decoration", () => {
    expect(activeLineDecos(state([4]), false).size).toBe(0);
  });

  it("block cursor mode hangs cm-activeLine on the head line (a zero-width decoration at the line start)", () => {
    const decos = activeLineDecos(state([4]), true);
    expect(decos.size).toBe(1);
    const cursor = decos.iter();
    expect(cursor.from).toBe(4); // start of the second line
    expect(cursor.to).toBe(4);
    const spec = cursor.value?.spec as { class: string } | undefined;
    expect(spec?.class).toContain("cm-activeLine");
  });

  it("multiple ranges on one line are deduplicated, ranges on different lines get one each", () => {
    expect(activeLineDecos(state([1, 2]), true).size).toBe(1); // both on the first line
    expect(activeLineDecos(state([1, 5]), true).size).toBe(2); // first/second line
  });
});

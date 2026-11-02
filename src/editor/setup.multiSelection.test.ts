import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { baseExtensions } from "./setup";

/**
 * The editor must allow multiple selections — that is the precondition for vim
 * blockwise (Ctrl-V). The engine's block model is "one range per line": y/d/c/p
 * run per range through Vim.forEachSelection (reading cm.listSelections()), and
 * the per-line insert/delete of a block selection is built on multiple ranges
 * too. CM6 disables allowMultipleSelections by default, so any multi-range
 * selection is collapsed to the main range by tr.newSelection.asSingle() when
 * the transaction lands — the block then paints three full lines while pressing
 * y copies only the caret's line (the drawing and the copy disagree).
 *
 * What this gate locks is the **configuration itself**: the symptom only shows
 * up when y/d is really pressed, geometry and unit tests cannot see it, and
 * dropping the facet does not turn any other test red.
 */

const doc = ["abcdefghij", "klmno", "pqrstuvwxy"].join("\n");

const newState = () =>
  EditorState.create({
    doc,
    extensions: baseExtensions({ onDocChanged() {}, onCursorMoved() {} }),
  });

describe("editor configuration: multiple ranges (the precondition for vim blockwise)", () => {
  it("a three-range selection over three lines lands as is (not collapsed to the main range by asSingle, the main index is kept)", () => {
    const next = newState().update({
      selection: EditorSelection.create(
        [
          EditorSelection.range(2, 7),
          EditorSelection.range(13, 16),
          EditorSelection.range(19, 24),
        ],
        2,
      ),
    }).state;
    expect(next.selection.ranges.map((r) => `${r.from}..${r.to}`)).toEqual([
      "2..7",
      "13..16",
      "19..24",
    ]);
    expect(next.selection.mainIndex).toBe(2);
  });

  it("a single range selection is unaffected (the ordinary editing / mouse selection path stays as before)", () => {
    const next = newState().update({ selection: { anchor: 3, head: 6 } }).state;
    expect(next.selection.ranges.length).toBe(1);
    expect(next.selection.main.from).toBe(3);
    expect(next.selection.main.to).toBe(6);
  });
});

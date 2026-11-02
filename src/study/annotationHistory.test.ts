import { describe, expect, it } from "vitest";
import {
  createAnnotationHistory,
  recordAnnotationHistory,
  redoAnnotationHistory,
  resetAnnotationHistory,
  undoAnnotationHistory,
} from "./annotationHistory";

describe("the annotation undo stack", () => {
  it("undo returns to the state before the change, redo returns to the state after it", () => {
    const history = createAnnotationHistory<string[]>();
    recordAnnotationHistory(history, ["a"]);
    // The current state is ["a","b"]; undo returns ["a"], redo returns ["a","b"].
    expect(undoAnnotationHistory(history, ["a", "b"])).toEqual(["a"]);
    expect(redoAnnotationHistory(history, ["a"])).toEqual(["a", "b"]);
    expect(undoAnnotationHistory(history, ["a", "b"])).toEqual(["a"]);
    expect(undoAnnotationHistory(history, ["a"])).toBeNull();
  });

  it("a new change clears the redo stack", () => {
    const history = createAnnotationHistory<string[]>();
    recordAnnotationHistory(history, ["a"]);
    const undone = undoAnnotationHistory(history, ["a", "b"]);
    expect(undone).toEqual(["a"]);
    recordAnnotationHistory(history, undone!);
    expect(redoAnnotationHistory(history, ["c"])).toBeNull();
    expect(undoAnnotationHistory(history, ["c"])).toEqual(["a"]);
  });

  it("the cap drops the oldest snapshot, reset clears both stacks", () => {
    const history = createAnnotationHistory<number>(2);
    recordAnnotationHistory(history, 1);
    recordAnnotationHistory(history, 2);
    recordAnnotationHistory(history, 3);
    expect(undoAnnotationHistory(history, 4)).toBe(3);
    expect(undoAnnotationHistory(history, 3)).toBe(2);
    expect(undoAnnotationHistory(history, 2)).toBeNull();
    resetAnnotationHistory(history);
    expect(history.undo).toEqual([]);
    expect(history.redo).toEqual([]);
  });
});

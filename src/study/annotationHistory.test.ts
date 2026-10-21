import { describe, expect, it } from "vitest";
import {
  createAnnotationHistory,
  recordAnnotationHistory,
  redoAnnotationHistory,
  resetAnnotationHistory,
  undoAnnotationHistory,
} from "./annotationHistory";

describe("批注撤销栈", () => {
  it("撤销回到改动前,重做回到改动后", () => {
    const history = createAnnotationHistory<string[]>();
    recordAnnotationHistory(history, ["a"]);
    // 当前状态是 ["a","b"];撤销返回 ["a"],重做返回 ["a","b"]。
    expect(undoAnnotationHistory(history, ["a", "b"])).toEqual(["a"]);
    expect(redoAnnotationHistory(history, ["a"])).toEqual(["a", "b"]);
    expect(undoAnnotationHistory(history, ["a", "b"])).toEqual(["a"]);
    expect(undoAnnotationHistory(history, ["a"])).toBeNull();
  });

  it("新改动清空重做栈", () => {
    const history = createAnnotationHistory<string[]>();
    recordAnnotationHistory(history, ["a"]);
    const undone = undoAnnotationHistory(history, ["a", "b"]);
    expect(undone).toEqual(["a"]);
    recordAnnotationHistory(history, undone!);
    expect(redoAnnotationHistory(history, ["c"])).toBeNull();
    expect(undoAnnotationHistory(history, ["c"])).toEqual(["a"]);
  });

  it("上限丢弃最老快照,重置清空两栈", () => {
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

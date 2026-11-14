import { describe, expect, it } from "vitest";
import { onCodeUiRequest, requestCodeUi, type CodeUiRequest } from "./ui";

/**
 * The command layer asks the panel to open the quick-open box, find-in-files
 * or the rename dialog without holding its DOM. The contract is "exactly
 * once": a second subscriber must not see a request that already ran, and a
 * request issued with no panel mounted must not be replayed into a later one
 * (that would open a dialog the user never asked for).
 */
describe("the code panel request channel", () => {
  it("delivers a request to every subscriber", () => {
    const seen: CodeUiRequest[] = [];
    const offA = onCodeUiRequest((r) => seen.push(r));
    const offB = onCodeUiRequest((r) => seen.push(r));
    requestCodeUi({ kind: "quick-open" });
    offA();
    offB();
    expect(seen).toEqual([{ kind: "quick-open" }, { kind: "quick-open" }]);
  });

  it("an unsubscribed listener is no longer called", () => {
    const seen: CodeUiRequest[] = [];
    const off = onCodeUiRequest((r) => seen.push(r));
    off();
    requestCodeUi({ kind: "rename" });
    expect(seen).toEqual([]);
  });

  it("a request is never replayed into a later subscriber", () => {
    requestCodeUi({ kind: "find-in-files" });
    const seen: CodeUiRequest[] = [];
    const off = onCodeUiRequest((r) => seen.push(r));
    off();
    expect(seen).toEqual([]);
  });

  it("a listener that unsubscribes during delivery still receives the request once", () => {
    const seen: string[] = [];
    const off = onCodeUiRequest((r) => {
      seen.push(`self:${r.kind}`);
      off();
    });
    const offOther = onCodeUiRequest(() => seen.push("other"));
    requestCodeUi({ kind: "quick-open" });
    offOther();
    expect(seen).toEqual(["self:quick-open", "other"]);
  });
});

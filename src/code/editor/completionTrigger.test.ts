import { describe, expect, it } from "vitest";
import { completionRequestContext, triggerCharacterFor } from "./completionTrigger";

describe("triggerCharacterFor", () => {
  it("triggers on the dot of a member access", () => {
    expect(triggerCharacterFor(".")).toBe(".");
  });

  it("triggers on the Python string quotes ty declares", () => {
    expect(triggerCharacterFor('"')).toBe('"');
    expect(triggerCharacterFor("'")).toBe("'");
  });

  it("does not trigger inside a word or on other punctuation", () => {
    expect(triggerCharacterFor("a")).toBeNull();
    expect(triggerCharacterFor("_")).toBeNull();
    expect(triggerCharacterFor(",")).toBeNull();
    expect(triggerCharacterFor(" ")).toBeNull();
  });
});

describe("completionRequestContext", () => {
  it("reports a trigger character with kind 2", () => {
    expect(completionRequestContext(".")).toEqual({
      triggerKind: 2,
      triggerCharacter: ".",
    });
  });

  it("reports every other request as Invoked, without a character", () => {
    expect(completionRequestContext(null)).toEqual({ triggerKind: 1 });
    expect(completionRequestContext(null)).not.toHaveProperty("triggerCharacter");
  });
});

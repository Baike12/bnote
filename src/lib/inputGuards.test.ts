import { describe, expect, it, expectTypeOf } from "vitest";
import { inputGuards } from "./inputGuards";

/**
 * The attribute set that stops macOS inline predictive text and autocorrect
 * from popping a suggestion bar over the editor. It is spread onto DOM inputs,
 * so the keys must stay the camelCase React spellings and `spellCheck` must
 * stay a boolean (a string value still works but silently changes the DOM
 * attribute spelling, which is exactly the kind of drift this test catches).
 */
describe("inputGuards", () => {
  it("turns off autocorrect, autocapitalization, autocomplete and spellcheck", () => {
    expect(inputGuards).toEqual({
      autoCorrect: "off",
      autoCapitalize: "off",
      autoComplete: "off",
      spellCheck: false,
    });
  });

  it("the spellcheck value stays a boolean for React's DOM attribute", () => {
    expectTypeOf(inputGuards.spellCheck).toEqualTypeOf<false>();
    expect(typeof inputGuards.spellCheck).toBe("boolean");
  });
});

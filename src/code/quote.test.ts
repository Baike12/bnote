import { describe, expect, it } from "vitest";
import { formatCodeQuote } from "./quote";

/**
 * The Agent input receives plain text, so a quoted selection has to say
 * everything itself: where the code lives, which lines it is, and the code.
 * The shape is documented in the coding system prompt (`prompt.rs`), which is
 * why it is locked here rather than left to the component.
 */
describe("formatCodeQuote", () => {
  it("names the file and the line range, then fences the code", () => {
    expect(
      formatCodeQuote({
        path: "src/code/quote.ts",
        startLine: 12,
        endLine: 18,
        text: "const a = 1;\nconst b = 2;",
        language: "typescript",
      }),
    ).toBe("src/code/quote.ts:12-18\n```typescript\nconst a = 1;\nconst b = 2;\n```\n");
  });

  it("collapses one selected line to a single number", () => {
    expect(
      formatCodeQuote({
        path: "README.md",
        startLine: 7,
        endLine: 7,
        text: "hello",
        language: "markdown",
      }),
    ).toBe("README.md:7\n```markdown\nhello\n```\n");
  });

  it("drops the trailing newline of a linewise selection", () => {
    // Vim's `V` takes the line break: keeping it would open a blank line
    // before the closing fence.
    expect(
      formatCodeQuote({
        path: "a.rs",
        startLine: 1,
        endLine: 2,
        text: "fn a() {}\n\n",
        language: "rust",
      }),
    ).toBe("a.rs:1-2\n```rust\nfn a() {}\n```\n");
  });

  it("keeps an empty fence info string when the language is unknown", () => {
    expect(
      formatCodeQuote({ path: "Makefile", startLine: 1, endLine: 1, text: "all:", language: "" }),
    ).toBe("Makefile:1\n```\nall:\n```\n");
  });
});

import { describe, expect, it } from "vitest";
import { findLanguage } from "./language";

/**
 * The backend decides the languageId from the extension; this module is the
 * only place that turns it into a CodeMirror language. A miss silently opens
 * the file as plain text, so the core ids and the lazy loaders are locked.
 */

describe("findLanguage", () => {
  it("has no language for plaintext or an empty id", () => {
    expect(findLanguage("plaintext")).toBeNull();
    expect(findLanguage("")).toBeNull();
  });

  it("maps the core ids to their dedicated parsers", async () => {
    for (const [id, name] of [
      ["typescript", "TypeScript"],
      ["typescriptreact", "TypeScript JSX"],
      ["javascript", "JavaScript"],
      ["javascriptreact", "JavaScript JSX"],
      ["rust", "Rust"],
      ["go", "Go"],
      ["python", "Python"],
    ]) {
      const desc = findLanguage(id);
      expect(desc?.name, id).toBe(name);
      expect(await desc?.load(), id).toBeTruthy();
    }
  });

  it("falls back to the generic language-data set", () => {
    expect(findLanguage("json")?.name).toBe("JSON");
    expect(findLanguage("markdown")?.name).toBe("Markdown");
  });

  it("returns null for an unknown id instead of guessing from the text", () => {
    expect(findLanguage("no-such-language")).toBeNull();
  });

  it("matches the exact lower-case id the backend sends", () => {
    expect(findLanguage("Rust")).toBeNull();
  });
});

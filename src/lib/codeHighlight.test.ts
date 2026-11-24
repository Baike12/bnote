import { describe, expect, it } from "vitest";
import { escapeCodeHtml, findFenceLanguage, highlightCodeHtml } from "./codeHighlight";
import { bnoteHighlightStyle } from "@/editor/highlightStyle";

/**
 * Read-only code highlighting (agent replies, markdown preview). The contract
 * mirrors the code editor: same language resolution, same palette, every piece
 * of source text escaped, an unknown language reported as "no highlight".
 */

describe("findFenceLanguage", () => {
  it("resolves aliases to the dedicated parsers", () => {
    expect(findFenceLanguage("ts")?.name).toBe("TypeScript");
    expect(findFenceLanguage("tsx")?.name).toBe("TypeScript JSX");
    expect(findFenceLanguage("py")?.name).toBe("Python");
  });

  it("resolves the generic language-data names too", () => {
    expect(findFenceLanguage("yaml")?.name).toBe("YAML");
    expect(findFenceLanguage("yml")?.name).toBe("YAML");
    expect(findFenceLanguage("json")?.name).toBe("JSON");
    expect(findFenceLanguage("sh")?.name).toBe("Shell");
  });

  it("falls back to extension names fences commonly use", () => {
    expect(findFenceLanguage("c++")?.name).toBe("C++");
  });

  it("returns null for an unknown or empty name", () => {
    expect(findFenceLanguage("no-such-language")).toBeNull();
    expect(findFenceLanguage("")).toBeNull();
  });

  it("keeps plain-text fences unhighlighted (text is a LaTeX extension)", () => {
    expect(findFenceLanguage("text")).toBeNull();
    expect(findFenceLanguage("plaintext")).toBeNull();
    expect(findFenceLanguage("log")).toBeNull();
  });
});

describe("escapeCodeHtml", () => {
  it("escapes markup, quotes and ampersands", () => {
    expect(escapeCodeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("highlightCodeHtml", () => {
  it("writes styled spans and escapes the source", async () => {
    const html = await highlightCodeHtml('const a = "<b>";', "ts");
    expect(html).toContain("<span class=");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("colors YAML keys with the property rule (not the body color)", async () => {
    const html = await highlightCodeHtml("server:\n  port: 8080\n", "yaml");
    const cls = /<span class="([^"]+)">server<\/span>/.exec(html ?? "")?.[1];
    if (!cls) throw new Error(`no property span in ${html}`);
    // The generated class carries the property color: the palette did not
    // leave the key on the body color any more.
    const rules = bnoteHighlightStyle.module?.getRules() ?? "";
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(rules).toMatch(new RegExp(`\\.${escaped}\\s*\\{[^}]*--tok-property`));
  });

  it("returns null when the language is unknown", async () => {
    expect(await highlightCodeHtml("x", "no-such-language")).toBeNull();
  });

  it("returns the same HTML for the same code and language (cache)", async () => {
    const a = await highlightCodeHtml("let x = 1;", "js");
    const b = await highlightCodeHtml("let x = 1;", "js");
    expect(a).toBe(b);
    expect(a).toBeTruthy();
  });

  it("keeps code without any tagged token as plain escaped text", async () => {
    expect(await highlightCodeHtml("# just a comment", "yaml")).toContain("just a comment");
  });
});

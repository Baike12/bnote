import { describe, expect, it } from "vitest";
import { WEB_ANNOTATION_SCRIPT, buildWebAnnotationScript } from "./webAnnotations";

/**
 * The script handed to the native webview is built with
 * `Function.prototype.toString`, so it only works if the runtime is
 * self-contained and every pure helper is inlined into the call.
 *
 * Moving the runtime into its own module made this easy to break silently: a
 * helper left behind in the module scope would still typecheck and still
 * serialize, and only the page would throw at runtime (where no test can see
 * it).
 */
describe("the injected web annotation script", () => {
  it("is one immediately invoked function with every helper inlined", () => {
    expect(WEB_ANNOTATION_SCRIPT.startsWith("(function webAnnotationRuntime(")).toBe(true);
    for (const helper of [
      "locateQuote",
      "textPointAt",
      "mergeLineRects",
      "normalizeWebAnnotations",
      "normalizePageStep",
      "snapScrollTopToLine",
      "parseBinding",
      "eventKeyName",
    ]) {
      expect(WEB_ANNOTATION_SCRIPT).toContain(`${helper}:function`);
    }
  });

  it("parses as JavaScript after serialization", () => {
    // Compiling only: running it needs a document and a browser.
    expect(() => new Function(WEB_ANNOTATION_SCRIPT)).not.toThrow();
  });

  it("does not leak module scope names the page cannot see", () => {
    for (const leaked of ["hash53", "MAX_WEB_QUOTE", "vaultDotPath", "createVaultJsonStore"]) {
      expect(WEB_ANNOTATION_SCRIPT).not.toMatch(new RegExp(`\\b${leaked}\\b`));
    }
  });

  it("is built once and reused", () => {
    expect(buildWebAnnotationScript()).toBe(WEB_ANNOTATION_SCRIPT);
  });
});

import { describe, expect, it } from "vitest";

import { PREVIEW_HEIGHT_FLAG, wrapPreviewDocument } from "./htmlPreview";

/**
 * The preview document is built by string surgery and shipped into a sandboxed
 * iframe; its contract with the height channel is locked here: the user code
 * stays verbatim (byte for byte), the token is embedded as a JSON string
 * literal, and the reporter only ever fires after the DOM exists.
 */
describe("wrapPreviewDocument", () => {
  it("keeps the user code verbatim and appends the height reporter", () => {
    const code = "<p>你好</p>\n<script>document.body.style.color='red'</script>";
    const doc = wrapPreviewDocument(code, "t1");
    expect(doc.startsWith(`${code}\n`)).toBe(true);
    expect(doc).toContain("parent.postMessage");
    expect(doc).toContain(JSON.stringify(PREVIEW_HEIGHT_FLAG));
    expect(doc).toContain(JSON.stringify("t1"));
  });

  it("the token is embedded as a JSON literal (quotes and backslashes cannot break out)", () => {
    const token = 'x";}</script><script>alert(1)</script>';
    const doc = wrapPreviewDocument("<p>x</p>", token);
    // The raw token never appears unescaped: JSON.stringify quotes it, and `<`
    // is \u-escaped so it cannot close the inline script element either.
    expect(doc).toContain(JSON.stringify(token).replace(/</g, "\\u003c"));
    expect(doc.indexOf(token)).toBe(-1);
    // The reporter itself carries no markup: the document ends with the
    // element's own closing tag, and nothing inside the script closes early.
    expect(doc.endsWith("</script>")).toBe(true);
    expect(doc.slice(0, -1).lastIndexOf("<script>")).toBeLessThan(doc.lastIndexOf("</script>"));
  });

  it("the height is the max of the two scrollHeights (either side may carry the content)", () => {
    const doc = wrapPreviewDocument("<p>x</p>", "t");
    expect(doc).toContain("Math.max(document.documentElement.scrollHeight");
  });
});

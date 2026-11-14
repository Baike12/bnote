import { describe, expect, it } from "vitest";
import { decodeFileUri, encodeFileUri, encodeUriPath } from "./uri";

/**
 * The language server answers with a `file://` URI; the jump target is looked
 * up in the project by the decoded path. Encoding and decoding have to agree
 * with the Rust side (`encode_uri_path` / `decode_uri_path`, same RFC 3986
 * rule over UTF-8 bytes), or a path with a space or a CJK character either
 * fails to match an open file or points at the wrong one.
 */
describe("encodeUriPath", () => {
  it("keeps the RFC 3986 unreserved characters and the separator", () => {
    expect(encodeUriPath("/src/a-b_c.d~e/File9.ts")).toBe("/src/a-b_c.d~e/File9.ts");
  });

  it("encodes spaces and characters that would break the URI", () => {
    expect(encodeUriPath("/my docs/a b.ts")).toBe("/my%20docs/a%20b.ts");
    expect(encodeUriPath("/a?b#c.ts")).toBe("/a%3Fb%23c.ts");
    expect(encodeUriPath("/100%.ts")).toBe("/100%25.ts");
  });

  it("encodes non-ASCII characters as their UTF-8 bytes", () => {
    // 中 = E4 B8 AD in UTF-8; the encoding must not use the UTF-16 code unit.
    expect(encodeUriPath("/笔记/中.md")).toBe("/%E7%AC%94%E8%AE%B0/%E4%B8%AD.md");
  });

  it("encodeFileUri prefixes the scheme", () => {
    expect(encodeFileUri("/tmp/a b.ts")).toBe("file:///tmp/a%20b.ts");
  });
});

describe("decodeFileUri", () => {
  it("decodes a plain file URI", () => {
    expect(decodeFileUri("file:///Users/me/proj/src/a.ts")).toBe("/Users/me/proj/src/a.ts");
  });

  it("accepts the empty and localhost hosts and rejects a real host", () => {
    expect(decodeFileUri("file://localhost/Users/me/a.ts")).toBe("/Users/me/a.ts");
    expect(decodeFileUri("file://server/share/a.ts")).toBeNull();
  });

  it("rejects anything that is not a file:// URI with a path", () => {
    expect(decodeFileUri("http://example.com/a.ts")).toBeNull();
    expect(decodeFileUri("file://")).toBeNull();
    expect(decodeFileUri("file://localhost")).toBeNull();
  });

  it("decodes percent escapes over UTF-8 bytes", () => {
    expect(decodeFileUri("file:///tmp/a%20b.ts")).toBe("/tmp/a b.ts");
    expect(decodeFileUri("file:///%E7%AC%94%E8%AE%B0/%E4%B8%AD.md")).toBe("/笔记/中.md");
  });

  it("keeps a literal non-ASCII character as UTF-8 instead of one code unit per byte", () => {
    // A server that did not percent-encode its URI still has to decode into
    // the same path: the literal code point is re-encoded as UTF-8 bytes.
    expect(decodeFileUri("file:///笔记/中.md")).toBe("/笔记/中.md");
  });

  it("leaves a malformed escape alone instead of dropping the rest", () => {
    expect(decodeFileUri("file:///tmp/100%zz.ts")).toBe("/tmp/100%zz.ts");
  });

  it("round-trips a path with spaces, punctuation and CJK", () => {
    const path = "/Users/me/代码/my docs/a?b#c 1.ts";
    expect(decodeFileUri(encodeFileUri(path))).toBe(path);
  });
});

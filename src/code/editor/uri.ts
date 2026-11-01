/**
 * Encoding and decoding of file:// URIs (frontend side).
 *
 * The rules are the same as the Rust side `encode_uri_path` /
 * `decode_uri_path` in `src-tauri/src/lsp/mod.rs`: keep the RFC 3986
 * unreserved characters and '/', turn everything else into %XX over its
 * UTF-8 bytes. The Location a language server returns carries a file:// URI,
 * so the frontend has to decode it into a path to locate a file in the
 * project.
 */

/** Absolute path → file:// URI. */
export function encodeFileUri(path: string): string {
  return `file://${encodeUriPath(path)}`;
}

/** Encode the path part of a file:// URI. */
export function encodeUriPath(path: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(path)) {
    const ch = String.fromCharCode(byte);
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~" ||
      ch === "/"
    ) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** file:// URI → absolute path; null when it is not a file:// URI. */
export function decodeFileUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const rest = uri.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const host = rest.slice(0, slash);
  if (host !== "" && host !== "localhost") return null;
  const path = rest.slice(slash);
  const bytes: number[] = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === "%" && i + 2 < path.length) {
      const value = Number.parseInt(path.slice(i + 1, i + 3), 16);
      if (!Number.isNaN(value)) {
        bytes.push(value);
        i += 3;
        continue;
      }
    }
    // The literal part is usually ASCII (everything non-ASCII was encoded as
    // %XX); when a non-ASCII character does show up, add it as UTF-8 bytes
    // instead of treating the code unit as a byte.
    const code = path.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
      i += 1;
    } else {
      const chunk = new TextEncoder().encode(path[i]);
      for (const b of chunk) bytes.push(b);
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

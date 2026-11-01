/**
 * file:// URI 的编解码(前端侧)。
 *
 * 与 Rust 侧 `src-tauri/src/lsp/mod.rs` 的 `encode_uri_path` /
 * `decode_uri_path` 是同一套规则:保留 RFC 3986 unreserved 与 '/',其余按
 * UTF-8 字节转 %XX。语言服务器回的 Location 带的是 file:// URI,前端要
 * 反解成路径才能定位到项目里的文件。
 */

/** 绝对路径 → file:// URI。 */
export function encodeFileUri(path: string): string {
  return `file://${encodeUriPath(path)}`;
}

/** file:// URI 的路径部分编码。 */
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

/** file:// URI → 绝对路径;不是 file:// 就返回 null。 */
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
    // 字面部分通常是 ASCII(非 ASCII 都被编码成了 %XX);真出现非 ASCII
    // 时按 UTF-8 补进去,别把码元当字节。
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

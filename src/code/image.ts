import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Images in the code area.
 *
 * An image **does not go through the editor**: the backend treats it as
 * binary (the content is an empty string), and here the bytes on disk are
 * handed to an `<img>` directly through the Tauri asset protocol — no base64
 * over IPC, and a large image is not kept twice in JS.
 *
 * Only **bitmaps** are recognized: svg is text (xml) and has to stay editable
 * in the editor, so it is not an image.
 */

/** Extension → rendered as an image (all of them are formats WKWebView decodes natively). */
const RASTER_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "tif",
  "tiff",
  "heic",
]);

/** Whether this file should be rendered as an image (svg does not count: it is editable text). */
export function isRasterImage(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return RASTER_EXT.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Project root + project-relative path → absolute path.
 *
 * The trailing slash of the root is removed first: appending the relative
 * path then cannot produce a `//` (the asset protocol reads a double slash
 * as an empty host name after the scheme, and the path fails to resolve).
 */
export function absoluteInProject(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * The asset URL of an image.
 *
 * Outside Tauri (the pure browser harness has no `convertFileSrc`) it returns
 * an empty string and the caller shows the load failure — it does not throw
 * and blow up the whole panel.
 */
export function imageSrc(root: string, path: string): string {
  try {
    return convertFileSrc(absoluteInProject(root, path));
  } catch {
    return "";
  }
}

/** A human readable file size (used by the image caption). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

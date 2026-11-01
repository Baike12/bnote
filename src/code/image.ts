import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * 代码区里的图片。
 *
 * 图片**不走编辑器**:后端按二进制处理(内容为空串),这里用 Tauri 的
 * asset 协议直接把磁盘上的字节交给 `<img>`——不经过 IPC 的 base64,
 * 大图也不会在 JS 里多存一份。
 *
 * 只认**位图**:svg 是文本(xml),要继续能在编辑器里改,不当图片。
 */

/** 扩展名 → 当图片渲染(都是 WKWebView 能直接解的属性)。 */
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

/** 这个文件是不是该按图片渲染(svg 不算:它是可编辑的文本)。 */
export function isRasterImage(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return RASTER_EXT.has(name.slice(dot + 1).toLowerCase());
}

/**
 * 项目根 + 项目相对路径 → 绝对路径。
 *
 * 根的末尾斜杠先去掉:接上相对路径后不会出现 `//`(asset 协议会把双斜杠
 * 当成协议后的空主机名,路径解析失败)。
 */
export function absoluteInProject(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * 图片的 asset URL。
 *
 * 非 Tauri 环境(纯浏览器 harness 的 `convertFileSrc` 缺失)返回空串,
 * 由调用方显示加载失败——不抛异常把整个面板炸掉。
 */
export function imageSrc(root: string, path: string): string {
  try {
    return convertFileSrc(absoluteInProject(root, path));
  } catch {
    return "";
  }
}

/** 人读的文件大小(图片角注用)。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

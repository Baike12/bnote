/**
 * Image attachments for the study assistant input box (modeled on cc's
 * attachments/imageResizer pipeline).
 *
 * Two entry points: pasted screenshots (the textarea's paste event) and file
 * pick. One shared path: Blob -> dataURL -> extract mediaType + base64 ->
 * when over the limit (pixels > 2000 or raw bytes > 3.75MB, the same values
 * as cc) scale proportionally on a canvas and convert to JPEG -> output
 * `{mediaType, data}`. `data` is plain base64 without the `data:` prefix,
 * matching the backend's `Content::Image` (Anthropic base64 source / OpenAI
 * data URL).
 *
 * The pure functions (parseDataUrl / base64Bytes / scaledSize / needsResize)
 * are kept apart from the DOM pipeline (fileToAgentImage); the former go into
 * the node unit tests.
 */

export interface AgentImage {
  /** e.g. "image/png". */
  mediaType: string;
  /** Plain base64, no `data:` prefix. */
  data: string;
}

/** Hard pixel limit the API imposes on an image (same value as cc constants/apiLimits). */
export const MAX_IMAGE_DIM = 2000;
/** Raw byte budget: ~5MB once base64-encoded, which is Anthropic's hard per-image limit. */
export const MAX_IMAGE_RAW_BYTES = 3.75 * 1024 * 1024;
/** Absolute limit after base64 encoding; reject anything still over it (never send a request the API will bounce). */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** Max images per message: guards against accidental repeated pastes blowing up the context. */
export const MAX_IMAGES_PER_MESSAGE = 4;

const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

/** dataURL -> {mediaType, data}; null when the URL is not a base64 data URL. */
export function parseDataUrl(dataUrl: string): AgentImage | null {
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  return { mediaType: m[1], data: m[2].replace(/\s+/g, "") };
}

/** Raw byte size of a base64 payload (accounting for the stripped padding). */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Scale proportionally to fit within max x max (only down, never up). */
export function scaledSize(w: number, h: number, max: number): [number, number] {
  if (w <= max && h <= max) return [w, h];
  const scale = Math.min(max / w, max / h);
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

/** Whether the image breaks an API limit (pixels or bytes) and needs scaling plus re-encoding. */
export function needsResize(w: number, h: number, rawBytes: number): boolean {
  return w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM || rawBytes > MAX_IMAGE_RAW_BYTES;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
}

/**
 * Blob (pasted screenshot / picked file) -> AgentImage. Over the limit it is
 * re-encoded as JPEG on a canvas; still over the base64 limit afterwards it
 * throws (the caller toasts and sends no request).
 */
export async function fileToAgentImage(file: Blob, fallbackType?: string): Promise<AgentImage> {
  const dataUrl = await readAsDataUrl(file);
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error("不是可识别的图片数据");
  const mediaType = file.type || fallbackType || parsed.mediaType;
  let { data } = parsed;
  let resized = false;

  const img = await decodeImage(dataUrl);
  if (needsResize(img.naturalWidth, img.naturalHeight, base64Bytes(data))) {
    const [cw, ch] = scaledSize(img.naturalWidth, img.naturalHeight, MAX_IMAGE_DIM);
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 不可用");
    ctx.drawImage(img, 0, 0, cw, ch);
    const out = parseDataUrl(canvas.toDataURL("image/jpeg", 0.85));
    if (!out) throw new Error("图片压缩失败");
    data = out.data;
    resized = true;
  }

  if (base64Bytes(data) > MAX_IMAGE_BASE64_BYTES) {
    throw new Error("图片过大且无法压缩到 5MB 以内,请缩小后再试");
  }
  // After re-encoding to JPEG the mediaType must follow, otherwise the backend decodes it as PNG and fails.
  return { mediaType: resized ? "image/jpeg" : mediaType, data };
}

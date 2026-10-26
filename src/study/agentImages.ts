/**
 * 学习助手输入框的图片附件(参考 cc 的 attachments/imageResizer 管道)。
 *
 * 入口两种:粘贴截图(textarea 的 paste 事件)与文件选择。统一步骤:
 * Blob → dataURL → 解出 mediaType + base64 → 超限(像素 > 2000 或原始字节
 * > 3.75MB,cc 同值)时用 canvas 等比缩到限内并转 JPEG → 输出
 * `{mediaType, data}`。`data` 是不带 `data:` 前缀的纯 base64,与后端
 * `Content::Image`(Anthropic base64 source / OpenAI data URL)对齐。
 *
 * 纯函数(parseDataUrl / base64Bytes / scaledSize / needsResize)
 * 与 DOM 管道(fileToAgentImage)分开,前者进 node 单测。
 */

export interface AgentImage {
  /** 如 "image/png"。 */
  mediaType: string;
  /** 纯 base64,无 data: 前缀。 */
  data: string;
}

/** API 对图片像素的硬上限(cc constants/apiLimits 同值)。 */
export const MAX_IMAGE_DIM = 2000;
/** 原始字节预算:base64 后 ≈5MB,是 Anthropic 的单图硬限。 */
export const MAX_IMAGE_RAW_BYTES = 3.75 * 1024 * 1024;
/** base64 后的绝对上限,压缩后仍超出就拒绝(不发给必被 API 弹回的请求)。 */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** 一条消息最多几张图:防误触连续粘贴把上下文炸掉。 */
export const MAX_IMAGES_PER_MESSAGE = 4;

const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

/** dataURL → {mediaType, data};不是 base64 dataURL 返回 null。 */
export function parseDataUrl(dataUrl: string): AgentImage | null {
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  return { mediaType: m[1], data: m[2].replace(/\s+/g, "") };
}

/** base64 文本对应的原始字节数(算上去掉 padding)。 */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** 等比缩到 max×max 以内(只缩不放)。 */
export function scaledSize(w: number, h: number, max: number): [number, number] {
  if (w <= max && h <= max) return [w, h];
  const scale = Math.min(max / w, max / h);
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

/** 是否超出 API 限制(像素或字节),需要缩放重编码。 */
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
 * Blob(粘贴的截图 / 选择的文件)→ AgentImage。超限时 canvas 重编码为
 * JPEG;重编码后仍超 base64 上限则抛错(调用方 toast,不发请求)。
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
  // 重编码成 JPEG 后 mediaType 必须跟着换,否则后端按 PNG 解会失败。
  return { mediaType: resized ? "image/jpeg" : mediaType, data };
}

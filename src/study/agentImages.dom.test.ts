/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fileToAgentImage,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_DIM,
  MAX_IMAGE_RAW_BYTES,
  type AgentImage,
} from "./agentImages";

/**
 * The DOM half of the image pipeline: Blob -> dataURL -> decode -> optional
 * canvas resize -> `{mediaType, data}`. jsdom has no image decoder and no
 * canvas backend, so both are stubbed with the contract the browser provides:
 * an `Image` that reports naturalWidth/naturalHeight (or fires onerror), and a
 * canvas whose `toDataURL("image/jpeg")` returns a fresh data URL.
 *
 * What matters to the app is asserted here: the payload is bare base64, a
 * resized image is relabelled `image/jpeg` (the backend would otherwise decode
 * JPEG bytes as PNG), and every failure is a message the toast can show.
 */

const JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

interface ImageBehavior {
  width: number;
  height: number;
  /** When set, the decode fires onerror instead of onload. */
  fail: boolean;
}

const behavior: ImageBehavior = { width: 100, height: 100, fail: false };

/** `toDataURL` output the canvas stub returns for the next call. */
let canvasOutput = JPEG_DATA_URL;
/** Whether the canvas stub has a 2D context. */
let canvasAvailable = true;

class ImageMock {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = "";

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
    // The browser decodes asynchronously; queue the callback like a real load.
    queueMicrotask(() => {
      if (behavior.fail) {
        this.onerror?.();
        return;
      }
      this.naturalWidth = behavior.width;
      this.naturalHeight = behavior.height;
      this.onload?.();
    });
  }
}

const nativeReadAsDataUrl = FileReader.prototype.readAsDataURL;

/**
 * Make the next FileReader report a data URL that does not carry base64 image
 * data (the only way to reach the "unrecognized data" branch: jsdom's own
 * FileReader always produces a valid base64 data URL).
 */
function stubFileReaderResult(result: string): void {
  FileReader.prototype.readAsDataURL = function readStub(this: FileReader) {
    // The arrow keeps the method's `this`, so no aliasing is needed.
    queueMicrotask(() => {
      Object.defineProperty(this, "result", { configurable: true, value: result });
      this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
    });
  };
}
beforeEach(() => {
  behavior.width = 100;
  behavior.height = 100;
  behavior.fail = false;
  canvasOutput = JPEG_DATA_URL;
  canvasAvailable = true;

  // jsdom has no canvas backend: the 2D context is the one seam stubbed here.
  const proto = HTMLCanvasElement.prototype as HTMLCanvasElement & {
    getContext: (id: string) => unknown;
    toDataURL: (type?: string) => string;
  };
  proto.getContext = (() =>
    canvasAvailable ? { drawImage: () => {} } : null) as HTMLCanvasElement["getContext"];
  proto.toDataURL = () => canvasOutput;
  vi.stubGlobal("Image", ImageMock);
});

afterEach(() => {
  FileReader.prototype.readAsDataURL = nativeReadAsDataUrl;
  vi.unstubAllGlobals();
});

/** A 3-byte PNG Blob; jsdom's FileReader encodes the real bytes. */
function pngFile(type = "image/png"): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type });
}

describe("fileToAgentImage on a small image", () => {
  it("keeps the original bytes and media type when no limit is broken", async () => {
    const image = await fileToAgentImage(pngFile());

    expect(image).toEqual<AgentImage>({ mediaType: "image/png", data: "AQID" });
  });

  it("the returned data is bare base64, never a data URL (the backend builds its own header)", async () => {
    const image = await fileToAgentImage(pngFile());

    expect(image.data.startsWith("data:")).toBe(false);
    expect(image.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("a Blob without a type falls back to the data URL's media type", async () => {
    // jsdom labels an untyped Blob "application/octet-stream" in the data URL,
    // so the caller-supplied type is the one that must survive.
    const image = await fileToAgentImage(pngFile(""), "image/webp");
    expect(image.mediaType).toBe("image/webp");
  });

  it("the Blob's own type outranks the caller's fallback", async () => {
    const image = await fileToAgentImage(pngFile("image/gif"), "image/webp");
    expect(image.mediaType).toBe("image/gif");
  });

  it("input that is not base64 image data is rejected with a message the input box can show", async () => {
    stubFileReaderResult("data:text/plain,hello");

    await expect(fileToAgentImage(pngFile())).rejects.toThrow("不是可识别的图片数据");
  });
});

describe("fileToAgentImage over the pixel limit", () => {
  it("scales proportionally, re-encodes as JPEG and relabels the media type", async () => {
    behavior.width = 4000;
    behavior.height = 2000;

    const image = await fileToAgentImage(pngFile());

    expect(image.mediaType).toBe("image/jpeg");
    expect(image.data).toBe("/9j/4AAQSkZJRg==");
  });

  it("a file over the raw byte budget is re-encoded even when the pixels are small", async () => {
    canvasOutput = "data:image/jpeg;base64,c21hbGw=";
    // 3.75MB of raw bytes (base64 is 4/3 the raw size) forces the resize path.
    const big = "A".repeat(Math.ceil((MAX_IMAGE_RAW_BYTES * 4) / 3) + 8);
    stubFileReaderResult(`data:image/png;base64,${big}`);

    const image = await fileToAgentImage(pngFile());

    expect(image.mediaType).toBe("image/jpeg");
    expect(image.data).toBe("c21hbGw=");
  });

  it("an image still over the base64 limit after compression rejects instead of sending a doomed request", async () => {
    behavior.width = MAX_IMAGE_DIM + 1;
    behavior.height = MAX_IMAGE_DIM + 1;
    const huge = "A".repeat(Math.ceil((MAX_IMAGE_BASE64_BYTES * 4) / 3) + 8);
    canvasOutput = `data:image/jpeg;base64,${huge}`;

    await expect(fileToAgentImage(pngFile())).rejects.toThrow("图片过大且无法压缩到 5MB 以内");
  });

  it("a canvas that will not give a 2D context is reported, not silently dropped", async () => {
    behavior.width = 4000;
    behavior.height = 2000;
    canvasAvailable = false;

    await expect(fileToAgentImage(pngFile())).rejects.toThrow("canvas 不可用");
  });

  it("a re-encode that produces junk is reported as a failed compression", async () => {
    behavior.width = 4000;
    behavior.height = 2000;
    canvasOutput = "not-a-data-url";

    await expect(fileToAgentImage(pngFile())).rejects.toThrow("图片压缩失败");
  });
});

describe("fileToAgentImage decode failures", () => {
  it("an image the browser cannot decode is rejected with a readable message", async () => {
    behavior.fail = true;

    await expect(fileToAgentImage(pngFile())).rejects.toThrow("图片解码失败");
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_DIM,
  base64Bytes,
  needsResize,
  parseDataUrl,
  scaledSize,
} from "./agentImages";

describe("parseDataUrl", () => {
  it("extracts the mediaType and the bare base64 payload", () => {
    expect(parseDataUrl("data:image/png;base64,aGVsbG8=")).toEqual({
      mediaType: "image/png",
      data: "aGVsbG8=",
    });
  });

  it("tolerates whitespace around the dataURL and newlines inside the base64 (FileReader never produces them, this guards hand-written input)", () => {
    expect(parseDataUrl(" data:image/jpeg;base64,aGk=\n")).toEqual({
      mediaType: "image/jpeg",
      data: "aGk=",
    });
  });

  it("returns null for a non-base64 dataURL or arbitrary text", () => {
    expect(parseDataUrl("data:image/png;base64,")).toBeNull(); // empty payload
    expect(parseDataUrl("data:text/plain,hello")).toBeNull();
    expect(parseDataUrl("hello")).toBeNull();
    expect(parseDataUrl("")).toBeNull();
  });
});

describe("base64Bytes", () => {
  it("drops the padding and scales by 3/4", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("aGk=")).toBe(2); // "hi"
    expect(base64Bytes("aGVsbG8=")).toBe(5); // "hello"
    expect(base64Bytes("aGVsbG8")).toBe(5); // truncated run without padding
  });

  it("the 5MB hard limit comparison is based on it", () => {
    const data = "A".repeat(Math.ceil((MAX_IMAGE_BASE64_BYTES * 4) / 3));
    expect(base64Bytes(data)).toBeGreaterThanOrEqual(MAX_IMAGE_BASE64_BYTES);
  });
});

describe("scaledSize", () => {
  it("returns it unchanged within the limit (only shrinks, never grows)", () => {
    expect(scaledSize(100, 50, MAX_IMAGE_DIM)).toEqual([100, 50]);
  });

  it("scales down proportionally past the limit, with the long edge at 2000", () => {
    expect(scaledSize(4000, 2000, MAX_IMAGE_DIM)).toEqual([2000, 1000]);
    expect(scaledSize(2000, 4000, MAX_IMAGE_DIM)).toEqual([1000, 2000]);
    expect(scaledSize(6000, 3000, MAX_IMAGE_DIM)).toEqual([2000, 1000]);
  });

  it("an extreme aspect ratio never produces a 0 dimension", () => {
    const [w, h] = scaledSize(20000, 10, MAX_IMAGE_DIM);
    expect(w).toBe(2000);
    expect(h).toBeGreaterThanOrEqual(1);
  });
});

describe("needsResize", () => {
  it("either the pixel count or the byte count over the limit forces a re-encode", () => {
    expect(needsResize(100, 100, 1024)).toBe(false);
    expect(needsResize(MAX_IMAGE_DIM + 1, 100, 1024)).toBe(true);
    expect(needsResize(100, MAX_IMAGE_DIM + 1, 1024)).toBe(true);
    expect(needsResize(100, 100, 3.75 * 1024 * 1024 + 1)).toBe(true);
  });
});

describe("MAX_IMAGES_PER_MESSAGE", () => {
  it("a single message has a cap, so repeated pastes cannot blow up the context", () => {
    expect(MAX_IMAGES_PER_MESSAGE).toBeGreaterThanOrEqual(1);
    expect(MAX_IMAGES_PER_MESSAGE).toBeLessThanOrEqual(8);
  });
});

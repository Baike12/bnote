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
  it("解出 mediaType 与纯 base64", () => {
    expect(parseDataUrl("data:image/png;base64,aGVsbG8=")).toEqual({
      mediaType: "image/png",
      data: "aGVsbG8=",
    });
  });

  it("容忍 dataURL 前后空白与 base64 内换行(FileReader 不会产生,防御手拼输入)", () => {
    expect(parseDataUrl(" data:image/jpeg;base64,aGk=\n")).toEqual({
      mediaType: "image/jpeg",
      data: "aGk=",
    });
  });

  it("非 base64 dataURL / 任意文本返回 null", () => {
    expect(parseDataUrl("data:image/png;base64,")).toBeNull(); // 空数据
    expect(parseDataUrl("data:text/plain,hello")).toBeNull();
    expect(parseDataUrl("hello")).toBeNull();
    expect(parseDataUrl("")).toBeNull();
  });
});

describe("base64Bytes", () => {
  it("去掉 padding 后按 3/4 折算", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("aGk=")).toBe(2); // "hi"
    expect(base64Bytes("aGVsbG8=")).toBe(5); // "hello"
    expect(base64Bytes("aGVsbG8")).toBe(5); // 无 padding 的截断段
  });

  it("5MB 硬限的判等用的就是它", () => {
    const data = "A".repeat(Math.ceil((MAX_IMAGE_BASE64_BYTES * 4) / 3));
    expect(base64Bytes(data)).toBeGreaterThanOrEqual(MAX_IMAGE_BASE64_BYTES);
  });
});

describe("scaledSize", () => {
  it("限内原样返回(只缩不放)", () => {
    expect(scaledSize(100, 50, MAX_IMAGE_DIM)).toEqual([100, 50]);
  });

  it("超限等比缩,长边贴 2000", () => {
    expect(scaledSize(4000, 2000, MAX_IMAGE_DIM)).toEqual([2000, 1000]);
    expect(scaledSize(2000, 4000, MAX_IMAGE_DIM)).toEqual([1000, 2000]);
    expect(scaledSize(6000, 3000, MAX_IMAGE_DIM)).toEqual([2000, 1000]);
  });

  it("极端比例不产生 0 尺寸", () => {
    const [w, h] = scaledSize(20000, 10, MAX_IMAGE_DIM);
    expect(w).toBe(2000);
    expect(h).toBeGreaterThanOrEqual(1);
  });
});

describe("needsResize", () => {
  it("像素或字节任一超限都要重编码", () => {
    expect(needsResize(100, 100, 1024)).toBe(false);
    expect(needsResize(MAX_IMAGE_DIM + 1, 100, 1024)).toBe(true);
    expect(needsResize(100, MAX_IMAGE_DIM + 1, 1024)).toBe(true);
    expect(needsResize(100, 100, 3.75 * 1024 * 1024 + 1)).toBe(true);
  });
});

describe("MAX_IMAGES_PER_MESSAGE", () => {
  it("一条消息有上限,防连续粘贴把上下文炸掉", () => {
    expect(MAX_IMAGES_PER_MESSAGE).toBeGreaterThanOrEqual(1);
    expect(MAX_IMAGES_PER_MESSAGE).toBeLessThanOrEqual(8);
  });
});

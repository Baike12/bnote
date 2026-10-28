import { beforeEach, describe, expect, it, vi } from "vitest";

import { readBblogAuth } from "./CreativePreview";
import { api } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
  api: { readFile: vi.fn() },
  agentApi: {},
  bblogApi: {},
}));

const mockRead = vi.mocked(api.readFile);

describe("readBblogAuth", () => {
  beforeEach(() => {
    mockRead.mockReset();
  });

  it("读取合法的 server+token", async () => {
    mockRead.mockResolvedValue('{"server":"http://10.1.1.1","token":"abc"}');
    const auth = await readBblogAuth("/vault");
    expect(auth).toEqual({ server: "http://10.1.1.1", token: "abc" });
    expect(mockRead).toHaveBeenCalledWith("/vault/.bnote/bblog/auth.json");
  });

  it("文件缺失/坏 JSON 返回 null(发布对话框显示配置指引)", async () => {
    mockRead.mockRejectedValue(new Error("NOT_FOUND"));
    await expect(readBblogAuth("/vault")).resolves.toBeNull();
    mockRead.mockResolvedValue("not json");
    await expect(readBblogAuth("/vault")).resolves.toBeNull();
  });

  it("字段缺失或为空都判为未配置", async () => {
    mockRead.mockResolvedValue('{"server":"http://x"}');
    await expect(readBblogAuth("/vault")).resolves.toBeNull();
    mockRead.mockResolvedValue('{"server":"","token":"t"}');
    await expect(readBblogAuth("/vault")).resolves.toBeNull();
  });

  it("没有 vault 时直接返回 null,不读文件", async () => {
    await expect(readBblogAuth(null)).resolves.toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });
});

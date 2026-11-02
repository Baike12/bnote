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

  it("reads a valid server+token", async () => {
    mockRead.mockResolvedValue('{"server":"http://10.1.1.1","token":"abc"}');
    const auth = await readBblogAuth("/vault");
    expect(auth).toEqual({ server: "http://10.1.1.1", token: "abc" });
    expect(mockRead).toHaveBeenCalledWith("/vault/.bnote/bblog/auth.json");
  });

  it("a missing file or bad JSON returns null (the publish dialog shows the setup instructions)", async () => {
    mockRead.mockRejectedValue(new Error("NOT_FOUND"));
    await expect(readBblogAuth("/vault")).resolves.toBeNull();
    mockRead.mockResolvedValue("not json");
    await expect(readBblogAuth("/vault")).resolves.toBeNull();
  });

  it("missing or empty fields are both treated as not configured", async () => {
    mockRead.mockResolvedValue('{"server":"http://x"}');
    await expect(readBblogAuth("/vault")).resolves.toBeNull();
    mockRead.mockResolvedValue('{"server":"","token":"t"}');
    await expect(readBblogAuth("/vault")).resolves.toBeNull();
  });

  it("without a vault it returns null directly and reads no file", async () => {
    await expect(readBblogAuth(null)).resolves.toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });
});

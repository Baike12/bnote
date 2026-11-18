import { describe, expect, it } from "vitest";
import { ingestFailureLabel, ingestToast } from "./ingestToast";

describe("ingestToast", () => {
  it("keeps the plain success line", () => {
    expect(ingestToast(3, [])).toBe("摄取完成: 新增 3 条");
  });

  it("names the unavailable source without pasting the URL", () => {
    expect(
      ingestFailureLabel({
        source_id: "sina-finance-roll",
        error: "HTTP_STATUS: https://rsshub.app/sina/rollnews/finance: 403 Forbidden",
      }),
    ).toBe("sina-finance-roll 暂不可用（HTTP 403）");
  });

  it("classifies network and timeout failures", () => {
    expect(ingestFailureLabel({ source_id: "a", error: "HTTP_CONNECT_FAILED: x" })).toBe(
      "a 网络请求失败",
    );
    expect(ingestFailureLabel({ source_id: "b", error: "TIMEOUT: 30s" })).toBe("b 请求超时");
    expect(ingestFailureLabel({ source_id: "c", error: "SOMETHING_ELSE" })).toBe("c 抓取失败");
  });

  it("summarizes several failures and caps the listing at two", () => {
    const toast = ingestToast(0, [
      { source_id: "s1", error: "HTTP_STATUS: u: 403 Forbidden" },
      { source_id: "s2", error: "TIMEOUT: 30s" },
      { source_id: "s3", error: "HTTP_CONNECT_FAILED: u" },
    ]);
    expect(toast).toContain("3 个信息源暂不可用");
    expect(toast).toContain("s1 暂不可用（HTTP 403）");
    expect(toast).toContain("s2 请求超时");
    expect(toast).toContain("等 3 个");
  });
});

import { describe, expect, it } from "vitest";
import tauriConf from "../../src-tauri/tauri.conf.json";

/**
 * 打包 CSP 门禁：用户公式片段（`.bnote/snippets.js`）靠 Blob URL 动态
 * import 装载。tauri.conf.json 的 CSP 若没有 `script-src blob:`，script-src
 * 会回退到 `default-src 'self'`，打包后的 WKWebView 拒绝 blob 导入——
 * 用户片段永远静默加载失败（浏览器实证：旧 CSP IMPORT_FAIL，加
 * `script-src 'self' blob:` 后 IMPORT_OK）。这里锁住打包配置不再回退。
 */

interface TauriConf {
  app?: { security?: { csp?: string } };
}

const conf = tauriConf as TauriConf;

const directives = (conf.app?.security?.csp ?? "")
  .split(";")
  .map((d) => d.trim())
  .filter(Boolean);

function scriptSrcTokens(): string[] {
  const scriptSrc = directives.find((d) => d.startsWith("script-src"));
  if (!scriptSrc) throw new Error("CSP 缺少 script-src 指令");
  return scriptSrc.split(/\s+/).slice(1);
}

describe("打包 CSP 门禁：blob 动态导入(用户公式片段装载)", () => {
  it("script-src 指令显式存在,不能只靠 default-src 兜底", () => {
    expect(() => scriptSrcTokens()).not.toThrow();
  });

  it("script-src 同时放行 'self'(应用脚本)与 blob:(片段动态导入)", () => {
    const tokens = scriptSrcTokens();
    expect(tokens).toContain("'self'");
    expect(tokens).toContain("blob:");
  });
});

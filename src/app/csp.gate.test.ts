import { describe, expect, it } from "vitest";
import tauriConf from "../../src-tauri/tauri.conf.json";

/**
 * Packaged-CSP gate: the user's formula snippets (`.bnote/snippets.js`) load
 * through a dynamic import of a Blob URL. If the CSP in tauri.conf.json has no
 * `script-src blob:`, script-src falls back to `default-src 'self'` and the
 * packaged WKWebView refuses blob imports — the user snippets then fail to
 * load, silently and forever (proven in the browser: the old CSP gave
 * IMPORT_FAIL, `script-src 'self' blob:` gives IMPORT_OK). This gate locks
 * the packaged configuration against that fallback.
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
  if (!scriptSrc) throw new Error("CSP is missing the script-src directive");
  return scriptSrc.split(/\s+/).slice(1);
}

describe("packaged CSP gate: blob dynamic import (user formula snippet loading)", () => {
  it("an explicit script-src directive exists, default-src alone must not cover it", () => {
    expect(() => scriptSrcTokens()).not.toThrow();
  });

  it("script-src allows both 'self' (app scripts) and blob: (snippet dynamic import)", () => {
    const tokens = scriptSrcTokens();
    expect(tokens).toContain("'self'");
    expect(tokens).toContain("blob:");
  });
});

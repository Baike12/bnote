import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CommandDef } from "@/commands/registry";
import { needsMainWebviewFocus } from "./previewFocus";

function cmd(patch: Partial<CommandDef> = {}): CommandDef {
  return { id: "test.cmd", title: "t", category: "t", run: () => {}, ...patch };
}

/**
 * Focus rules for forwarded keys from the web page. Once a native child
 * webview has taken the first responder, only the main webview taking it back
 * returns the keyboard — otherwise every later key still goes around in the
 * page and the main window commands (region switch, quick todo) look entirely
 * dead.
 */
describe("the main window focus of forwarded web page keys", () => {
  it("an ordinary command takes the keyboard back to the main window first", () => {
    expect(needsMainWebviewFocus(cmd())).toBe(true);
    expect(needsMainWebviewFocus(cmd({ keepsPageFocus: false }))).toBe(true);
  });

  it("a command that acts in place keeps the page focus", () => {
    expect(needsMainWebviewFocus(cmd({ keepsPageFocus: true }))).toBe(false);
  });

  it("when the command cannot be resolved the focus does not move", () => {
    expect(needsMainWebviewFocus(null)).toBe(false);
  });
});

/**
 * The hand-off above is half TypeScript and half build configuration: the
 * keyboard only comes back when the Tauri capability grants
 * `core:webview:allow-set-webview-focus`. Without it the call is rejected, the
 * fallback in ContentPane swallows the rejection and runs the command anyway —
 * which compiled, passed every test, and shipped a build where ⌘⌥N "did
 * nothing" in a web page (observed). The compiler cannot see a capability
 * file, so this gate reads both sides.
 */
describe("the forwarded-key hand-off is granted", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));

  it("grants set_webview_focus because the reader pulls the keyboard back", () => {
    const pane = readFileSync(`${root}/src/components/study/ContentPane.tsx`, "utf8");
    expect(pane).toMatch(/getCurrentWebview\(\)\s*\.\s*setFocus\(\)/);

    const capability = readFileSync(`${root}/src-tauri/capabilities/default.json`, "utf8");
    const permissions = (JSON.parse(capability) as { permissions: string[] }).permissions;
    expect(permissions).toContain("core:webview:allow-set-webview-focus");
  });

  it("does not hide the rejection behind a silent fallback", () => {
    const pane = readFileSync(`${root}/src/components/study/ContentPane.tsx`, "utf8");
    // A bare `.catch(() => runBoundKey(...))` turned the missing capability
    // into an invisible dead key; every failed hand-off has to leave a trace.
    expect(pane).not.toMatch(/\.catch\(\(\)\s*=>\s*runBoundKey/);
  });
});

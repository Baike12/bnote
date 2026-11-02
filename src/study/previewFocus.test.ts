import { describe, expect, it } from "vitest";
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

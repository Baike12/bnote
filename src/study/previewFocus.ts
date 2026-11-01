import type { CommandDef } from "@/commands/registry";

/**
 * A forwarded key pressed inside the web page: should the keyboard be pulled
 * back to the main window before the command runs?
 *
 * Once a native child webview becomes the first responder, key input only
 * reaches that page, and focus() in the main window's DOM cannot take the
 * first responder back — that needs `Webview.setFocus`. So every forwarded key
 * pulls the keyboard back first, except the commands that take effect in place
 * and must keep the page focused (webpage zoom, save; see
 * CommandDef.keepsPageFocus).
 *
 * When the command cannot be resolved the focus stays where it is: the key
 * runs nothing anyway, and stealing the keyboard would be a side effect.
 */
export function needsMainWebviewFocus(cmd: CommandDef | null): boolean {
  return cmd !== null && cmd.keepsPageFocus !== true;
}

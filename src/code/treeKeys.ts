/**
 * What a key means to the file tree.
 *
 * The tree is a single-line list with vim motions: `j` / `k` move, `<CR>` opens
 * the row under the keyboard. The arrows stay bound to the same intents, so a
 * file-manager hand and a vim hand both work, and both go through this table
 * instead of two parallel switches.
 *
 * `right` / `left` are intents, not outcomes: "go into" a folder (expand it, or
 * continue past it when it is already open) and "go out" of one (collapse it,
 * or step to its parent when it is already closed). The row decides which.
 *
 * This is a pure function so the mapping is testable without a DOM: the tree
 * component only turns the action into store writes.
 */
export type TreeKeyAction =
  "down" | "up" | "first" | "last" | "right" | "left" | "activate" | "release";

export interface TreeKeyInput {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function treeKeyAction(event: TreeKeyInput): TreeKeyAction | null {
  // Letters are vim motions only bare: ⌘J / ⌃K are command chords, and a
  // modified key must reach the command dispatch untouched. Shift is treated
  // the same way — the list has no vertical motions of its own to shift, and
  // `J` on a tree row is a typo, not "move 10 rows".
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return "down";
    case "k":
    case "ArrowUp":
      return "up";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "ArrowRight":
      return "right";
    case "ArrowLeft":
      return "left";
    // Enter opens what the keyboard is on; Space joins it because a focused
    // button is what Space activates everywhere else in the app.
    case "Enter":
    case " ":
      return "activate";
    case "Escape":
      return "release";
    default:
      return null;
  }
}

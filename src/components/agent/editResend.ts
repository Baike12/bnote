/**
 * "Edit and resend" rules: which message may be edited, and what the record
 * looks like after the rewind.
 *
 * ZCode's `editUserQuery` semantics (docs/ui/composer-edit-mode.md): only the
 * LAST real user message is editable — editing an older one would silently
 * throw away every later turn — and the rewrite is a branch cut, not an
 * append: the old prompt and everything the model produced for it leave the
 * conversation. The panel owns the state; this module owns the rules.
 */

import { entriesToLines, type ChatEntry } from "@/components/agent/model";

/** The index of the last user message, or null when the conversation has none. */
export function lastUserEntryIndex(entries: readonly ChatEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.role === "user") return index;
  }
  return null;
}

/** The entries that survive the rewind: everything before the edited message. */
export function rewindPrefix(entries: readonly ChatEntry[], index: number): ChatEntry[] {
  return entries.slice(0, Math.max(0, index));
}

/**
 * The `keep` count a record's rewind marker carries: the conversation lines of
 * the surviving prefix.
 *
 * Lines, not entries: one assistant entry may have flushed several per-round
 * lines, and the marker is read back by the line parser — the count must name
 * the same position in the file.
 */
export function rewindKeep(prefix: readonly ChatEntry[]): number {
  return entriesToLines([...prefix]).length;
}

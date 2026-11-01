/**
 * Front-end pure logic for a forked sub-session.
 *
 * The `items` count carried by a fork point (the backend history prefix
 * length) comes from the authoritative count in the turn_end / error events,
 * so this module only does two things: message -> cutoff point (its own count
 * or the nearest previous one) and session label (first-line summary).
 */

export interface ConversationEntryLike {
  role: "user" | "assistant";
  /** Number of session-history entries this message covers (including itself); null = the backend has not reported it yet. */
  items: number | null;
}

/**
 * Fork cutoff point for message `index`: prefer its own count; when the backend
 * reported no count for a failed message, fall back to the nearest message
 * that has one (dropping that uncertain tail).
 */
export function forkCutoff(entries: ConversationEntryLike[], index: number): number {
  for (let i = Math.min(index, entries.length - 1); i >= 0; i -= 1) {
    const count = entries[i].items;
    if (count !== null) return count;
  }
  return 0;
}

/** Session label: first line, truncated. Empty text falls back to the placeholder. */
export function forkLabel(text: string, max = 18): string {
  const line = (text.trim().split("\n")[0] ?? "").trim();
  if (!line) return "空消息";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

import type { ChatEntry, Conv } from "./model";
import type { SubagentRun } from "./subagents";

/**
 * The data one subagent card draws, keyed by the `Agent` tool call that
 * launched it.
 *
 * Why a registry and not a prop: the parent transcript is memoized per row, and
 * a child streams tens of deltas per second. Handing the parent's rows a map
 * that changes on every child delta would re-render the whole transcript for
 * work that belongs to one card. The registry keeps one object per tool call
 * and replaces only the ones whose run or entries actually changed, so a row
 * subscribes with `useSyncExternalStore` and re-renders only when its own card
 * changed — the reference is the change signal.
 */
export interface AgentCardData {
  run: SubagentRun;
  /** The child's own live entries, in stream order. */
  entries: ChatEntry[];
}

export interface AgentCards {
  subscribe(listener: () => void): () => void;
  /** The card of one tool call: the same reference until that card changes. */
  get(toolUseId: string): AgentCardData | null;
  /** Write the current map; identical content keeps the references and stays silent. */
  replace(next: Map<string, AgentCardData>): void;
}

/**
 * Collect every dispatched agent of every conversation, keyed by its tool call.
 * A run without a `toolUseId` (an event from a backend that predates the field)
 * simply has no card and keeps the plain tool row.
 */
export function collectAgentCards(convs: Conv[]): Map<string, AgentCardData> {
  const out = new Map<string, AgentCardData>();
  const byKey = new Map(convs.map((conv) => [conv.key, conv]));
  for (const conv of convs) {
    for (const run of conv.agents ?? []) {
      if (!run.toolUseId) continue;
      const child = byKey.get(run.convKey);
      out.set(run.toolUseId, { run, entries: child?.entries ?? [] });
    }
  }
  return out;
}

export function createAgentCards(): AgentCards {
  let cards = new Map<string, AgentCardData>();
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get(toolUseId) {
      return cards.get(toolUseId) ?? null;
    },
    replace(next) {
      // Keep the old object when nothing about that card moved: a child delta
      // must wake only its own card, and an unrelated conv update must not wake
      // any card at all.
      const merged = new Map<string, AgentCardData>();
      let changed = next.size !== cards.size;
      for (const [toolUseId, data] of next) {
        const previous = cards.get(toolUseId);
        const same = previous && previous.run === data.run && previous.entries === data.entries;
        merged.set(toolUseId, same ? previous : data);
        if (!same) changed = true;
      }
      if (!changed) return;
      cards = merged;
      for (const listener of listeners) listener();
    },
  };
}

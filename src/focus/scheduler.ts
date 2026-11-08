/**
 * Scheduled focus: the only automatic start path.
 *
 * The scheduler owns a **self-rescheduling tick**, not an interval: after the
 * machine slept or the webview was throttled, the chain wakes up and reads the
 * wall clock, so a tick that lands late still sees the block it belongs to
 * instead of firing a burst of stale beats.
 *
 * The rules are deliberately small:
 *
 * - Only the first fifty minutes of a saved block can start a stretch, and the
 *   end comes from the block itself (see `schedule.ts`), so even a start
 *   observed thirty minutes late ends at :50 and the remaining ten minutes stay
 *   unlocked.
 * - A block is observed **once**. A running stretch (manual or scheduled)
 *   already is the focus for that hour, and a failed start leaves its toast as
 *   the evidence instead of retrying every second.
 * - The store stays the single writer: this module only calls
 *   `startScheduled` and never touches the timer or the native locks itself.
 */

import { activeBlock, type GridCell } from "./schedule";
import { isActive, isExpired } from "./timer";
import { useFocusStore } from "./store";

/** Half a second would be noise for an hour-aligned trigger; one second is prompt enough. */
const TICK_MS = 1000;

let tickHandle: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

/** Block ids observed in this process, so one block cannot start two stretches. */
const handled = new Set<string>();

function blockId(cell: GridCell): string {
  return `${cell.day}:${cell.hour}`;
}

/**
 * Starts the scheduler. The returned function stops this generation; a newer
 * install supersedes an older one (StrictMode mounts effects twice), and a
 * superseded generation can never schedule another tick.
 */
export function installFocusScheduler(): () => void {
  generation += 1;
  const mine = generation;
  if (tickHandle !== null) clearTimeout(tickHandle);
  handled.clear();

  const loop = () => {
    if (mine !== generation) return;
    tickHandle = null;
    const now = Date.now();
    const block = activeBlock(useFocusStore.getState().schedule, now);
    if (block !== null) {
      // Ids are day-scoped: yesterday's observations can never match today's
      // block and would only grow this set for the lifetime of the process.
      for (const id of handled) {
        if (!id.startsWith(`${block.cell.day}:`)) handled.delete(id);
      }
      const id = blockId(block.cell);
      if (!handled.has(id)) {
        const timer = useFocusStore.getState().timer;
        const running = isActive(timer) && !isExpired(timer, now);
        if (running) {
          // A running stretch is this block's focus; do not queue a late start.
          handled.add(id);
        } else if (!isActive(timer)) {
          handled.add(id);
          // The store reports a refused start through a toast; a floating
          // promise here is intentional (the tick must not wait for the locks).
          void useFocusStore.getState().startScheduled(block.end);
        }
        // Active but already expired: the store's expiry tick has not folded it
        // back to idle yet. It is not this block's focus anymore, so leave the
        // block unobserved and decide on the next tick.
      }
    }
    tickHandle = setTimeout(loop, TICK_MS);
  };

  tickHandle = setTimeout(loop, TICK_MS);

  return () => {
    if (mine !== generation) return;
    generation += 1;
    if (tickHandle !== null) clearTimeout(tickHandle);
    tickHandle = null;
    handled.clear();
  };
}

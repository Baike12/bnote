/**
 * Pure model of the scheduled focus week: the rolling seven-day grid the
 * settings page edits, and the block geometry the scheduler reads.
 *
 * A schedule is **append-only**. Saving unions the chosen cells into the
 * persisted days; nothing here can remove a block. That is the rule "a day
 * that was set cannot be cancelled from the settings page" expressed in the
 * model, so not even a bug in the grid can produce a removal.
 *
 * One block is one local hour: focus from :00 to :50, then ten minutes with
 * the lock off. Only the first fifty minutes form a focus window, so
 * `activeBlock` deliberately reports nothing during the break.
 *
 * Dates are local (`YYYY-MM-DD`) and every row is derived from the wall clock
 * through `new Date(y, m, d)` instead of millisecond arithmetic: the week
 * crosses DST switches, and adding 24h to a timestamp would land on the wrong
 * hour (and on the wrong day at the far end of the year).
 */

/** Rows of the grid: today plus the next six local dates. */
export const WEEK_DAYS = 7;

/** Columns of the grid: one block per hour of the day. */
export const HOURS_PER_DAY = 24;

/** A block is one hour. */
export const BLOCK_MINUTES = 60;

/** The focus stretch of a block; the remaining ten minutes are the break. */
export const BLOCK_FOCUS_MINUTES = 50;

/** The last ten minutes of a block: the lock is off. */
export const BLOCK_BREAK_MINUTES = BLOCK_MINUTES - BLOCK_FOCUS_MINUTES;

/** A local date `YYYY-MM-DD`. */
export type DayKey = string;

export interface FocusSchedule {
  /** Local date → the hours whose first fifty minutes are focus, ascending. */
  days: Record<DayKey, number[]>;
}

export interface GridCell {
  day: DayKey;
  hour: number;
}

/** One focus window: the first fifty minutes of a scheduled hour. */
export interface FocusBlock {
  cell: GridCell;
  /** Epoch ms of the hour's start. */
  start: number;
  /** Epoch ms of the focus window's end (`start` + 50 minutes). */
  end: number;
}

export function emptySchedule(): FocusSchedule {
  return { days: {} };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The local date of an instant. */
export function dayKey(date: Date): DayKey {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * The local midnight of a date key. `null` when the key is not a real
 * `YYYY-MM-DD` date ("2026-02-31" fails the round trip).
 */
export function dayDate(key: DayKey): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** The seven rows shown today: the local date of `now` plus the next six. */
export function weekDays(now: Date): DayKey[] {
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days: DayKey[] = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    days.push(dayKey(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)));
  }
  return days;
}

/**
 * Read a persisted schedule. Every malformed entry is dropped instead of
 * escaped into the grid: hand-edited configs and configs from a future shape
 * must not produce hours the 24-column grid cannot address.
 */
export function normalizeSchedule(raw: unknown): FocusSchedule {
  if (typeof raw !== "object" || raw === null) return emptySchedule();
  const daysRaw = (raw as { days?: unknown }).days;
  if (typeof daysRaw !== "object" || daysRaw === null || Array.isArray(daysRaw)) {
    return emptySchedule();
  }
  const days: Record<DayKey, number[]> = {};
  for (const [key, value] of Object.entries(daysRaw)) {
    if (dayDate(key) === null || !Array.isArray(value)) continue;
    const hours = [
      ...new Set(
        value.filter(
          (v): v is number =>
            typeof v === "number" && Number.isInteger(v) && v >= 0 && v < HOURS_PER_DAY,
        ),
      ),
    ].sort((a, b) => a - b);
    if (hours.length > 0) days[key] = hours;
  }
  return { days };
}

export function hoursFor(schedule: FocusSchedule, day: DayKey): readonly number[] {
  return schedule.days[day] ?? [];
}

export function isBlockSet(schedule: FocusSchedule, day: DayKey, hour: number): boolean {
  return hoursFor(schedule, day).includes(hour);
}

/**
 * The append-only write: union the cells into the schedule.
 *
 * Returns the same schedule object and `added: 0` when every cell was already
 * there, so a no-op save does not rewrite the config. There is intentionally
 * no counterpart that removes a cell.
 */
export function addBlocks(
  schedule: FocusSchedule,
  cells: readonly GridCell[],
): { schedule: FocusSchedule; added: number } {
  const merged: Record<DayKey, Set<number>> = {};
  for (const [day, hours] of Object.entries(schedule.days)) {
    merged[day] = new Set(hours);
  }
  let added = 0;
  for (const cell of cells) {
    if (dayDate(cell.day) === null) continue;
    if (!Number.isInteger(cell.hour) || cell.hour < 0 || cell.hour >= HOURS_PER_DAY) continue;
    const set = merged[cell.day] ?? (merged[cell.day] = new Set<number>());
    if (set.has(cell.hour)) continue;
    set.add(cell.hour);
    added += 1;
  }
  if (added === 0) return { schedule, added: 0 };
  const days: Record<DayKey, number[]> = {};
  for (const [day, set] of Object.entries(merged)) {
    if (set.size > 0) days[day] = [...set].sort((a, b) => a - b);
  }
  return { schedule: { days }, added };
}

function clampHour(hour: number): number {
  return Math.min(HOURS_PER_DAY - 1, Math.max(0, Math.trunc(hour)));
}

/** The hour's start as an epoch timestamp, or null for an impossible date. */
export function blockStart(day: DayKey, hour: number): number | null {
  const date = dayDate(day);
  if (date === null) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour).getTime();
}

/** The focus window of `now`, or null outside one (including every break). */
export function activeBlock(schedule: FocusSchedule, now: number): FocusBlock | null {
  const at = new Date(now);
  const day = dayKey(at);
  const hour = at.getHours();
  if (!isBlockSet(schedule, day, hour)) return null;
  const start = blockStart(day, hour);
  if (start === null) return null;
  const end = start + BLOCK_FOCUS_MINUTES * 60_000;
  if (now < start || now >= end) return null;
  return { cell: { day, hour }, start, end };
}

/**
 * Every cell of the rectangle between two corners of the visible grid. Used by
 * the drag selection: the rectangle is a preview while the pointer is down and
 * becomes a draft only when it is released.
 */
export function rectangleCells(
  days: readonly DayKey[],
  anchor: GridCell,
  target: GridCell,
): GridCell[] {
  const anchorRow = days.indexOf(anchor.day);
  const targetRow = days.indexOf(target.day);
  if (anchorRow < 0 || targetRow < 0) return [];
  const rowFrom = Math.min(anchorRow, targetRow);
  const rowTo = Math.max(anchorRow, targetRow);
  const hourFrom = Math.min(clampHour(anchor.hour), clampHour(target.hour));
  const hourTo = Math.max(clampHour(anchor.hour), clampHour(target.hour));
  const cells: GridCell[] = [];
  for (let row = rowFrom; row <= rowTo; row++) {
    for (let hour = hourFrom; hour <= hourTo; hour++) {
      cells.push({ day: days[row], hour });
    }
  }
  return cells;
}

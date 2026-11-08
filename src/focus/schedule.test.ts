import { describe, expect, it } from "vitest";
import {
  activeBlock,
  addBlocks,
  blockStart,
  dayKey,
  emptySchedule,
  isBlockSet,
  normalizeSchedule,
  rectangleCells,
  weekDays,
  type FocusSchedule,
} from "./schedule";

const DAY = "2026-11-07";

function schedule(days: Record<string, number[]>): FocusSchedule {
  return { days };
}

/** Local instant, so the test is independent of the machine's time zone. */
function at(day: string, hour: number, minute = 0, second = 0): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute, second).getTime();
}

describe("the rolling week", () => {
  it("starts on the local date of now and adds six more dates, not 24h steps", () => {
    // Noon: the date is unambiguous even on a DST switch day.
    expect(weekDays(new Date(2026, 10, 7, 12))).toEqual([
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
    ]);
  });

  it("crosses a month and a year boundary instead of stopping at it", () => {
    const yearEnd = weekDays(new Date(2026, 11, 29, 12));
    const monthEnd = weekDays(new Date(2026, 0, 30, 12));
    expect(yearEnd[yearEnd.length - 1]).toBe("2027-01-04");
    expect(monthEnd[monthEnd.length - 1]).toBe("2026-02-05");
  });

  it("builds the key from the local date, not from UTC", () => {
    // 00:30 local is still the previous UTC day in the Americas: the key must
    // follow the wall clock the grid is drawn in.
    expect(dayKey(new Date(2026, 10, 7, 0, 30))).toBe(DAY);
  });
});

describe("normalizing a persisted schedule", () => {
  it("keeps valid days and sorts the hours", () => {
    expect(normalizeSchedule({ days: { [DAY]: [12, 9, 9] } })).toEqual({
      days: { [DAY]: [9, 12] },
    });
  });

  it("drops impossible dates, non-integers, out-of-range hours and empty days", () => {
    const raw = {
      days: {
        "2026-02-31": [9],
        nope: [9],
        [DAY]: [9, 24, -1, 8.5, "9", 10],
        "2026-11-08": [],
      },
    };
    expect(normalizeSchedule(raw)).toEqual({ days: { [DAY]: [9, 10] } });
  });

  it("treats a missing or malformed payload as an empty schedule", () => {
    expect(normalizeSchedule(undefined)).toEqual(emptySchedule());
    expect(normalizeSchedule(null)).toEqual(emptySchedule());
    expect(normalizeSchedule({ days: [] })).toEqual(emptySchedule());
  });
});

describe("appending blocks", () => {
  it("unions new cells and keeps every saved hour", () => {
    const base = schedule({ [DAY]: [9, 10] });
    const result = addBlocks(base, [
      { day: DAY, hour: 10 },
      { day: DAY, hour: 14 },
      { day: "2026-11-08", hour: 7 },
    ]);
    expect(result.added).toBe(2);
    expect(result.schedule).toEqual({
      days: { [DAY]: [9, 10, 14], "2026-11-08": [7] },
    });
  });

  it("is idempotent and never removes an existing block", () => {
    const base = schedule({ [DAY]: [9] });
    const same = addBlocks(base, [{ day: DAY, hour: 9 }]);
    expect(same.added).toBe(0);
    expect(same.schedule).toBe(base);

    // There is no removal path: an empty append returns the same object.
    expect(addBlocks(base, []).schedule).toBe(base);
  });

  it("ignores cells outside the 7×24 grid", () => {
    const base = emptySchedule();
    const result = addBlocks(base, [
      { day: "2026-13-01", hour: 9 },
      { day: DAY, hour: 24 },
      { day: DAY, hour: -1 },
    ]);
    expect(result.added).toBe(0);
    expect(result.schedule).toBe(base);
  });
});

describe("block geometry", () => {
  it("maps an hour to its local wall-clock start", () => {
    expect(blockStart(DAY, 9)).toBe(at(DAY, 9));
    expect(blockStart("2026-11-08", 0)).toBe(at("2026-11-08", 0));
    expect(blockStart("2026-02-31", 9)).toBeNull();
  });

  it("is active from the hour's :00 until :50, and not during the break", () => {
    const s = schedule({ [DAY]: [9] });
    expect(activeBlock(s, at(DAY, 8, 59, 59))).toBeNull();
    expect(activeBlock(s, at(DAY, 9))?.end).toBe(at(DAY, 9, 50));
    expect(activeBlock(s, at(DAY, 9, 49, 59))).not.toBeNull();
    // The last ten minutes are the break: no focus window, no lock.
    expect(activeBlock(s, at(DAY, 9, 50))).toBeNull();
    expect(activeBlock(s, at(DAY, 10))).toBeNull();
  });

  it("only reports hours that were actually saved", () => {
    expect(activeBlock(schedule({ [DAY]: [9] }), at(DAY, 10, 10))).toBeNull();
    expect(activeBlock(schedule({ [DAY]: [9] }), at(DAY, 9, 10))?.cell).toEqual({
      day: DAY,
      hour: 9,
    });
    expect(isBlockSet(schedule({ [DAY]: [9] }), DAY, 9)).toBe(true);
  });
});

describe("rectangle selection", () => {
  const days = weekDays(new Date(2026, 10, 7, 12));

  it("covers both corners regardless of the drag direction", () => {
    const expected = 3 * 2;
    const forward = rectangleCells(days, { day: days[1], hour: 8 }, { day: days[3], hour: 9 });
    const backward = rectangleCells(days, { day: days[3], hour: 9 }, { day: days[1], hour: 8 });
    expect(forward).toHaveLength(expected);
    expect(backward).toEqual(forward);
    expect(forward[0]).toEqual({ day: days[1], hour: 8 });
    expect(forward[forward.length - 1]).toEqual({ day: days[3], hour: 9 });
  });

  it("clamps an hour that is outside the day", () => {
    expect(rectangleCells(days, { day: days[0], hour: 30 }, { day: days[0], hour: 30 })).toEqual([
      { day: days[0], hour: 23 },
    ]);
  });

  it("returns nothing when a corner is not on a visible row", () => {
    expect(rectangleCells(days, { day: "2026-11-20", hour: 9 }, { day: days[0], hour: 9 })).toEqual(
      [],
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  ALIGN_MAX_BACK,
  EARLIER_STEP,
  INITIAL_VISIBLE_ENTRIES,
  alignWindowStart,
  earlierWindowStart,
  transcriptWindowStart,
} from "./transcriptWindow";

describe("transcriptWindowStart", () => {
  it("follows the tail by default", () => {
    const total = INITIAL_VISIBLE_ENTRIES + 91;
    expect(transcriptWindowStart(total, null)).toBe(91);
  });

  it("shows a short history whole", () => {
    expect(transcriptWindowStart(0, null)).toBe(0);
    expect(transcriptWindowStart(11, null)).toBe(0);
    expect(transcriptWindowStart(INITIAL_VISIBLE_ENTRIES, null)).toBe(0);
  });

  it("keeps the reader's absolute start", () => {
    expect(transcriptWindowStart(151, 0)).toBe(0);
    expect(transcriptWindowStart(151, 30)).toBe(30);
  });

  it("clamps a start past the end (a shorter restore replaced the list)", () => {
    expect(transcriptWindowStart(20, 151)).toBe(20);
  });
});

describe("earlierWindowStart", () => {
  it("steps one page at a time and stops at zero", () => {
    expect(earlierWindowStart(151)).toBe(151 - EARLIER_STEP);
    expect(earlierWindowStart(EARLIER_STEP)).toBe(0);
    expect(earlierWindowStart(0)).toBe(0);
  });
});

describe("alignWindowStart", () => {
  // u a a u a a u a a
  const roles = Array.from({ length: 9 }, (_, i) => ({
    role: i % 3 === 0 ? ("user" as const) : ("assistant" as const),
  }));

  it("moves a mid-turn start back to the user message it answers", () => {
    expect(alignWindowStart(roles, 4)).toBe(3);
    expect(alignWindowStart(roles, 8)).toBe(6);
  });

  it("keeps a start that is already a user entry", () => {
    expect(alignWindowStart(roles, 3)).toBe(3);
    expect(alignWindowStart(roles, 0)).toBe(0);
  });

  it("keeps the raw start when no earlier user entry exists", () => {
    const notices = [{ role: "assistant" as const }, { role: "notice" as const }];
    expect(alignWindowStart(notices, 1)).toBe(1);
    expect(alignWindowStart([], 0)).toBe(0);
  });

  it("keeps the raw start when the turn boundary is too far back", () => {
    // One user message, then 150 assistant rounds: the window stays bounded.
    const many = Array.from({ length: 151 }, (_, i) => ({
      role: i === 0 ? ("user" as const) : ("assistant" as const),
    }));
    expect(alignWindowStart(many, 91)).toBe(91);
    expect(alignWindowStart(many, 0)).toBe(0);
    expect(alignWindowStart(many, ALIGN_MAX_BACK)).toBe(0);
    expect(alignWindowStart(many, ALIGN_MAX_BACK + 1)).toBe(ALIGN_MAX_BACK + 1);
  });

  it("clamps a start past the end", () => {
    expect(alignWindowStart(roles, 99)).toBe(6);
  });
});

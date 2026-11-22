import { describe, expect, it } from "vitest";
import { CODE_RESIZER_COUNT, PROJECTS_MIN_WIDTH, projectsDividerWidth } from "./projectsWidth";
import { minColumnWidth, RESIZER_WIDTH } from "@/study/layoutModel";

const host = 1600;

describe("projectsDividerWidth", () => {
  it("moves the column with the pointer", () => {
    const width = projectsDividerWidth(
      { projectsWidth: 240, hostWidth: host, reservedWidth: 1000 },
      60,
    );
    expect(width).toBe(300);
  });

  it("stops at the column's own floor", () => {
    const width = projectsDividerWidth(
      { projectsWidth: 240, hostWidth: host, reservedWidth: 1000 },
      -500,
    );
    expect(width).toBe(PROJECTS_MIN_WIDTH);
  });

  it("leaves the right-hand columns their minimum", () => {
    const reserved = 1000;
    const width = projectsDividerWidth(
      { projectsWidth: 240, hostWidth: host, reservedWidth: reserved },
      2000,
    );
    const notesFloor = minColumnWidth(host);
    expect(width).toBe(host - reserved - CODE_RESIZER_COUNT * RESIZER_WIDTH - notesFloor);
  });
});

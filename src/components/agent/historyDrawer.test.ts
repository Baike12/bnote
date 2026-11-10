import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The history drawer closes on a click anywhere outside it. Two things make
 * that work and both are easy to drop in a refactor: the document-level
 * listener inside the drawer, and the `data-history-toggle` marker on the
 * header button — without the marker the button's own mousedown closes the
 * drawer first, and its click handler then reads the stale `false` and opens
 * it again (the button stops closing the drawer).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const drawer = readFileSync(resolve(root, "src/components/agent/HistoryDrawer.tsx"), "utf8");
const header = readFileSync(resolve(root, "src/components/agent/AgentHeader.tsx"), "utf8");

describe("history drawer dismissal", () => {
  it("listens for a press outside its own node", () => {
    expect(drawer).toMatch(/window\.addEventListener\("pointerdown", onDown, true\)/);
    expect(drawer).toMatch(/target\.closest\("\.agent-history, \[data-history-toggle\]"\)/);
  });

  it("the header button that opens it is exempt from that listener", () => {
    expect(header).toMatch(/data-history-toggle=""/);
  });

  it("also listens for Escape", () => {
    expect(drawer).toMatch(/"Escape"/);
  });
});

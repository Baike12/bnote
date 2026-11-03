import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOLS,
  defaultDefinition,
  effectiveTools,
  idFromName,
  sortDefinitions,
  toggleTool,
  toolChecks,
} from "./definitions";

describe("tools null semantics", () => {
  it("a definition without a tools key shows and runs the default set", () => {
    const def = defaultDefinition("x");
    expect(def.tools).toBeNull();
    expect(toolChecks(def)).toEqual({ on: new Set(DEFAULT_TOOLS), explicit: false });
    expect(effectiveTools(def)).toEqual([...DEFAULT_TOOLS]);
  });

  it("an empty explicit list means no tools (the study shape)", () => {
    const def = { ...defaultDefinition("x"), tools: [] };
    expect(effectiveTools(def)).toEqual([]);
    expect(toolChecks(def)).toEqual({ on: new Set(), explicit: true });
  });

  it("an unrelated no-op flip keeps the list implicit", () => {
    const def = defaultDefinition("x");
    // read_file is already in the defaults: checking it again changes nothing.
    expect(toggleTool(def, "read_file", true).tools).toBeNull();
  });

  it("the first real flip materializes the list", () => {
    const def = defaultDefinition("x");
    const off = toggleTool(def, "read_file", false);
    expect(off.tools).not.toContain("read_file");
    const on = toggleTool(off, "read_file", true);
    expect(on.tools).not.toBeNull();
    expect(on.tools).toContain("read_file");
  });

  it("checking a tool that is not in the defaults materializes it", () => {
    const def = defaultDefinition("x");
    const next = toggleTool(def, "mcp", true);
    expect(next.tools).toContain("mcp");
  });

  it("deny removes a tool from the effective set but keeps it listed", () => {
    const def = {
      ...defaultDefinition("x"),
      permissions: { bash: "deny" as const },
    };
    expect(effectiveTools(def)).not.toContain("bash");
    expect(toolChecks(def).on).toContain("bash");
  });
});

describe("idFromName", () => {
  it("slugs the name and avoids collisions", () => {
    expect(idFromName("代码评审", new Set())).toBe("agent");
    expect(idFromName("My Reviewer!", new Set())).toBe("my-reviewer");
    const taken = new Set(["reviewer"]);
    expect(idFromName("Reviewer", taken)).toBe("reviewer-2");
  });
});

describe("sortDefinitions", () => {
  it("builtins first, then user files, both by id", () => {
    const sorted = sortDefinitions([
      { id: "zzz", name: "", description: "", source: "user", tools: [] },
      { id: "coding", name: "", description: "", source: "builtin", tools: [] },
      { id: "aaa", name: "", description: "", source: "user", tools: [] },
      { id: "creative", name: "", description: "", source: "builtin", tools: [] },
    ]);
    expect(sorted.map((d) => d.id)).toEqual(["coding", "creative", "aaa", "zzz"]);
  });
});

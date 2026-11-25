import { describe, expect, it } from "vitest";
import type { McpScope } from "@/lib/tauri";
import {
  disabledOf,
  effectiveServers,
  mcpTarget,
  scopesDisabling,
  serversOf,
  settingsObject,
  withDisabled,
  withServers,
} from "./mcpScopes";

/**
 * The MCP settings page merges the vault's user file with the code project's
 * two files. The merge rules are the backend's (later scope wins a name, the
 * disabled lists union), so a mistake here would show a server as enabled that
 * the agent never starts, or write a toggle to a file that loses the merge.
 */

function files(
  user: Record<string, unknown> = {},
  project?: Record<string, unknown>,
  local?: Record<string, unknown>,
): Partial<Record<McpScope, Record<string, unknown>>> {
  const out: Partial<Record<McpScope, Record<string, unknown>>> = { user };
  if (project) out.project = project;
  if (local) out.local = local;
  return out;
}

const all: McpScope[] = ["user", "project", "local"];

describe("mcpScopes", () => {
  it("a broken or empty file parses as an empty object", () => {
    expect(settingsObject(undefined)).toEqual({});
    expect(settingsObject("")).toEqual({});
    expect(settingsObject("{ nope")).toEqual({});
    expect(settingsObject("[]")).toEqual({});
    expect(settingsObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("reads the server map and the toggle list defensively", () => {
    expect(serversOf({ mcpServers: { a: {} } })).toEqual({ a: {} });
    expect(serversOf({ mcpServers: [] })).toEqual({});
    expect(disabledOf({ disabledMcpServers: ["a", 1] })).toEqual(["a", "1"]);
    expect(disabledOf({})).toEqual([]);
  });

  it("describes a stdio command line and an HTTP url", () => {
    expect(mcpTarget({ command: "npx", args: ["-y", "srv"] })).toBe("npx -y srv");
    expect(mcpTarget({ type: "http", url: "http://x/mcp" })).toBe("http://x/mcp");
    expect(mcpTarget({})).toBe("(配置不完整)");
  });

  it("a later scope wins a name and keeps its own definition", () => {
    const rows = effectiveServers(
      files(
        {
          mcpServers: { shared: { type: "stdio", command: "u" }, only: { type: "http", url: "u" } },
        },
        { mcpServers: { shared: { type: "http", url: "p" } } },
      ),
      all,
    );
    const shared = rows.find((row) => row.name === "shared");
    expect(shared?.scope).toBe("project");
    expect(shared?.transport).toBe("http");
    expect(shared?.target).toBe("p");
    expect(rows.find((row) => row.name === "only")?.scope).toBe("user");
    // Only the user scope runs unapproved; the report settles the rest.
    expect(rows.find((row) => row.name === "only")?.trusted).toBe(true);
    expect(rows.find((row) => row.name === "shared")?.trusted).toBe(false);
  });

  it("a name disabled in any layer is disabled (the merged list is a union)", () => {
    const rows = effectiveServers(
      files(
        { mcpServers: {}, disabledMcpServers: ["x"] },
        { mcpServers: { x: { type: "stdio", command: "x" } } },
      ),
      all,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("project");
    expect(rows[0].enabled).toBe(false);
  });

  it("names the disabled scopes so enabling edits every one of them", () => {
    const map = files(
      { disabledMcpServers: ["x"] },
      { disabledMcpServers: ["x", "y"] },
      { disabledMcpServers: [] },
    );
    expect(scopesDisabling(map, all, "x")).toEqual(["user", "project"]);
    expect(scopesDisabling(map, all, "y")).toEqual(["project"]);
    expect(scopesDisabling(map, all, "z")).toEqual([]);
  });

  it("toggling writes one file and keeps its other keys", () => {
    const file = { model: "m", mcpServers: { a: {} } };
    const off = withDisabled(file, "a", false);
    expect(off).toEqual({ model: "m", mcpServers: { a: {} }, disabledMcpServers: ["a"] });
    expect("disabledMcpServers" in file).toBe(false);
    expect(withDisabled(off, "a", false)).toEqual(off);
    const on = withDisabled(off, "a", true);
    expect(disabledOf(on)).toEqual([]);
    expect("disabledMcpServers" in on).toBe(false);
  });

  it("editing mcpServers preserves the rest of the file", () => {
    expect(withServers({ model: "m", hooks: {} }, { a: {} })).toEqual({
      model: "m",
      hooks: {},
      mcpServers: { a: {} },
    });
  });
});

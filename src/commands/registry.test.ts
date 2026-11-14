import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, getCommand, registerCommands, runCommand, type CommandDef } from "./registry";

/**
 * The registry is the one table behind the palette, the hotkey settings and
 * the window dispatcher. `builtin.ts` registers the real command table at
 * module load and builtin.test.ts gates that surface; these tests drive the
 * module with synthetic commands so registration, lookup and the run contract
 * are isolated from it.
 */

const ran: string[] = [];

function command(id: string, overrides: Partial<CommandDef> = {}): CommandDef {
  return {
    id,
    title: id,
    category: "测试",
    run: () => {
      ran.push(id);
    },
    ...overrides,
  };
}

afterEach(() => {
  ran.length = 0;
  vi.restoreAllMocks();
});

describe("registration and lookup", () => {
  it("a registered command is listed and found by its id", () => {
    const def = command("registry.one");
    registerCommands([def]);

    expect(allCommands()).toContain(def);
    expect(getCommand("registry.one")).toBe(def);
  });

  it("registering the same id again replaces the definition instead of adding a second entry", () => {
    registerCommands([command("registry.duplicate", { title: "第一次" })]);
    registerCommands([command("registry.duplicate", { title: "第二次" })]);

    const matches = allCommands().filter((c) => c.id === "registry.duplicate");
    expect(matches).toHaveLength(1);
    // The later definition owns the id: the registry is a Map keyed by id, so
    // re-registering can never leave two handlers competing for one command.
    expect(getCommand("registry.duplicate")?.title).toBe("第二次");
  });

  it("registering an empty list changes nothing", () => {
    const before = allCommands().length;
    registerCommands([]);
    expect(allCommands()).toHaveLength(before);
  });

  it("the command list is a copy, so a caller cannot empty the registry", () => {
    const listed = allCommands();
    listed.length = 0;
    expect(allCommands().length).toBeGreaterThan(0);
  });

  it("an unknown id is not found", () => {
    expect(getCommand("registry.never-registered")).toBeUndefined();
  });
});

describe("running a command", () => {
  it("runs the handler exactly once", () => {
    registerCommands([command("registry.runs")]);
    runCommand("registry.runs");
    expect(ran).toEqual(["registry.runs"]);
  });

  it("does nothing while the command's when guard is false", () => {
    registerCommands([command("registry.guarded", { when: () => false })]);
    runCommand("registry.guarded");
    expect(ran).toEqual([]);
  });

  it("runs the handler when the when guard holds", () => {
    registerCommands([command("registry.allowed", { when: () => true })]);
    runCommand("registry.allowed");
    expect(ran).toEqual(["registry.allowed"]);
  });

  it("an unknown id warns instead of throwing: a stale binding must not break the dispatcher", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => runCommand("registry.gone")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("registry.gone");
  });

  it("a rejected async handler is logged, not rethrown at the dispatcher", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerCommands([
      command("registry.fails", {
        run: async () => {
          throw new Error("boom");
        },
      }),
    ]);

    expect(() => runCommand("registry.fails")).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(String(error.mock.calls[0]?.[0])).toContain("registry.fails");
  });
});

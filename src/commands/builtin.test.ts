import { describe, expect, it } from "vitest";
import "@/commands/builtin";
import {
  DEFAULT_BINDINGS,
  commandsForKey,
  defaultBindingsFor,
  defaultRegionsOf,
  bindingsForCommand,
  KEY_REGION_IDS,
} from "./keys";
import { UNBOUND_BY_DESIGN } from "./keybindingsDoc";
import { allCommands, getCommand } from "./registry";

/**
 * The command registry is the single surface behind the palette, the
 * keybinding settings and the window dispatcher. A command definition that
 * loses its id, duplicates another one, or is referenced by a default binding
 * but never registered is invisible until a user presses the key and nothing
 * happens.
 */

describe("the registered command surface", () => {
  const commands = allCommands();

  it("is not empty and has unique ids", () => {
    expect(commands.length).toBeGreaterThan(50);
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every command has a title, a category and a callable run", () => {
    for (const command of commands) {
      expect(command.id, JSON.stringify(command.id)).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
      expect(command.title.trim(), command.id).not.toBe("");
      expect(command.category.trim(), command.id).not.toBe("");
      expect(typeof command.run, command.id).toBe("function");
    }
  });

  it("every default binding points at a registered command", () => {
    const missing = Object.keys(DEFAULT_BINDINGS).filter((id) => !getCommand(id));
    expect(missing).toEqual([]);
  });

  it("the palette can find a command by id", () => {
    for (const command of commands) expect(getCommand(command.id)).toBe(command);
  });

  it("every id carries the same category wherever it lives: one prefix, one name in the palette", () => {
    // The palette groups by category, so the same prefix under two names
    // would split one group in two. `region.*` is the single documented
    // exception: the focus commands and the switched-to area are separate
    // groups on purpose.
    const byPrefix = new Map<string, Set<string>>();
    for (const command of commands) {
      const prefix = command.id.split(".")[0] ?? "";
      const categories = byPrefix.get(prefix) ?? new Set<string>();
      categories.add(command.category);
      byPrefix.set(prefix, categories);
    }
    const split = [...byPrefix]
      .filter(([prefix, categories]) => prefix !== "region" && categories.size > 1)
      .map(([prefix, categories]) => `${prefix}: ${[...categories].join(" / ")}`);
    expect(split).toEqual([]);
  });

  it("a keepsPageFocus command is reachable by a key, otherwise the flag protects nothing", () => {
    const unreachable = commands
      .filter((command) => command.keepsPageFocus)
      .filter((command) => bindingsForCommand(command.id).length === 0)
      .map((command) => command.id);
    expect(unreachable).toEqual([]);
  });

  it("the deliberately unbound document lists real commands that really carry no key", () => {
    for (const [id, why] of Object.entries(UNBOUND_BY_DESIGN)) {
      expect(getCommand(id), `${id}: ${why}`).toBeDefined();
      expect(bindingsForCommand(id), id).toEqual([]);
    }
  });

  it("every command belongs to at least one region tab, so none can vanish from the settings page", () => {
    const homeless = commands
      .filter(
        (command) =>
          !KEY_REGION_IDS.some((region) => defaultRegionsOf(command.id).includes(region)),
      )
      .map((command) => command.id);
    expect(homeless).toEqual([]);
  });

  it("every default binding resolves to its own command in the region it was placed in, and comes first", () => {
    // The full round trip: binding table → region placement → key index →
    // dispatch candidates. A binding that does not come back first is a
    // binding that silently lost its key to another command.
    const broken: string[] = [];
    for (const [id] of Object.entries(DEFAULT_BINDINGS)) {
      for (const region of defaultRegionsOf(id)) {
        for (const key of defaultBindingsFor(id, region)) {
          const candidates = commandsForKey(key, region);
          if (candidates[0] !== id)
            broken.push(`${id} (${key} in ${region}) → ${candidates.join(", ")}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("a default binding is placed exactly in the regions its command declares", () => {
    const mismatched: string[] = [];
    for (const [id] of Object.entries(DEFAULT_BINDINGS)) {
      for (const region of defaultRegionsOf(id)) {
        if (defaultBindingsFor(id, region).length === 0) continue;
        const candidates = commandsForKey(defaultBindingsFor(id, region)[0]!, region);
        if (!candidates.includes(id)) mismatched.push(`${id} missing in ${region}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("when guards are safe to ask before the command runs: every one returns a boolean and none throws", () => {
    const failures: string[] = [];
    for (const command of commands) {
      if (!command.when) continue;
      try {
        if (typeof command.when() !== "boolean") failures.push(`${command.id}: non-boolean`);
      } catch (e) {
        failures.push(`${command.id}: ${String(e)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

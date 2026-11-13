import { describe, expect, it } from "vitest";
import "@/commands/builtin";
import { DEFAULT_BINDINGS } from "./keys";
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
});

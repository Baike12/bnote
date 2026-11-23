import { describe, expect, it } from "vitest";
import { pickFocusedSurface } from "./surfaces";

/**
 * Which editor owns the text focus: the one whose DOM root contains the active
 * element. The IME intent follows that editor's vim mode, so a view that lost
 * the focus must not answer for it.
 */

const surface = (name: string, contains: (node: Node | null) => boolean) => ({
  name,
  dom: { contains },
});

const node = (id: string) => ({ id }) as unknown as Node;

describe("pickFocusedSurface", () => {
  it("returns the surface that contains the active element", () => {
    const active = node("active");
    const notes = surface("notes", () => false);
    const composer = surface("composer", (n) => n === active);
    expect(pickFocusedSurface(active, [notes, composer])).toBe(composer);
  });

  it("no active element means no surface (the window lost the focus)", () => {
    expect(pickFocusedSurface(null, [surface("notes", () => true)])).toBeNull();
  });

  it("a focus outside every editor (a button, a dialog) picks nothing", () => {
    expect(pickFocusedSurface(node("button"), [surface("notes", () => false)])).toBeNull();
  });
});

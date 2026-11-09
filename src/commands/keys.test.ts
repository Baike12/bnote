import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BINDINGS,
  FIXED_PAGE_COMMANDS,
  applyOverrides,
  bindingsForCommand,
  commandBelongs,
  commandRegions,
  commandsForKey,
  defaultBindingsFor,
  defaultRegionOf,
  defaultRegionsOf,
  eventKeyName,
  eventToKey,
  fixedPageCommandFor,
  formOwnsEditChord,
  isPlainFocusOwnedKey,
  keysOf,
  normalizeOverrides,
  pageForwardKeys,
  parseBinding,
  serializeOverrides,
} from "./keys";

const reset = () => applyOverrides({});
afterEach(reset);

/**
 * Gate for unique ownership of the default bindings. After regions were
 * introduced the "same key" may appear in different regions (each taking
 * effect on its own), but **within one region** it must not repeat: the
 * window-level dispatch takes the first command in registration order, and a
 * silent takeover is much harder to debug than a failure.
 */
describe("default bindings", () => {
  it("no key is bound twice inside one region", () => {
    const byRegion = new Map<string, string[]>();
    for (const [id] of Object.entries(DEFAULT_BINDINGS)) {
      for (const region of defaultRegionsOf(id)) {
        // The region's own default, not the shared one: a per-region default
        // (REGION_DEFAULTS) is what actually fires there.
        for (const key of defaultBindingsFor(id, region)) {
          const list = byRegion.get(region) ?? [];
          list.push(`${id}:${key}`);
          byRegion.set(region, list);
        }
      }
    }
    for (const [region, list] of byRegion) {
      const seen = new Map<string, string>();
      const dupes: string[] = [];
      for (const entry of list) {
        const key = entry.slice(entry.lastIndexOf(":") + 1);
        if (seen.has(key)) dupes.push(`${seen.get(key)} / ${entry}`);
        else seen.set(key, entry);
      }
      expect(dupes, `${region} 区域重复键位`).toEqual([]);
    }
  });

  it("Mod-Shift-o belongs to workspace.open-daily, and nobody else in the global region duplicates it", () => {
    expect(bindingsForCommand("workspace.open-daily")).toEqual(["Mod-Shift-o"]);
    // The same key may appear in another region — after regions were
    // introduced each takes effect on its own (the gate above guards "no
    // duplicate within one region"). The code region uses ⌘⇧O for "quick
    // open file"; this one guards that **the global region** has no second
    // command grabbing this key.
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) =>
        id !== "workspace.open-daily" &&
        defaultRegionsOf(id).includes("global") &&
        keysOf(key).includes("Mod-Shift-o"),
    );
    expect(others).toEqual([]);
  });

  it("workspace.open-vault no longer takes Mod-Shift-o (it is still callable from the command palette)", () => {
    expect(bindingsForCommand("workspace.open-vault")).toEqual([]);
  });

  it("Mod-Shift-b belongs to edit.insert-callout, and nobody else duplicates it", () => {
    expect(bindingsForCommand("edit.insert-callout")).toEqual(["Mod-Shift-b"]);
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) => id !== "edit.insert-callout" && key === "Mod-Shift-b",
    );
    expect(others).toEqual([]);
  });

  it("Mod-Shift-r belongs to workspace.switch-recent-vault, and nobody else duplicates it", () => {
    expect(bindingsForCommand("workspace.switch-recent-vault")).toEqual(["Mod-Shift-r"]);
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) => id !== "workspace.switch-recent-vault" && key === "Mod-Shift-r",
    );
    expect(others).toEqual([]);
  });

  it("PDF paging defaults to PageUp/PageDown (with the arrow keys), and nobody else duplicates them", () => {
    expect(bindingsForCommand("study.pdf-prev-page")).toEqual(["PageUp", "ArrowLeft"]);
    expect(bindingsForCommand("study.pdf-next-page")).toEqual(["PageDown", "ArrowRight"]);
    const used = ["PageUp", "PageDown", "ArrowLeft", "ArrowRight"];
    const others = Object.entries(DEFAULT_BINDINGS).flatMap(([id, key]) => {
      if (id.startsWith("study.pdf-")) return [];
      return keysOf(key)
        .filter((k) => used.includes(k))
        .map((k) => `${id}:${k}`);
    });
    expect(others).toEqual([]);
  });

  it("⌘⇧E: the screenshot in the reading region and the focus file tree in the code region each belong to their own region", () => {
    expect(bindingsForCommand("study.pdf-snap-to-agent")).toEqual(["Mod-Shift-e"]);
    expect(defaultRegionOf("study.pdf-snap-to-agent")).toBe("reading");
    // The code region's "focus file tree" uses the same physical key. Each
    // region has its own binding and they do not interfere (a region's own
    // binding is ordered before the cross-region chords, see
    // commandsForKey).
    expect(bindingsForCommand("code.focus-tree")).toEqual(["Mod-Shift-e"]);
    expect(defaultRegionOf("code.focus-tree")).toBe("code");
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) =>
        id !== "study.pdf-snap-to-agent" &&
        id !== "code.focus-tree" &&
        keysOf(key).includes("Mod-Shift-e"),
    );
    expect(others).toEqual([]);
  });
});

describe("focus mode: only a start, no way out halfway", () => {
  it("starting the pomodoro is bound to ⌘⌥T, and it is the only focus binding", () => {
    expect(bindingsForCommand("focus.pomodoro-start")).toEqual(["Mod-Alt-t"]);
    expect(commandsForKey("Mod-Alt-t", "global")).toContain("focus.pomodoro-start");
  });

  it("there is no binding for pause / stop / enter-exit exclusive / hard lock toggle", () => {
    for (const id of [
      "focus.timer-toggle",
      "focus.timer-stop",
      "focus.lock-toggle",
      "focus.lock-exit",
      "focus.hard-lock-toggle",
    ]) {
      expect(DEFAULT_BINDINGS[id], id).toBeUndefined();
      expect(bindingsForCommand(id), id).toEqual([]);
    }
  });
});

/** Region ownership: who takes effect in which region, and how a region overrides the global one. */
describe("region dispatch", () => {
  it("commands are assigned to their default region by semantics", () => {
    expect(defaultRegionOf("edit.toggle-bold")).toBe("notes");
    expect(defaultRegionOf("nav.header-todos")).toBe("notes");
    expect(defaultRegionOf("study.pdf-next-page")).toBe("reading");
    expect(defaultRegionOf("region.focus-agent")).toBe("reading");
    expect(defaultRegionOf("agent.new-session")).toBe("agent");
    expect(defaultRegionOf("study.agent-switch-session")).toBe("agent");
    expect(defaultRegionOf("nav.command-palette")).toBe("global");
    expect(defaultRegionOf("view.toggle-study-mode")).toBe("global");
  });

  it("the three region switch commands exist in every region (any region can go to any region, including back to itself)", () => {
    for (const id of ["region.focus-agent", "region.focus-notes", "region.focus-reading"]) {
      for (const region of ["reading", "notes", "agent", "code"] as const) {
        expect(commandBelongs(id, region)).toBe(true);
      }
    }
    // Code mode is a three-column layout too: the caret can go back to the
    // notes column, the agent panel, and the content column (the open file).
    for (const id of ["region.focus-agent", "region.focus-notes", "region.focus-reading"]) {
      expect(defaultRegionsOf(id)).toEqual(["reading", "notes", "agent", "code"]);
      expect(commandBelongs(id, "code")).toBe(true);
    }
    expect(defaultRegionOf("region.focus-agent")).toBe("reading");
    expect(commandsForKey("Mod-Alt-a", "reading")).toContain("region.focus-agent");
    expect(commandsForKey("Mod-Alt-a", "notes")).toContain("region.focus-agent");
    // ⌘⌥A inside the Agent panel sends the focus back to its input: it must
    // work when pressed in the message list / history too.
    expect(commandsForKey("Mod-Alt-a", "agent")).toContain("region.focus-agent");
    expect(commandsForKey("Mod-Alt-n", "reading")).toContain("region.focus-notes");
    expect(commandsForKey("Mod-Alt-n", "notes")).toContain("region.focus-notes");
    expect(commandsForKey("Mod-Alt-n", "agent")).toContain("region.focus-notes");
    expect(commandsForKey("Mod-Alt-r", "notes")).toContain("region.focus-reading");
    expect(commandsForKey("Mod-Alt-r", "reading")).toContain("region.focus-reading");
    expect(commandsForKey("Mod-Alt-r", "agent")).toContain("region.focus-reading");
    expect(commandsForKey("Mod-Alt-r", "code")).toContain("region.focus-reading");
    expect(commandsForKey("Mod-Alt-a", "code")).toContain("region.focus-agent");
    expect(bindingsForCommand("region.focus-agent")).toEqual(["Mod-Alt-a"]);
  });

  /**
   * ⌘N is the code region's "fork this session" and the notes region's "new
   * note": the same key, two meanings, decided by where the focus is. The
   * code region inherits no note command, so without this its ⌘N would be a
   * dead key while the panel sits right next to the code.
   */
  it("⌘N forks in the code region and still makes a note in the notes region", () => {
    expect(commandsForKey("Mod-n", "code")).toEqual(["agent.fork-session"]);
    expect(commandsForKey("Mod-n", "notes")).toEqual(["workspace.new-note"]);
    expect(commandsForKey("Mod-[", "code")).toEqual(["agent.back-from-fork"]);
    // The command keeps its own key where it already lived.
    expect(commandsForKey("Mod-Shift-f", "agent")).toContain("agent.fork-session");
    expect(defaultBindingsFor("agent.fork-session", "code")).toEqual(["Mod-n"]);
    expect(defaultBindingsFor("agent.fork-session", "agent")).toEqual(["Mod-Shift-f"]);
    expect(defaultRegionsOf("agent.fork-session")).toEqual(["agent", "code"]);
  });

  it("a notes region key does not fire in the Agent panel, while a global key works everywhere", () => {
    expect(commandsForKey("Mod-b", "notes")).toContain("edit.toggle-bold");
    expect(commandsForKey("Mod-b", "agent")).not.toContain("edit.toggle-bold");
    expect(commandsForKey("Mod-p", "agent")).toContain("nav.command-palette");
    expect(commandsForKey("Mod-p", "reading")).toContain("nav.command-palette");
  });

  it("the region binding comes before the global binding of the same key (in the Agent panel ⌘[ is back to the session)", () => {
    expect(commandsForKey("Mod-[", "agent")[0]).toBe("agent.back-from-fork");
    expect(commandsForKey("Mod-[", "agent")).toContain("nav.back-link");
    // The notes region has no region binding, so ⌘[ is still the back-link.
    expect(commandsForKey("Mod-[", "notes")).toEqual(["nav.back-link"]);
  });

  it("null unbinding: the key no longer fires a command in that region", () => {
    applyOverrides({ notes: { "edit.toggle-italic": null } });
    expect(bindingsForCommand("edit.toggle-italic")).toEqual([]);
    expect(commandsForKey("Mod-Shift-i", "notes")).not.toContain("edit.toggle-italic");
  });

  it("regions do not affect each other: a binding added in another region leaves the original region's default binding in place", () => {
    applyOverrides(normalizeOverrides({ agent: { "study.pdf-next-page": "Mod-j" } }));
    expect(commandRegions("study.pdf-next-page")).toEqual(["reading", "agent"]);
    expect(bindingsForCommand("study.pdf-next-page", "agent")).toEqual(["Mod-j"]);
    expect(bindingsForCommand("study.pdf-next-page", "reading")).toEqual([
      "PageDown",
      "ArrowRight",
    ]);
    expect(commandsForKey("Mod-j", "agent")).toContain("study.pdf-next-page");
    expect(commandsForKey("PageDown", "reading")).toContain("study.pdf-next-page");
  });

  it("an unbinding only affects the current region", () => {
    applyOverrides(normalizeOverrides({ notes: { "region.focus-agent": null } }));
    expect(bindingsForCommand("region.focus-agent", "notes")).toEqual([]);
    expect(bindingsForCommand("region.focus-agent", "reading")).toEqual(["Mod-Alt-a"]);
    expect(commandsForKey("Mod-Alt-a", "notes")).not.toContain("region.focus-agent");
  });

  it("the paging chord crosses regions: pressing it in the notes region / Agent panel also hits the reading region's binding", () => {
    applyOverrides(
      normalizeOverrides({
        reading: {
          "study.pdf-prev-page": "Ctrl-k",
          "study.pdf-next-page": "Ctrl-j",
        },
      }),
    );
    for (const region of ["notes", "agent"] as const) {
      expect(commandsForKey("Ctrl-j", region)).toContain("study.pdf-next-page");
      expect(commandsForKey("Ctrl-k", region)).toContain("study.pdf-prev-page");
    }
    // The reading region does not list it twice.
    expect(
      commandsForKey("Ctrl-j", "reading").filter((id) => id === "study.pdf-next-page"),
    ).toEqual(["study.pdf-next-page"]);
  });

  it("the bare paging navigation keys still belong to the reading region only (they do not steal the editor caret keys)", () => {
    expect(commandsForKey("PageDown", "reading")).toContain("study.pdf-next-page");
    expect(commandsForKey("PageDown", "notes")).not.toContain("study.pdf-next-page");
    expect(commandsForKey("ArrowRight", "agent")).not.toContain("study.pdf-next-page");
    // Cross-region only holds for chords with Mod/Ctrl/Alt.
    applyOverrides(normalizeOverrides({ reading: { "study.pdf-next-page": "F5" } }));
    expect(commandsForKey("F5", "notes")).not.toContain("study.pdf-next-page");
  });

  it("the screenshot chord crosses regions too: with the focus in the Agent panel / notes region it also hits the reading region's binding", () => {
    expect(commandsForKey("Mod-Shift-e", "reading")).toContain("study.pdf-snap-to-agent");
    // In the code region the same key first hits its own "focus file tree",
    // and the screenshot does not run along (pickCommand takes only the
    // first command whose when holds).
    expect(commandsForKey("Mod-Shift-e", "code")[0]).toBe("code.focus-tree");
    for (const region of ["notes", "agent"] as const) {
      expect(commandsForKey("Mod-Shift-e", region)).toContain("study.pdf-snap-to-agent");
    }
  });

  it("the region navigation chord crosses regions: bound only in the reading region, pressing it in the Agent panel works too", () => {
    applyOverrides(normalizeOverrides({ reading: { "region.focus-agent": "Mod-Shift-w" } }));
    expect(commandsForKey("Mod-Shift-w", "reading")).toContain("region.focus-agent");
    for (const region of ["notes", "agent"] as const) {
      expect(commandsForKey("Mod-Shift-w", region)).toContain("region.focus-agent");
    }
  });

  it("⌘Q quits from every region, including the code editor (which only inherits whitelisted globals)", () => {
    applyOverrides({});
    expect(DEFAULT_BINDINGS["app.quit"]).toBe("Mod-q");
    for (const region of ["global", "notes", "reading", "agent", "project", "code"] as const) {
      expect(commandsForKey("Mod-q", region), region).toContain("app.quit");
    }
  });

  it("the cross-region effect holds except for an explicit unbinding: once a region unbinds it, it no longer revives from elsewhere", () => {
    applyOverrides(
      normalizeOverrides({
        reading: { "region.focus-agent": "Mod-Shift-w" },
        agent: { "region.focus-agent": null },
      }),
    );
    expect(commandsForKey("Mod-Shift-w", "notes")).toContain("region.focus-agent");
    expect(commandsForKey("Mod-Shift-w", "agent")).not.toContain("region.focus-agent");
  });

  it("while a modal is open (region = global) cross-region commands are not let through, the focus is not stolen", () => {
    // Only global commands are recognized inside a modal: ⌘⌥A must not hand
    // the focus to the Agent input, and paging must not scroll behind it.
    expect(commandsForKey("Mod-Alt-a", "global")).toEqual([]);
    expect(commandsForKey("Mod-Shift-e", "global")).toEqual([]);
    expect(commandsForKey("Ctrl-j", "global")).toEqual([]);
    expect(commandsForKey("Mod-p", "global")).toEqual(["nav.command-palette"]);
  });

  it("the region's own binding wins: when the notes region binds the same key to another command, pressing it in the notes still runs that one", () => {
    applyOverrides(
      normalizeOverrides({
        notes: { "edit.toggle-todo": "Mod-w" },
        reading: { "study.pdf-snap-to-agent": "Mod-w" },
      }),
    );
    // The notes region: its own binding comes first, the cross-region
    // screenshot comes after.
    expect(commandsForKey("Mod-w", "notes")[0]).toBe("edit.toggle-todo");
    // The Agent panel has no Mod-w of its own, so it falls through to the
    // reading region's screenshot.
    expect(commandsForKey("Mod-w", "agent")).toEqual(["study.pdf-snap-to-agent"]);
  });

  it("⌘A is not intercepted by default; when it is written only into the notes region, the Agent / reading region let it through unchanged", () => {
    expect(commandsForKey("Mod-a", "notes")).toEqual([]);
    expect(commandsForKey("Mod-a", "agent")).toEqual([]);
    applyOverrides(normalizeOverrides({ notes: { "edit.toggle-todo": "Mod-a" } }));
    expect(commandsForKey("Mod-a", "notes")).toContain("edit.toggle-todo");
    expect(commandsForKey("Mod-a", "agent")).toEqual([]);
    expect(commandsForKey("Mod-a", "reading")).toEqual([]);
  });
});

/** Config file: the new format is grouped by region, the legacy flat table is split automatically (an upgrade loses no keybinding). */
describe("config file read and write", () => {
  it("the legacy flat table is split into regions by each command's default region", () => {
    const overrides = normalizeOverrides({
      "edit.toggle-bold": "Mod-b",
      "study.pdf-next-page": "Ctrl-j",
      "nav.command-palette": "Mod-p",
      "edit.toggle-italic": null,
    });
    expect(overrides.notes).toEqual({
      "edit.toggle-bold": "Mod-b",
      "edit.toggle-italic": null,
    });
    expect(overrides.reading).toEqual({ "study.pdf-next-page": "Ctrl-j" });
    expect(overrides.global).toEqual({ "nav.command-palette": "Mod-p" });
    expect(overrides.agent).toBeUndefined();
  });

  it("the new format is read per region, and explanatory fields like _hint are ignored", () => {
    const overrides = normalizeOverrides({
      _hint: "说明",
      global: { "nav.command-palette": ["Mod-p", "Mod-Shift-p"] },
      agent: { "agent.new-session": null },
    });
    expect(overrides.global).toEqual({ "nav.command-palette": ["Mod-p", "Mod-Shift-p"] });
    expect(overrides.agent).toEqual({ "agent.new-session": null });
  });

  it("invalid values are dropped and empty entries in an array are removed", () => {
    const overrides = normalizeOverrides({
      notes: { "edit.toggle-bold": 42, "edit.toggle-italic": ["", "Mod-i"] },
    });
    expect(overrides.notes).toEqual({ "edit.toggle-italic": ["Mod-i"] });
  });

  it("only the overrides are written, and they read back unchanged", () => {
    const overrides = normalizeOverrides({
      reading: { "study.pdf-prev-page": "Ctrl-k" },
      agent: { "agent.focus-history": "Mod-Shift-h" },
    });
    const text = serializeOverrides(overrides);
    expect(text).toContain("_hint");
    expect(text).toContain("study.pdf-prev-page");
    expect(text).not.toContain('"notes"');
    expect(normalizeOverrides(JSON.parse(text))).toEqual(overrides);
  });
});

/** Key ownership of the editor/inputs: bare navigation keys belong to them, modified bindings take effect under any focus. */
describe("ownership of the bare navigation keys", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    }) as KeyboardEvent;

  it("unmodified paging / arrow keys belong to the editor, window-level commands must not take them", () => {
    expect(isPlainFocusOwnedKey(ev("PageDown"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("PageUp"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("ArrowLeft"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("ArrowRight"))).toBe(true);
  });

  it("a combination with a modifier (such as Ctrl-J) goes to the command under any focus", () => {
    expect(isPlainFocusOwnedKey(ev("j", { ctrlKey: true }))).toBe(false);
    expect(isPlainFocusOwnedKey(ev("PageDown", { shiftKey: true }))).toBe(false);
    expect(isPlainFocusOwnedKey(ev("j", { metaKey: true }))).toBe(false);
  });

  it("an ordinary character is not a navigation key", () => {
    expect(isPlainFocusOwnedKey(ev("j"))).toBe(false);
  });
});

/** The editing chords of the text input controls (input/textarea): even when the same region binds them, they may not be taken. */
describe("form editing chords", () => {
  it("input/textarea own ⌘A/C/X/V/⌘Z, other elements and other keys are not let through", () => {
    for (const tag of ["INPUT", "TEXTAREA"]) {
      for (const key of ["Mod-a", "Mod-c", "Mod-x", "Mod-v", "Mod-z", "Mod-Shift-z"]) {
        expect(formOwnsEditChord(key, tag), `${tag} ${key}`).toBe(true);
      }
      expect(formOwnsEditChord("Ctrl-j", tag)).toBe(false);
    }
    // The contenteditable editor is not an INPUT/TEXTAREA: in the notes
    // region ⌘A belongs to the command.
    expect(formOwnsEditChord("Mod-a", "DIV")).toBe(false);
    expect(formOwnsEditChord("Mod-a", null)).toBe(false);
    expect(formOwnsEditChord("Mod-a", "SELECT")).toBe(false);
  });
});

/** PageUp/PageDown are the fixed paging keys that cannot be overridden: they still page after a rebind. */
describe("fixed paging keys", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    }) as KeyboardEvent;

  it("PageUp/PageDown map to the previous page / the next page", () => {
    expect(FIXED_PAGE_COMMANDS).toEqual({
      PageUp: "study.pdf-prev-page",
      PageDown: "study.pdf-next-page",
    });
    expect(fixedPageCommandFor(ev("PageUp"))).toBe("study.pdf-prev-page");
    expect(fixedPageCommandFor(ev("PageDown"))).toBe("study.pdf-next-page");
  });

  it("after rebinding study.pdf-* the fixed keys still take effect", () => {
    applyOverrides({ reading: { "study.pdf-next-page": "Mod-j" } });
    expect(bindingsForCommand("study.pdf-next-page")).toEqual(["Mod-j"]);
    expect(fixedPageCommandFor(ev("PageDown"))).toBe("study.pdf-next-page");
  });

  it("a modifier or another key does not trigger the fixed paging", () => {
    expect(fixedPageCommandFor(ev("PageDown", { shiftKey: true }))).toBeNull();
    expect(fixedPageCommandFor(ev("PageDown", { ctrlKey: true }))).toBeNull();
    expect(fixedPageCommandFor(ev("j"))).toBeNull();
  });
});

/**
 * The main key of a binding string may itself be "-" (⌘− is written
 * "Mod--"). Splitting on the separator would cut it into a row of empty
 * strings — the web runtime and the keybinding display both use
 * parseBinding, and this gate locks both sides.
 */
describe("binding parsing", () => {
  it("a main key of minus is not broken apart by the separator", () => {
    expect(parseBinding("Mod--")).toEqual({ mods: ["Mod"], key: "-" });
    expect(parseBinding("Mod-Shift--")).toEqual({ mods: ["Mod", "Shift"], key: "-" });
  });

  it("ordinary chords and single keys work as before", () => {
    expect(parseBinding("Mod-Shift-=")).toEqual({ mods: ["Mod", "Shift"], key: "=" });
    expect(parseBinding("Mod-,")).toEqual({ mods: ["Mod"], key: "," });
    expect(parseBinding("PageDown")).toEqual({ mods: [], key: "PageDown" });
  });

  it("every default binding parses into a non-empty main key", () => {
    for (const [id, value] of Object.entries(DEFAULT_BINDINGS)) {
      for (const key of keysOf(value)) {
        expect(parseBinding(key).key, `${id} ${key}`).not.toBe("");
      }
    }
  });
});

/** Web zoom: ⌘= / ⌘- / ⌘0 belong to the reading region and, while a web page is open, override the global editor font-size zoom. */
describe("web zoom bindings", () => {
  it("the default bindings live in the reading region", () => {
    expect(defaultRegionOf("study.web-zoom-in")).toBe("reading");
    expect(defaultRegionOf("study.web-zoom-out")).toBe("reading");
    expect(bindingsForCommand("study.web-zoom-in", "reading")).toEqual(["Mod-=", "Mod-Shift-="]);
    expect(bindingsForCommand("study.web-zoom-out", "reading")).toEqual(["Mod--"]);
    expect(bindingsForCommand("study.web-zoom-reset", "reading")).toEqual(["Mod-0"]);
  });

  it("in the reading region they come before the editor font-size zoom (which one runs is decided by the command's when clause while a web page is open)", () => {
    expect(commandsForKey("Mod-=", "reading")).toEqual(["study.web-zoom-in", "view.zoom-in"]);
    expect(commandsForKey("Mod--", "reading")).toEqual(["study.web-zoom-out", "view.zoom-out"]);
    // The notes region has no web zoom binding, so it stays the editor
    // font-size zoom.
    expect(commandsForKey("Mod-=", "notes")).toEqual(["view.zoom-in"]);
  });
});

/**
 * Keys pressed in the native web child webview do not bubble to the main
 * window, and the in-page runtime only honors the forwarding list pushed
 * from the main window. Global commands are "active under any focus" — quick
 * todo, command palette and the like must be included, because missing one
 * means one keybinding silently dies inside a web page.
 */
describe("web forwarding keys", () => {
  it("the whole global table is forwarded (quick todo / command palette / region switch)", () => {
    const keys = pageForwardKeys();
    expect(keys).toContain("Mod-Shift-k"); // workspace.capture-todo
    expect(keys).toContain("Mod-p");
    expect(keys).toContain("Mod-Alt-a"); // region.focus-agent (reading region)
    expect(keys).toContain("Mod-="); // web zoom
    // The bare paging keys are handled by the page itself and are not
    // forwarded through IPC.
    expect(keys).not.toContain("PageDown");
    expect(keys).not.toContain("ArrowRight");
    // The screenshot key, which only makes sense for a PDF, is not
    // forwarded: pressing it inside a web page must not be silently swallowed.
    expect(keys).not.toContain("Mod-Shift-e");
  });

  it("a binding the user moves into the reading region is forwarded too", () => {
    applyOverrides(normalizeOverrides({ reading: { "region.focus-agent": "Mod-Alt-z" } }));
    expect(pageForwardKeys()).toContain("Mod-Alt-z");
  });

  it("a region navigation that takes effect across regions, bound in the notes / Agent region, is forwarded too", () => {
    applyOverrides(
      normalizeOverrides({
        notes: { "region.focus-reading": "Mod-Alt-y" },
        agent: { "region.focus-notes": "Mod-Alt-u" },
      }),
    );
    const keys = pageForwardKeys();
    expect(keys).toContain("Mod-Alt-y");
    expect(keys).toContain("Mod-Alt-u");
  });

  it("it follows the user overrides: a rebind takes effect, an unbinding removes the key", () => {
    applyOverrides(
      normalizeOverrides({
        global: { "workspace.capture-todo": "Mod-Shift-j" },
        reading: { "study.web-zoom-in": "Mod-Shift-=" },
      }),
    );
    const keys = pageForwardKeys();
    expect(keys).toContain("Mod-Shift-j");
    expect(keys).not.toContain("Mod-Shift-k");
    expect(keys).toContain("Mod-Shift-=");

    applyOverrides({ global: { "workspace.capture-todo": null } });
    expect(pageForwardKeys()).not.toContain("Mod-Shift-j");
  });
});

/**
 * On macOS the event.key of Option+letter is the typed character (å/ß/®, and
 * Option+N is even "Dead"). The binding table is written with physical keys
 * (⌘⌥A = "Mod-Alt-a"), so both the main window and the web runtime must
 * restore the key from event.code, otherwise these keybindings never match.
 */
describe("event key normalization", () => {
  const ev = (key: string, code: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}) => ({
    key,
    code,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
  });

  it("Option+letter / digit is restored to the physical key", () => {
    expect(eventKeyName(ev("å", "KeyA", { altKey: true }))).toBe("a");
    expect(eventKeyName(ev("Dead", "KeyN", { altKey: true }))).toBe("n");
    expect(eventKeyName(ev("®", "KeyR", { altKey: true }))).toBe("r");
    expect(eventKeyName(ev("¡", "Digit1", { altKey: true }))).toBe("1");
  });

  it("Shift+symbol still uses the physical key", () => {
    expect(eventKeyName(ev(":", "Semicolon", { shiftKey: true }))).toBe(";");
    expect(eventKeyName(ev("_", "Minus", { shiftKey: true }))).toBe("-");
  });

  it("ordinary keys are unaffected", () => {
    expect(eventKeyName(ev("K", "KeyK", { shiftKey: true }))).toBe("k");
    expect(eventKeyName(ev("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe("ArrowLeft");
    expect(eventKeyName(ev(" ", "Space"))).toBe("Space");
  });

  it("eventToKey turns ⌘⌥A / ⌘⌥N into a matchable binding string", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "" });
    try {
      const chord = (init: Record<string, unknown>) =>
        eventToKey({
          key: "",
          code: "",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          ...init,
        } as unknown as KeyboardEvent);
      expect(chord({ key: "å", code: "KeyA", metaKey: true, altKey: true })).toBe("Mod-Alt-a");
      expect(chord({ key: "Dead", code: "KeyN", metaKey: true, altKey: true })).toBe("Mod-Alt-n");
      expect(chord({ key: "K", code: "KeyK", metaKey: true, shiftKey: true })).toBe("Mod-Shift-k");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Project management region (project): the project cards edit markdown too,
 * so it **inherits** the notes region's edit bindings; the project's own
 * actions (rotate cards, send to the top of today) come first, and the same
 * key carries a different intent per context (⌘⇧J: the notes region sends
 * to the end, the project region sends to the front).
 */
describe("project region keyboard", () => {
  it("project-specific commands belong to project, view toggles belong to global", () => {
    expect(defaultRegionOf("project.next")).toBe("project");
    expect(defaultRegionOf("project.send-todo")).toBe("project");
    expect(defaultRegionOf("project.delete")).toBe("project");
    expect(defaultRegionOf("project.focus-daily")).toBe("project");
    expect(defaultRegionOf("view.toggle-projects")).toBe("global");
  });

  it("⌘⌫ deletes a project only in the project region, the notes region does not take it", () => {
    applyOverrides({});
    expect(commandsForKey("Mod-Backspace", "project")[0]).toBe("project.delete");
    expect(commandsForKey("Mod-Backspace", "notes")).toEqual([]);
  });

  it("the region navigation is bound in both project and notes", () => {
    expect(defaultRegionsOf("region.focus-project")).toEqual(["project", "notes"]);
  });

  it("the project region's own binding comes before the inherited notes binding", () => {
    applyOverrides({});
    const ids = commandsForKey("Mod-Shift-j", "project");
    expect(ids[0]).toBe("project.send-todo");
    expect(ids).toContain("edit.todo-to-daily");
  });

  it("the project region inherits the notes region's edit bindings (bold / toggle todo)", () => {
    applyOverrides({});
    expect(commandsForKey("Mod-b", "project")[0]).toBe("edit.toggle-bold");
    expect(commandsForKey("Mod-l", "project")[0]).toBe("edit.toggle-todo");
    // The project-only actions of the project region do not leak into the
    // notes region
    expect(commandsForKey("Mod-Shift-ArrowDown", "notes")).toEqual([]);
  });

  it("an explicit override in the project region wins over the inherited one", () => {
    applyOverrides({ project: { "edit.toggle-bold": null } });
    expect(commandsForKey("Mod-b", "project")).not.toContain("edit.toggle-bold");
  });
});

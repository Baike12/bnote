import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BINDINGS,
  KEY_REGIONS,
  applyOverrides,
  bindingEquals,
  bindingsForCommand,
  commandBelongs,
  commandInRegion,
  commandRegions,
  captureConflicts,
  commandTitleInRegion,
  commandsForKey,
  defaultBindingsFor,
  defaultRegionOf,
  defaultRegionsOf,
  eventKeyName,
  eventToKey,
  flattenOverrides,
  formOwnsEditChord,
  formatBinding,
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

  it("middle-column paging defaults to PageUp/PageDown in the global layer, and nobody else duplicates them", () => {
    expect(bindingsForCommand("view.page-prev")).toEqual(["PageUp"]);
    expect(bindingsForCommand("view.page-next")).toEqual(["PageDown"]);
    // The arrows are not page-turn keys: the invest region owns them for
    // chart panning, and a global key may not collide with any region's key.
    expect(DEFAULT_BINDINGS["view.page-next"]).not.toContain("ArrowRight");
    const used = ["PageUp", "PageDown"];
    const own = new Set(["view.page-prev", "view.page-next"]);
    const others = Object.entries(DEFAULT_BINDINGS).flatMap(([id, key]) =>
      own.has(id)
        ? []
        : keysOf(key)
            .filter((k) => used.includes(k))
            .map((k) => `${id}:${k}`),
    );
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

/** Naming contract: top-level names are "**区"; a row inside a region names its region first. */
describe("region naming", () => {
  it("every region label ends with 区, and the content region replaced the reading one", () => {
    expect(KEY_REGIONS.map((r) => r.label)).toEqual([
      "全局区",
      "笔记区",
      "内容区",
      "Agent区",
      "项目区",
      "代码区",
      "投资区",
    ]);
  });

  it("a command row is prefixed with its region name", () => {
    expect(commandTitleInRegion("agent", "切换到内容区")).toBe("Agent区：切换到内容区");
    expect(commandTitleInRegion("notes", "加粗")).toBe("笔记区：加粗");
  });
});

/** Capturing a key in the settings page has to keep the layers exclusive. */
describe("capturing a key", () => {
  afterEach(reset);

  it("a global capture names every region copy holding the key", () => {
    applyOverrides({});
    const conflicts = captureConflicts("global", "Mod-b", "app.quit");
    expect(conflicts).toContainEqual({ id: "edit.toggle-bold", regions: ["notes", "project"] });
    expect(conflicts).toContainEqual({ id: "code.toggle-tree", regions: ["code"] });
  });

  it("a region capture names its own holder and the global holder, never another region", () => {
    applyOverrides({});
    expect(captureConflicts("notes", "Mod-p", "edit.toggle-bold")).toEqual([
      { id: "nav.command-palette", regions: ["global"] },
    ]);
    // The key belongs to the notes region itself (and its project copy, which
    // is a different region's binding and stays untouched).
    expect(captureConflicts("notes", "Mod-b", "edit.toggle-italic")).toEqual([
      { id: "edit.toggle-bold", regions: ["notes"] },
    ]);
    // The Agent panel's key is not a notes conflict.
    expect(captureConflicts("notes", "Mod-Shift-y", "edit.toggle-bold")).toEqual([]);
  });

  it("the command being rebound is not its own conflict", () => {
    applyOverrides({});
    expect(captureConflicts("notes", "Mod-b", "edit.toggle-bold")).toEqual([]);
  });
});

/** Region ownership: who takes effect in which region, and how a region overrides the global one. */
describe("region dispatch", () => {
  it("commands are assigned to their default region by semantics", () => {
    expect(defaultRegionOf("edit.toggle-bold")).toBe("notes");
    expect(defaultRegionOf("nav.header-todos")).toBe("notes");
    expect(defaultRegionOf("view.page-next")).toBe("global");
    expect(defaultRegionOf("region.focus-agent")).toBe("reading");
    expect(defaultRegionOf("agent.new-session")).toBe("agent");
    expect(defaultRegionOf("agent.switch-session")).toBe("agent");
    expect(defaultRegionOf("nav.command-palette")).toBe("global");
    expect(defaultRegionOf("view.toggle-study-mode")).toBe("global");
  });

  it("⌘O jumps to notes inside the notes region, and the code region keeps its own file open", () => {
    // "Quick jump to a file" is the note editor's action: it lists the vault's
    // note files. Global would steal the key from every region, and the code
    // region already has its own quick open over the code project's files.
    expect(defaultRegionOf("nav.quick-switcher")).toBe("notes");
    expect(commandsForKey("Mod-o", "notes")).toEqual(["nav.quick-switcher"]);
    expect(commandsForKey("Mod-o", "project")).toEqual(["nav.quick-switcher"]);
    expect(commandsForKey("Mod-o", "global")).toEqual([]);
    expect(commandsForKey("Mod-o", "code")).toEqual([]);
    expect(commandsForKey("Mod-o", "reading")).toEqual([]);
    expect(commandsForKey("Mod-Shift-o", "code")).toEqual(["code.quick-open"]);
  });

  it("the region switch commands exist in every region that can reach the target (each region holds its own copy)", () => {
    // Code mode is a three-column layout too: the caret can go back to the
    // notes column, the Agent panel, and the content column (the open file).
    // Invest mode's right column is the notes region, so only ⌘⌥N is added
    // there (⌘⌥A / ⌘⌥R have the invest region's own meanings).
    expect(defaultRegionsOf("region.focus-agent")).toEqual(["reading", "notes", "agent", "code"]);
    expect(defaultRegionsOf("region.focus-reading")).toEqual(["reading", "notes", "agent", "code"]);
    expect(defaultRegionsOf("region.focus-notes")).toEqual([
      "reading",
      "notes",
      "agent",
      "code",
      "invest",
    ]);
    expect(commandsForKey("Mod-Alt-a", "reading")).toContain("region.focus-agent");
    expect(commandsForKey("Mod-Alt-a", "notes")).toContain("region.focus-agent");
    // ⌘⌥A inside the Agent panel sends the focus back to its input: it must
    // work when pressed in the message list / history too.
    expect(commandsForKey("Mod-Alt-a", "agent")).toContain("region.focus-agent");
    expect(commandsForKey("Mod-Alt-n", "reading")).toContain("region.focus-notes");
    expect(commandsForKey("Mod-Alt-n", "notes")).toContain("region.focus-notes");
    expect(commandsForKey("Mod-Alt-n", "agent")).toContain("region.focus-notes");
    expect(commandsForKey("Mod-Alt-n", "invest")).toContain("region.focus-notes");
    expect(commandsForKey("Mod-Alt-r", "notes")).toContain("region.focus-reading");
    expect(commandsForKey("Mod-Alt-r", "reading")).toContain("region.focus-reading");
    expect(commandsForKey("Mod-Alt-r", "agent")).toContain("region.focus-reading");
    expect(commandsForKey("Mod-Alt-r", "code")).toContain("region.focus-reading");
    expect(commandsForKey("Mod-Alt-a", "code")).toContain("region.focus-agent");
    expect(bindingsForCommand("region.focus-agent")).toEqual(["Mod-Alt-a"]);
    // The jump is not global: the global layer stays reserved for actions that
    // belong to no column, and ⌘W is dead until a region binds it.
    expect(commandsForKey("Mod-w", "global")).toEqual([]);
  });

  it("the Agent jump can be bound to ⌘W in each region separately, and the copies stay independent", () => {
    // The user binds it per region (notes / content / code …): one region's
    // chord does not leak into another, and the global layer keeps its keys.
    applyOverrides(
      normalizeOverrides({
        notes: { "region.focus-agent": "Mod-w" },
        code: { "region.focus-agent": "Mod-w" },
      }),
    );
    expect(commandsForKey("Mod-w", "notes")).toEqual(["region.focus-agent"]);
    expect(commandsForKey("Mod-w", "code")).toEqual(["region.focus-agent"]);
    expect(commandsForKey("Mod-w", "reading")).toEqual([]);
    expect(commandsForKey("Mod-w", "global")).toEqual([]);
  });

  it("the global key set and every region key set are disjoint (one key, one meaning at any focus)", () => {
    const regionKeys = new Map<string, Set<string>>();
    for (const [id] of Object.entries(DEFAULT_BINDINGS)) {
      for (const region of defaultRegionsOf(id)) {
        const set = regionKeys.get(region) ?? new Set<string>();
        for (const key of defaultBindingsFor(id, region)) set.add(key);
        regionKeys.set(region, set);
      }
    }
    const globalKeys = regionKeys.get("global") ?? new Set<string>();
    for (const region of ["notes", "reading", "agent", "project", "code", "invest"] as const) {
      const overlap = [...(regionKeys.get(region) ?? new Set<string>())].filter((key) =>
        globalKeys.has(key),
      );
      expect(overlap, `${region} shares a key with the global layer`).toEqual([]);
    }
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

  it("⌘[ is the panel's back-from-fork in the Agent panel and the note back-link in the notes region — one key, one meaning per focus", () => {
    expect(commandsForKey("Mod-[", "agent")).toEqual(["agent.back-from-fork"]);
    // The back-link is a note action and lives in the notes region.
    expect(commandsForKey("Mod-[", "notes")).toEqual(["nav.back-link"]);
    expect(commandsForKey("Mod-[", "code")).toEqual(["agent.back-from-fork"]);
  });

  it("null unbinding: the key no longer fires the command in that region, the other region's copy stays", () => {
    applyOverrides({ notes: { "edit.toggle-italic": null } });
    expect(bindingsForCommand("edit.toggle-italic", "notes")).toEqual([]);
    expect(commandsForKey("Mod-Shift-i", "notes")).not.toContain("edit.toggle-italic");
    // The project region owns an independent copy (the cards edit markdown).
    expect(bindingsForCommand("edit.toggle-italic", "project")).toEqual(["Mod-Shift-i"]);
    expect(commandsForKey("Mod-Shift-i", "project")).toContain("edit.toggle-italic");
  });

  it("regions do not affect each other: a binding added in another region leaves the global default binding in place", () => {
    applyOverrides(normalizeOverrides({ agent: { "view.page-next": "Mod-j" } }));
    expect(commandRegions("view.page-next")).toEqual(["global", "agent"]);
    expect(bindingsForCommand("view.page-next", "agent")).toEqual(["Mod-j"]);
    expect(bindingsForCommand("view.page-next", "global")).toEqual(["PageDown"]);
    expect(commandsForKey("Mod-j", "agent")).toContain("view.page-next");
    expect(commandsForKey("PageDown", "reading")).toContain("view.page-next");
  });

  it("an unbinding only affects the current region", () => {
    applyOverrides(normalizeOverrides({ notes: { "region.focus-agent": null } }));
    expect(bindingsForCommand("region.focus-agent", "notes")).toEqual([]);
    expect(bindingsForCommand("region.focus-agent", "reading")).toEqual(["Mod-Alt-a"]);
    expect(commandsForKey("Mod-Alt-a", "notes")).not.toContain("region.focus-agent");
  });

  it("page-turn is global: a rebind fires from every region, whichever one the focus sits in", () => {
    applyOverrides(
      normalizeOverrides({
        global: {
          "view.page-prev": "Ctrl-k",
          "view.page-next": "Ctrl-j",
        },
      }),
    );
    for (const region of ["notes", "reading", "agent", "code"] as const) {
      expect(commandsForKey("Ctrl-j", region)).toEqual(["view.page-next"]);
      expect(commandsForKey("Ctrl-k", region)).toEqual(["view.page-prev"]);
    }
    expect(defaultRegionOf("view.page-next")).toBe("global");
  });

  it("a copy moved into one region stays there: the global default still fires everywhere else", () => {
    applyOverrides(normalizeOverrides({ reading: { "view.page-next": "F5" } }));
    expect(commandsForKey("F5", "reading")).toEqual(["view.page-next"]);
    expect(commandsForKey("F5", "notes")).not.toContain("view.page-next");
    // The global default was not moved away: PageDown still pages everywhere.
    expect(commandsForKey("PageDown", "notes")).toContain("view.page-next");
    expect(commandsForKey("PageDown", "reading")).toContain("view.page-next");
  });

  it("the content snapshot is placed in content / Agent / notes, and not in code (⌘⇧E there is the file tree)", () => {
    for (const region of ["reading", "notes", "agent"] as const) {
      expect(commandsForKey("Mod-Shift-e", region)).toContain("study.pdf-snap-to-agent");
    }
    expect(commandsForKey("Mod-Shift-e", "code")).toEqual(["code.focus-tree"]);
  });

  it("region navigation is a copy per region: rebinding it in reading leaves the other regions' defaults alone", () => {
    applyOverrides(normalizeOverrides({ reading: { "region.focus-agent": "Mod-Shift-w" } }));
    expect(commandsForKey("Mod-Shift-w", "reading")).toContain("region.focus-agent");
    expect(commandsForKey("Mod-Shift-w", "notes")).toEqual([]);
    expect(commandsForKey("Mod-Alt-a", "notes")).toContain("region.focus-agent");
  });

  it("⌘Q quits from every region, including the code editor", () => {
    applyOverrides({});
    expect(DEFAULT_BINDINGS["app.quit"]).toBe("Mod-q");
    for (const region of ["global", "notes", "reading", "agent", "project", "code"] as const) {
      expect(commandsForKey("Mod-q", region), region).toContain("app.quit");
    }
  });

  it("global bindings work in the code region too (no inherited-globals whitelist)", () => {
    applyOverrides({});
    expect(commandsForKey("Mod-Shift-p", "code")).toContain("view.toggle-projects");
    expect(commandsForKey("Mod-,", "code")).toContain("workspace.open-settings");
    // The code region's own key stays its own: save-file, not save-note.
    expect(commandsForKey("Mod-s", "code")).toEqual(["code.save-file"]);
  });

  it("a region's unbinding never revives from another region (there is no cross-region fallback)", () => {
    applyOverrides(normalizeOverrides({ agent: { "region.focus-agent": null } }));
    expect(commandsForKey("Mod-Alt-a", "agent")).not.toContain("region.focus-agent");
    expect(commandsForKey("Mod-Alt-a", "notes")).toContain("region.focus-agent");
    expect(commandsForKey("Mod-Alt-a", "reading")).toContain("region.focus-agent");
  });

  it("while a modal is open (region = global) cross-region commands are not let through, the focus is not stolen", () => {
    // Only global commands are recognized inside a modal: ⌘⌥A must not hand
    // the focus to the Agent input, and the reading region's screenshot is not
    // recognized. The page-turn commands are global, so their `when` refuses
    // behind a modal instead (study/pageTurn.ts).
    expect(commandsForKey("Mod-Alt-a", "global")).toEqual([]);
    expect(commandsForKey("Mod-Shift-e", "global")).toEqual([]);
    expect(commandsForKey("Ctrl-j", "global")).toEqual([]);
    expect(commandsForKey("Mod-p", "global")).toEqual(["nav.command-palette"]);
  });

  it("the same key can mean different things in different regions, and a rebind in one does not leak", () => {
    applyOverrides(
      normalizeOverrides({
        notes: { "edit.toggle-todo": "Mod-w" },
        reading: { "study.pdf-snap-to-agent": "Mod-w" },
      }),
    );
    expect(commandsForKey("Mod-w", "notes")).toEqual(["edit.toggle-todo"]);
    expect(commandsForKey("Mod-w", "reading")).toEqual(["study.pdf-snap-to-agent"]);
    // The Agent panel's copy of the snapshot keeps its own default key.
    expect(commandsForKey("Mod-w", "agent")).toEqual([]);
    expect(commandsForKey("Mod-Shift-e", "agent")).toEqual(["study.pdf-snap-to-agent"]);
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
      "view.page-next": "Ctrl-j",
      "nav.command-palette": "Mod-p",
      "edit.toggle-italic": null,
    });
    expect(overrides.notes).toEqual({
      "edit.toggle-bold": "Mod-b",
      "edit.toggle-italic": null,
    });
    expect(overrides.reading).toBeUndefined();
    expect(overrides.global).toEqual({
      "nav.command-palette": "Mod-p",
      "view.page-next": "Ctrl-j",
    });
    expect(overrides.agent).toBeUndefined();
  });

  it("a renamed command id written by an older app still applies to the current command", () => {
    // `study.agent-switch-session` became `agent.switch-session`: the flat
    // table must be canonicalized before the region is resolved, otherwise the
    // old entry would silently land in the wrong tab.
    const overrides = normalizeOverrides({ "study.agent-switch-session": "Mod-Shift-y" });
    expect(overrides.agent).toEqual({ "agent.switch-session": "Mod-Shift-y" });
    expect(overrides.global).toBeUndefined();

    // The page-turn commands became global: an old flat entry lands in the
    // global tab under the current id, not in a "study" one.
    const paging = normalizeOverrides({ "study.pdf-next-page": "Ctrl-j" });
    expect(paging.global).toEqual({ "view.page-next": "Ctrl-j" });
  });

  it("an old page-turn entry inside a region keeps its region: the binding is not silently widened", () => {
    // The regional format says where the user put the key; canonicalizing the
    // id must not move it to the current default region.
    const overrides = normalizeOverrides({ reading: { "study.pdf-next-page": "Ctrl-j" } });
    expect(overrides.reading).toEqual({ "view.page-next": "Ctrl-j" });
    expect(overrides.global).toBeUndefined();
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
      reading: { "view.page-prev": "Ctrl-k" },
      agent: { "agent.focus-history": "Mod-Shift-h" },
    });
    const text = serializeOverrides(overrides);
    expect(text).toContain("_hint");
    expect(text).toContain("view.page-prev");
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

/** Web zoom: ⌘= / ⌘- / ⌘0 belong to the content region; the editor font-size zoom is a notes binding. */
describe("web zoom bindings", () => {
  it("the default bindings live in the content region", () => {
    expect(defaultRegionOf("study.web-zoom-in")).toBe("reading");
    expect(defaultRegionOf("study.web-zoom-out")).toBe("reading");
    expect(bindingsForCommand("study.web-zoom-in", "reading")).toEqual(["Mod-=", "Mod-Shift-="]);
    expect(bindingsForCommand("study.web-zoom-out", "reading")).toEqual(["Mod--"]);
    expect(bindingsForCommand("study.web-zoom-reset", "reading")).toEqual(["Mod-0"]);
  });

  it("⌘= and ⌘- have one meaning per region: web zoom in content, editor font zoom in notes", () => {
    expect(commandsForKey("Mod-=", "reading")).toEqual(["study.web-zoom-in"]);
    expect(commandsForKey("Mod--", "reading")).toEqual(["study.web-zoom-out"]);
    expect(commandsForKey("Mod-=", "notes")).toEqual(["view.zoom-in"]);
    expect(commandsForKey("Mod--", "notes")).toEqual(["view.zoom-out"]);
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
    const keys = pageForwardKeys(true);
    expect(keys).toContain("Mod-Shift-k"); // workspace.capture-todo
    expect(keys).toContain("Mod-p");
    expect(keys).toContain("Mod-Alt-a"); // region.focus-agent (reading region)
    expect(keys).toContain("Mod-="); // web zoom
    // The screenshot key, which only makes sense for a PDF, is not
    // forwarded: pressing it inside a web page must not be silently swallowed.
    expect(keys).not.toContain("Mod-Shift-e");
  });

  it("while the page is the page-turn target it turns its own pages: its keys are not forwarded", () => {
    const keys = pageForwardKeys(true);
    expect(keys).not.toContain("PageUp");
    expect(keys).not.toContain("PageDown");
    expect(keys).not.toContain("Mod-Shift-e");
  });

  it("once the assistant takes the middle the paging keys are forwarded: the main window scrolls the middle column", () => {
    const keys = pageForwardKeys(false);
    expect(keys).toContain("PageUp");
    expect(keys).toContain("PageDown");
    // The PDF screenshot is still the page's own business.
    expect(keys).not.toContain("Mod-Shift-e");
  });

  it("a binding the user moves into the reading region is forwarded too", () => {
    applyOverrides(normalizeOverrides({ reading: { "region.focus-agent": "Mod-Alt-z" } }));
    expect(pageForwardKeys(true)).toContain("Mod-Alt-z");
  });

  it("only the content region's own bindings are forwarded: a notes / Agent rebind does not leak into the page", () => {
    applyOverrides(
      normalizeOverrides({
        notes: { "region.focus-reading": "Mod-Alt-y" },
        agent: { "region.focus-notes": "Mod-Alt-u" },
      }),
    );
    const keys = pageForwardKeys(true);
    expect(keys).not.toContain("Mod-Alt-y");
    expect(keys).not.toContain("Mod-Alt-u");
    // The content region still holds its own copy of region navigation.
    expect(keys).toContain("Mod-Alt-n");
    expect(keys).toContain("Mod-Alt-r");
  });

  it("it follows the user overrides: a rebind takes effect, an unbinding removes the key", () => {
    applyOverrides(
      normalizeOverrides({
        global: { "workspace.capture-todo": "Mod-Shift-u" },
        reading: { "study.web-zoom-in": "Mod-Shift-=" },
      }),
    );
    const keys = pageForwardKeys(true);
    expect(keys).toContain("Mod-Shift-u");
    expect(keys).not.toContain("Mod-Shift-k");
    expect(keys).toContain("Mod-Shift-=");

    applyOverrides({ global: { "workspace.capture-todo": null } });
    expect(pageForwardKeys(true)).not.toContain("Mod-Shift-u");
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
 * Project region: the project cards edit markdown too, so the note-editing
 * commands are **placed** in project as their own copy (same defaults,
 * independent overrides). The project's own actions (rotate cards, send to
 * the top of today) keep their own keys: ⌘⇧J is project.send-todo here, while
 * the notes region's edit.todo-to-daily is not mirrored.
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

  it("⌘⇧J in the project region is only project.send-todo (todo-to-daily is not mirrored)", () => {
    applyOverrides({});
    expect(commandsForKey("Mod-Shift-j", "project")).toEqual(["project.send-todo"]);
  });

  it("the project region owns a copy of the note-editing bindings (bold / toggle todo), independent of notes", () => {
    applyOverrides({});
    expect(commandsForKey("Mod-b", "project")[0]).toBe("edit.toggle-bold");
    expect(commandsForKey("Mod-l", "project")[0]).toBe("edit.toggle-todo");
    // The project-only actions of the project region do not leak into the
    // notes region
    expect(commandsForKey("Mod-Shift-ArrowDown", "notes")).toEqual([]);

    // A notes rebind does not change the project copy.
    applyOverrides({ notes: { "edit.toggle-bold": "Ctrl-b" } });
    expect(commandsForKey("Mod-b", "project")).toContain("edit.toggle-bold");
    expect(commandsForKey("Ctrl-b", "project")).toEqual([]);
  });

  it("an override in the project region only affects the project copy", () => {
    applyOverrides({ project: { "edit.toggle-bold": null } });
    expect(commandsForKey("Mod-b", "project")).not.toContain("edit.toggle-bold");
    expect(commandsForKey("Mod-b", "notes")).toContain("edit.toggle-bold");
  });
});

/** The settings page edits one region per tab; a command with no entry anywhere must still show up once. */
describe("region tabs of the settings page", () => {
  afterEach(reset);

  it("a bound command belongs to the regions it is placed in, and nowhere else", () => {
    expect(commandBelongs("edit.toggle-bold", "notes")).toBe(true);
    expect(commandBelongs("edit.toggle-bold", "project")).toBe(true);
    expect(commandBelongs("edit.toggle-bold", "agent")).toBe(false);
    expect(commandRegions("edit.toggle-bold")).toEqual(["notes", "project"]);
    expect(commandInRegion("edit.toggle-bold", "notes")).toBe(true);
    expect(commandInRegion("edit.toggle-bold", "global")).toBe(false);
  });

  it("a command with no binding anywhere still appears once, under its default region", () => {
    // workspace.open-vault is callable from the palette only; without this
    // fallback it would vanish from the hotkey settings entirely.
    expect(commandRegions("workspace.open-vault")).toEqual([]);
    expect(commandBelongs("workspace.open-vault", "global")).toBe(true);
    expect(commandBelongs("workspace.open-vault", "notes")).toBe(false);
  });

  it("an explicit unbinding still shows its row in that region, so it can be bound again", () => {
    applyOverrides({ notes: { "edit.toggle-italic": null } });
    expect(commandInRegion("edit.toggle-italic", "notes")).toBe(true);
    expect(commandBelongs("edit.toggle-italic", "notes")).toBe(true);
    expect(bindingsForCommand("edit.toggle-italic", "notes")).toEqual([]);
  });
});

/** Display strings: the palette chips and the tooltip use `formatBinding`, the settings capture uses `eventToKey`. */
describe("binding display", () => {
  function withPlatform(platform: string, body: () => void) {
    vi.stubGlobal("navigator", { platform, userAgent: "" });
    try {
      body();
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("on macOS modifiers become glyphs and a chord has no separator", () => {
    withPlatform("MacIntel", () => {
      expect(formatBinding("Mod-Shift-m")).toBe("⌘⇧M");
      expect(formatBinding("Mod--")).toBe("⌘-");
      expect(formatBinding("Mod-Alt-ArrowRight")).toBe("⌘⌥→");
      expect(formatBinding("ArrowLeft")).toBe("←");
      expect(formatBinding("Mod-Enter")).toBe("⌘Enter");
    });
  });

  it("elsewhere the names stay spelled out and joined with +", () => {
    withPlatform("Linux x86_64", () => {
      expect(formatBinding("Mod-Shift-m")).toBe("Mod+Shift+M");
      expect(formatBinding("Mod--")).toBe("Mod+-");
      expect(formatBinding("Alt-z")).toBe("Alt+Z");
    });
  });

  it("the capture path normalizes a real event into the same string the table uses", () => {
    withPlatform("MacIntel", () => {
      const event = (init: Record<string, unknown>) =>
        eventToKey({
          key: "",
          code: "",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          ...init,
        } as unknown as KeyboardEvent);

      expect(event({ key: "k", code: "KeyK", metaKey: true, shiftKey: true })).toBe("Mod-Shift-k");
      expect(event({ key: "F8", code: "F8" })).toBe("F8");
      expect(event({ key: "F8", code: "F8", shiftKey: true })).toBe("Shift-F8");
      // A bare letter is ordinary typing, and a lone modifier is not a binding.
      expect(event({ key: "a", code: "KeyA" })).toBeNull();
      expect(event({ key: "Meta", code: "MetaLeft", metaKey: true })).toBeNull();
    });
  });
});

/** The config file is the user's own text: values it cannot read are dropped instead of throwing. */
describe("config normalization boundaries", () => {
  it("a value that is not a string, an array or null is dropped", () => {
    expect(normalizeOverrides({ notes: { "edit.toggle-bold": 42 } })).toEqual({});
    expect(normalizeOverrides({ notes: { "edit.toggle-bold": { key: "Mod-b" } } })).toEqual({});
  });

  it("whitespace-only strings are dropped, an empty array becomes an explicit unbinding", () => {
    expect(normalizeOverrides({ notes: { "edit.toggle-bold": "   " } })).toEqual({});
    expect(normalizeOverrides({ notes: { "edit.toggle-bold": ["", "  "] } })).toEqual({
      notes: { "edit.toggle-bold": null },
    });
  });

  it("a non-object file is treated as empty instead of throwing", () => {
    for (const raw of [null, undefined, "string", 7, []]) {
      expect(normalizeOverrides(raw)).toEqual({});
    }
  });

  it("comment fields are skipped at both levels, so the hint never becomes a binding", () => {
    expect(normalizeOverrides({ _hint: "x", $schema: "y" })).toEqual({});
    expect(normalizeOverrides({ notes: { _hint: "x", "edit.toggle-bold": "Mod-b" } })).toEqual({
      notes: { "edit.toggle-bold": "Mod-b" },
    });
  });

  it("a region value that is not an object is skipped, the readable regions still apply", () => {
    expect(normalizeOverrides({ notes: "Mod-b", reading: { "view.page-next": "Ctrl-j" } })).toEqual(
      { reading: { "view.page-next": "Ctrl-j" } },
    );
  });

  it("the written file round-trips through the reader unchanged", () => {
    const overrides = {
      notes: { "edit.toggle-bold": "Mod-Shift-b" as const, "edit.toggle-italic": null },
      reading: { "view.page-next": ["Ctrl-J", "Ctrl-K"] as string[] },
    };
    expect(normalizeOverrides(JSON.parse(serializeOverrides(overrides)))).toEqual(overrides);
  });
});

/** The regression pair: a binding is equal only when the same keys come in the same order. */
describe("binding equality", () => {
  it("the same keys in the same order are equal", () => {
    expect(bindingEquals("Mod-b", ["Mod-b"])).toBe(true);
    expect(bindingEquals(["Mod-a", "Mod-b"], ["Mod-a", "Mod-b"])).toBe(true);
  });

  it("a different key, a different order or a different count is not equal", () => {
    expect(bindingEquals("Mod-b", "Mod-Shift-b")).toBe(false);
    expect(bindingEquals(["Mod-a", "Mod-b"], ["Mod-b", "Mod-a"])).toBe(false);
    expect(bindingEquals(["Mod-a"], ["Mod-a", "Mod-b"])).toBe(false);
  });

  it("an unset value and an explicitly unbound one compare equal: neither binds a key", () => {
    expect(bindingEquals(undefined, null)).toBe(true);
    expect(bindingEquals(undefined, "")).toBe(true);
    expect(bindingEquals(undefined, [])).toBe(true);
  });

  it("flattening keeps the last region that wrote a command, and drops nothing else", () => {
    expect(
      flattenOverrides({
        notes: { "edit.toggle-bold": "Mod-b", "nav.command-palette": "Mod-p" },
        reading: { "edit.toggle-bold": "Ctrl-b" },
      }),
    ).toEqual({ "edit.toggle-bold": "Ctrl-b", "nav.command-palette": "Mod-p" });
  });
});

describe("user-override collisions", () => {
  afterEach(() => reset());

  it("an override colliding with another command in one region is named loudly", () => {
    // The default keymap has a uniqueness gate, but user overrides bypass it
    // (they are applied blindly per region) — so the conflict must be named
    // at application time instead of silently shadowing one of the commands.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyOverrides({
      notes: { "edit.insert-callout": "Mod-Shift-o", "workspace.capture-todo": "Mod-Shift-o" },
    });
    const reported = warn.mock.calls.map((c) => String(c.join(" "))).join("\n");
    expect(reported).toContain("notes");
    expect(reported).toContain("Mod-Shift-o");
    expect(reported).toContain("edit.insert-callout");
    expect(reported).toContain("workspace.capture-todo");
    warn.mockRestore();
  });

  it("both commands stay reachable on a conflicted key (dispatch tries each)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyOverrides({
      notes: { "edit.insert-callout": "Mod-Shift-o", "workspace.capture-todo": "Mod-Shift-o" },
    });
    const ids = commandsForKey("Mod-Shift-o", "notes");
    expect(ids).toContain("edit.insert-callout");
    expect(ids).toContain("workspace.capture-todo");
    warn.mockRestore();
  });

  it("an override that puts a global key into a region is named loudly (global × region is exclusive)", () => {
    // ⌘P is the global command palette. Writing it into notes breaks the
    // layer rule: inside notes the region binding would win and the palette
    // would lose its key there. The override is kept (user data is never
    // rejected) but the collision is reported.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyOverrides({ notes: { "edit.toggle-bold": "Mod-p" } });
    const reported = warn.mock.calls.map((c) => String(c.join(" "))).join("\n");
    expect(reported).toContain("notes");
    expect(reported).toContain("Mod-p");
    expect(reported).toContain("edit.toggle-bold");
    expect(reported).toContain("nav.command-palette");
    warn.mockRestore();
  });

  it("an unbinding override never warns (null unbinds, it cannot collide)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyOverrides({ notes: { "edit.insert-callout": null } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

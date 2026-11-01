import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BINDINGS,
  FIXED_PAGE_COMMANDS,
  applyOverrides,
  bindingsForCommand,
  commandBelongs,
  commandRegions,
  commandsForKey,
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
describe("默认键位", () => {
  it("同一区域内没有重复键位", () => {
    const byRegion = new Map<string, string[]>();
    for (const [id, value] of Object.entries(DEFAULT_BINDINGS)) {
      for (const region of defaultRegionsOf(id)) {
        for (const key of keysOf(value)) {
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

  it("Mod-Shift-o 归 workspace.open-daily,通用区里无人与之重复", () => {
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

  it("workspace.open-vault 不再占 Mod-Shift-o(仍可从命令面板调用)", () => {
    expect(bindingsForCommand("workspace.open-vault")).toEqual([]);
  });

  it("Mod-Shift-b 归 edit.insert-callout,且无人与之重复", () => {
    expect(bindingsForCommand("edit.insert-callout")).toEqual(["Mod-Shift-b"]);
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) => id !== "edit.insert-callout" && key === "Mod-Shift-b",
    );
    expect(others).toEqual([]);
  });

  it("Mod-Shift-r 归 workspace.switch-recent-vault,且无人与之重复", () => {
    expect(bindingsForCommand("workspace.switch-recent-vault")).toEqual(["Mod-Shift-r"]);
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) => id !== "workspace.switch-recent-vault" && key === "Mod-Shift-r",
    );
    expect(others).toEqual([]);
  });

  it("PDF 翻页默认 PageUp/PageDown(含方向键),且无人与之重复", () => {
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

  it("⌘⇧E:阅读区截图、代码区聚焦文件树,各归各的区域", () => {
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

describe("专注:只有开始,没有中途出口", () => {
  it("开始番茄钟绑定 ⌘⌥T,且是唯一的专注键位", () => {
    expect(bindingsForCommand("focus.pomodoro-start")).toEqual(["Mod-Alt-t"]);
    expect(commandsForKey("Mod-Alt-t", "global")).toContain("focus.pomodoro-start");
  });

  it("暂停 / 结束 / 进退出独占 / 硬锁开关的键位都不存在", () => {
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
describe("区域分发", () => {
  it("命令按语义分到默认区域", () => {
    expect(defaultRegionOf("edit.toggle-bold")).toBe("notes");
    expect(defaultRegionOf("nav.header-todos")).toBe("notes");
    expect(defaultRegionOf("study.pdf-next-page")).toBe("reading");
    expect(defaultRegionOf("region.focus-agent")).toBe("reading");
    expect(defaultRegionOf("agent.new-session")).toBe("agent");
    expect(defaultRegionOf("study.agent-switch-session")).toBe("agent");
    expect(defaultRegionOf("nav.command-palette")).toBe("global");
    expect(defaultRegionOf("view.toggle-study-mode")).toBe("global");
  });

  it("三个区域切换命令三个区域都有(任意区域都能去任意区域,含回自己)", () => {
    for (const id of ["region.focus-agent", "region.focus-notes", "region.focus-reading"]) {
      for (const region of ["reading", "notes", "agent"] as const) {
        expect(commandBelongs(id, region)).toBe(true);
      }
    }
    // "Focus reading" has no share in the code region — the code region
    // grows inside the reading column, there is no fourth place to go to.
    // "Focus notes" / "Focus Agent" do have one: the code editor can jump
    // straight back to the notes region and the assistant panel.
    expect(defaultRegionsOf("region.focus-reading")).toEqual(["reading", "notes", "agent"]);
    for (const id of ["region.focus-agent", "region.focus-notes"]) {
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
    expect(bindingsForCommand("region.focus-agent")).toEqual(["Mod-Alt-a"]);
  });

  it("笔记区的键不会在 Agent 面板触发,通用的键到处都在", () => {
    expect(commandsForKey("Mod-b", "notes")).toContain("edit.toggle-bold");
    expect(commandsForKey("Mod-b", "agent")).not.toContain("edit.toggle-bold");
    expect(commandsForKey("Mod-p", "agent")).toContain("nav.command-palette");
    expect(commandsForKey("Mod-p", "reading")).toContain("nav.command-palette");
  });

  it("区域绑定排在同键的通用绑定前面(Agent 里 ⌘[ 是返回会话)", () => {
    expect(commandsForKey("Mod-[", "agent")[0]).toBe("agent.back-from-fork");
    expect(commandsForKey("Mod-[", "agent")).toContain("nav.back-link");
    // The notes region has no region binding, so ⌘[ is still the back-link.
    expect(commandsForKey("Mod-[", "notes")).toEqual(["nav.back-link"]);
  });

  it("null 解绑:该区域里这个键不再触发命令", () => {
    applyOverrides({ notes: { "edit.toggle-italic": null } });
    expect(bindingsForCommand("edit.toggle-italic")).toEqual([]);
    expect(commandsForKey("Mod-Shift-i", "notes")).not.toContain("edit.toggle-italic");
  });

  it("区域互不影响:在别的区域加绑定,原区域的默认绑定保留", () => {
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

  it("解绑只影响当前区域", () => {
    applyOverrides(
      normalizeOverrides({ notes: { "region.focus-agent": null } }),
    );
    expect(bindingsForCommand("region.focus-agent", "notes")).toEqual([]);
    expect(bindingsForCommand("region.focus-agent", "reading")).toEqual(["Mod-Alt-a"]);
    expect(commandsForKey("Mod-Alt-a", "notes")).not.toContain("region.focus-agent");
  });

  it("翻页和弦跨区域:笔记区 / Agent 面板按下也命中阅读区那份绑定", () => {
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

  it("翻页的裸导航键仍只归阅读区(不抢编辑器光标键)", () => {
    expect(commandsForKey("PageDown", "reading")).toContain("study.pdf-next-page");
    expect(commandsForKey("PageDown", "notes")).not.toContain("study.pdf-next-page");
    expect(commandsForKey("ArrowRight", "agent")).not.toContain("study.pdf-next-page");
    // Cross-region only holds for chords with Mod/Ctrl/Alt.
    applyOverrides(normalizeOverrides({ reading: { "study.pdf-next-page": "F5" } }));
    expect(commandsForKey("F5", "notes")).not.toContain("study.pdf-next-page");
  });

  it("截图和弦同样跨区域:焦点在 Agent 面板/笔记区也命中阅读区那份绑定", () => {
    expect(commandsForKey("Mod-Shift-e", "reading")).toContain("study.pdf-snap-to-agent");
    // In the code region the same key first hits its own "focus file tree",
    // and the screenshot does not run along (pickCommand takes only the
    // first command whose when holds).
    expect(commandsForKey("Mod-Shift-e", "code")[0]).toBe("code.focus-tree");
    for (const region of ["notes", "agent"] as const) {
      expect(commandsForKey("Mod-Shift-e", region)).toContain("study.pdf-snap-to-agent");
    }
  });

  it("区域导航和弦跨区域:只配在阅读区,Agent 面板里按下去也生效", () => {
    applyOverrides(
      normalizeOverrides({ reading: { "region.focus-agent": "Mod-Shift-w" } }),
    );
    expect(commandsForKey("Mod-Shift-w", "reading")).toContain("region.focus-agent");
    for (const region of ["notes", "agent"] as const) {
      expect(commandsForKey("Mod-Shift-w", region)).toContain("region.focus-agent");
    }
  });

  it("跨区域只在显式解绑之外生效:null 解绑该区域后不再从别处复活", () => {
    applyOverrides(
      normalizeOverrides({
        reading: { "region.focus-agent": "Mod-Shift-w" },
        agent: { "region.focus-agent": null },
      }),
    );
    expect(commandsForKey("Mod-Shift-w", "notes")).toContain("region.focus-agent");
    expect(commandsForKey("Mod-Shift-w", "agent")).not.toContain("region.focus-agent");
  });

  it("弹窗打开时(region = global)不放行跨区域命令,焦点不被抢走", () => {
    // Only global commands are recognized inside a modal: ⌘⌥A must not hand
    // the focus to the Agent input, and paging must not scroll behind it.
    expect(commandsForKey("Mod-Alt-a", "global")).toEqual([]);
    expect(commandsForKey("Mod-Shift-e", "global")).toEqual([]);
    expect(commandsForKey("Ctrl-j", "global")).toEqual([]);
    expect(commandsForKey("Mod-p", "global")).toEqual(["nav.command-palette"]);
  });

  it("区域自己的绑定优先:笔记区把同一个键绑给别的命令,笔记里按下去仍是它", () => {
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

  it("⌘A 默认不拦截;只写进笔记区时,Agent/阅读区原样放行", () => {
    expect(commandsForKey("Mod-a", "notes")).toEqual([]);
    expect(commandsForKey("Mod-a", "agent")).toEqual([]);
    applyOverrides(normalizeOverrides({ notes: { "edit.toggle-todo": "Mod-a" } }));
    expect(commandsForKey("Mod-a", "notes")).toContain("edit.toggle-todo");
    expect(commandsForKey("Mod-a", "agent")).toEqual([]);
    expect(commandsForKey("Mod-a", "reading")).toEqual([]);
  });
});

/** Config file: the new format is grouped by region, the legacy flat table is split automatically (an upgrade loses no keybinding). */
describe("配置文件读写", () => {
  it("旧版扁平表按命令默认归属分区", () => {
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

  it("新格式按区域读取,忽略 _hint 之类的说明字段", () => {
    const overrides = normalizeOverrides({
      _hint: "说明",
      global: { "nav.command-palette": ["Mod-p", "Mod-Shift-p"] },
      agent: { "agent.new-session": null },
    });
    expect(overrides.global).toEqual({ "nav.command-palette": ["Mod-p", "Mod-Shift-p"] });
    expect(overrides.agent).toEqual({ "agent.new-session": null });
  });

  it("非法值被丢掉,数组里的空项被清掉", () => {
    const overrides = normalizeOverrides({
      notes: { "edit.toggle-bold": 42, "edit.toggle-italic": ["", "Mod-i"] },
    });
    expect(overrides.notes).toEqual({ "edit.toggle-italic": ["Mod-i"] });
  });

  it("只写覆盖项,并能原样读回", () => {
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
describe("裸导航键归属", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("无修饰键的翻页/方向键归编辑器,窗口级命令不得抢", () => {
    expect(isPlainFocusOwnedKey(ev("PageDown"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("PageUp"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("ArrowLeft"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("ArrowRight"))).toBe(true);
  });

  it("带修饰键的组合(如 Ctrl-J)在任何焦点下都交给命令", () => {
    expect(isPlainFocusOwnedKey(ev("j", { ctrlKey: true }))).toBe(false);
    expect(isPlainFocusOwnedKey(ev("PageDown", { shiftKey: true }))).toBe(false);
    expect(isPlainFocusOwnedKey(ev("j", { metaKey: true }))).toBe(false);
  });

  it("普通字符不算导航键", () => {
    expect(isPlainFocusOwnedKey(ev("j"))).toBe(false);
  });
});

/** The editing chords of the text input controls (input/textarea): even when the same region binds them, they may not be taken. */
describe("表单编辑和弦", () => {
  it("input/textarea 拥有 ⌘A/C/X/V/⌘Z,其它元素与其它按键不放行", () => {
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
describe("固定翻页键", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("PageUp/PageDown 分别对应上一页/下一页", () => {
    expect(FIXED_PAGE_COMMANDS).toEqual({
      PageUp: "study.pdf-prev-page",
      PageDown: "study.pdf-next-page",
    });
    expect(fixedPageCommandFor(ev("PageUp"))).toBe("study.pdf-prev-page");
    expect(fixedPageCommandFor(ev("PageDown"))).toBe("study.pdf-next-page");
  });

  it("改绑 study.pdf-* 之后固定键仍然生效", () => {
    applyOverrides({ reading: { "study.pdf-next-page": "Mod-j" } });
    expect(bindingsForCommand("study.pdf-next-page")).toEqual(["Mod-j"]);
    expect(fixedPageCommandFor(ev("PageDown"))).toBe("study.pdf-next-page");
  });

  it("带修饰键/其它按键不触发固定翻页", () => {
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
describe("绑定解析", () => {
  it("主键是减号时不被分隔符拆坏", () => {
    expect(parseBinding("Mod--")).toEqual({ mods: ["Mod"], key: "-" });
    expect(parseBinding("Mod-Shift--")).toEqual({ mods: ["Mod", "Shift"], key: "-" });
  });

  it("普通和弦与单键照旧", () => {
    expect(parseBinding("Mod-Shift-=")).toEqual({ mods: ["Mod", "Shift"], key: "=" });
    expect(parseBinding("Mod-,")).toEqual({ mods: ["Mod"], key: "," });
    expect(parseBinding("PageDown")).toEqual({ mods: [], key: "PageDown" });
  });

  it("所有默认绑定都能解析出非空主键", () => {
    for (const [id, value] of Object.entries(DEFAULT_BINDINGS)) {
      for (const key of keysOf(value)) {
        expect(parseBinding(key).key, `${id} ${key}`).not.toBe("");
      }
    }
  });
});

/** Web zoom: ⌘= / ⌘- / ⌘0 belong to the reading region and, while a web page is open, override the global editor font-size zoom. */
describe("网页缩放键位", () => {
  it("默认绑定在阅读区", () => {
    expect(defaultRegionOf("study.web-zoom-in")).toBe("reading");
    expect(defaultRegionOf("study.web-zoom-out")).toBe("reading");
    expect(bindingsForCommand("study.web-zoom-in", "reading")).toEqual([
      "Mod-=",
      "Mod-Shift-=",
    ]);
    expect(bindingsForCommand("study.web-zoom-out", "reading")).toEqual(["Mod--"]);
    expect(bindingsForCommand("study.web-zoom-reset", "reading")).toEqual(["Mod-0"]);
  });

  it("阅读区里排在编辑区字号缩放之前(网页打开时由命令的 when 决定)", () => {
    expect(commandsForKey("Mod-=", "reading")).toEqual([
      "study.web-zoom-in",
      "view.zoom-in",
    ]);
    expect(commandsForKey("Mod--", "reading")).toEqual([
      "study.web-zoom-out",
      "view.zoom-out",
    ]);
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
describe("网页转发键", () => {
  it("通用区域整张表都转发(快速待办 / 命令面板 / 区域切换)", () => {
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

  it("用户挪进阅读区的绑定也会转发", () => {
    applyOverrides(
      normalizeOverrides({ reading: { "region.focus-agent": "Mod-Alt-z" } }),
    );
    expect(pageForwardKeys()).toContain("Mod-Alt-z");
  });

  it("跨区域生效的区域导航,配在笔记区/Agent 区也要转发", () => {
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

  it("跟随用户覆盖:改键生效、解绑即移除", () => {
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
describe("事件主键规范化", () => {
  const ev = (
    key: string,
    code: string,
    mods: { shiftKey?: boolean; altKey?: boolean } = {},
  ) => ({ key, code, shiftKey: mods.shiftKey ?? false, altKey: mods.altKey ?? false });

  it("Option+字母 / 数字还原成物理键", () => {
    expect(eventKeyName(ev("å", "KeyA", { altKey: true }))).toBe("a");
    expect(eventKeyName(ev("Dead", "KeyN", { altKey: true }))).toBe("n");
    expect(eventKeyName(ev("®", "KeyR", { altKey: true }))).toBe("r");
    expect(eventKeyName(ev("¡", "Digit1", { altKey: true }))).toBe("1");
  });

  it("Shift+符号仍按物理键", () => {
    expect(eventKeyName(ev(":", "Semicolon", { shiftKey: true }))).toBe(";");
    expect(eventKeyName(ev("_", "Minus", { shiftKey: true }))).toBe("-");
  });

  it("普通按键不受影响", () => {
    expect(eventKeyName(ev("K", "KeyK", { shiftKey: true }))).toBe("k");
    expect(eventKeyName(ev("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe("ArrowLeft");
    expect(eventKeyName(ev(" ", "Space"))).toBe("Space");
  });

  it("eventToKey 把 ⌘⌥A / ⌘⌥N 解析成可命中的绑定串", () => {
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
      expect(chord({ key: "å", code: "KeyA", metaKey: true, altKey: true })).toBe(
        "Mod-Alt-a",
      );
      expect(chord({ key: "Dead", code: "KeyN", metaKey: true, altKey: true })).toBe(
        "Mod-Alt-n",
      );
      expect(chord({ key: "K", code: "KeyK", metaKey: true, shiftKey: true })).toBe(
        "Mod-Shift-k",
      );
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
describe("项目区快捷键盘", () => {
  it("项目专属命令归属 project,视图开关归属 global", () => {
    expect(defaultRegionOf("project.next")).toBe("project");
    expect(defaultRegionOf("project.send-todo")).toBe("project");
    expect(defaultRegionOf("project.delete")).toBe("project");
    expect(defaultRegionOf("project.focus-daily")).toBe("project");
    expect(defaultRegionOf("view.toggle-projects")).toBe("global");
  });

  it("⌘⌫ 删项目只在项目区生效,笔记区不占用", () => {
    applyOverrides({});
    expect(commandsForKey("Mod-Backspace", "project")[0]).toBe("project.delete");
    expect(commandsForKey("Mod-Backspace", "notes")).toEqual([]);
  });

  it("区域导航同时挂在 project 与 notes", () => {
    expect(defaultRegionsOf("region.focus-project")).toEqual(["project", "notes"]);
  });

  it("项目区内自己的绑定排在继承来的笔记绑定前面", () => {
    applyOverrides({});
    const ids = commandsForKey("Mod-Shift-j", "project");
    expect(ids[0]).toBe("project.send-todo");
    expect(ids).toContain("edit.todo-to-daily");
  });

  it("项目区继承笔记区的编辑键位(加粗/切待办)", () => {
    applyOverrides({});
    expect(commandsForKey("Mod-b", "project")[0]).toBe("edit.toggle-bold");
    expect(commandsForKey("Mod-l", "project")[0]).toBe("edit.toggle-todo");
    // The project-only actions of the project region do not leak into the
    // notes region
    expect(commandsForKey("Mod-Shift-ArrowDown", "notes")).toEqual([]);
  });

  it("项目区的显式覆盖优先于继承", () => {
    applyOverrides({ project: { "edit.toggle-bold": null } });
    expect(commandsForKey("Mod-b", "project")).not.toContain("edit.toggle-bold");
  });
});

import fs from "node:fs";
import path from "node:path";
import { browser, $, $$, expect } from "@wdio/globals";
import { CONFIG_FILE } from "../paths";
import { noteOnDisk, vaultRoot } from "../workspace";

/**
 * End-to-end contracts that only the real binary can prove:
 *
 *   real vault files -> Rust read/tree -> sidebar
 *   keystrokes -> CodeMirror -> debounced save -> Rust write -> bytes on disk
 *   Rust watcher -> app event -> tree/editor refresh
 *   global keybinding -> command -> daily-note creation on disk
 *
 * Assertions read two sources of truth: the app's state via `window.__bnote`
 * and the actual file bytes via Node `fs`. Neither is mocked.
 */

interface AppStateSnapshot {
  vaultPath: string | null;
  currentFile: string | null;
  dirty: boolean;
}

async function appState(): Promise<AppStateSnapshot> {
  const state = await browser.execute(() => {
    const w = window as unknown as {
      __bnote?: { store?: { getState: () => Record<string, unknown> } };
    };
    const s = w.__bnote?.store?.getState();
    if (!s) return null;
    return {
      vaultPath: s.vaultPath as string | null,
      currentFile: s.currentFile as string | null,
      dirty: s.dirty as boolean,
    };
  });
  if (!state) throw new Error("window.__bnote.store is not available");
  return state;
}

async function editorText(): Promise<string> {
  return browser.execute(() => {
    const w = window as unknown as {
      __bnote?: {
        view: () => { state: { doc: { toString: () => string } } } | null;
      };
    };
    return w.__bnote?.view()?.state.doc.toString() ?? "";
  });
}

async function treePaths(): Promise<string[]> {
  const rows = await $$(".tree-row[data-path]");
  const paths: string[] = [];
  for (const row of rows) {
    const p = await row.getAttribute("data-path");
    if (p) paths.push(p);
  }
  return paths;
}

async function waitForTreePath(relPath: string): Promise<void> {
  await browser.waitUntil(async () => (await treePaths()).includes(relPath), {
    timeoutMsg: `tree row ${relPath} never appeared`,
  });
}

async function waitForEditorText(needle: string): Promise<void> {
  await browser.waitUntil(async () => (await editorText()).includes(needle), {
    timeoutMsg: `editor never showed ${needle}`,
  });
}

async function openTreeNote(relPath: string): Promise<void> {
  await waitForTreePath(relPath);
  await $(`.tree-row[data-path="${relPath}"]`).click();
}

async function waitForDiskText(relPath: string, needle: string): Promise<void> {
  const file = noteOnDisk(relPath);
  await browser.waitUntil(
    () => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(needle),
    { timeoutMsg: `${relPath} on disk never contained ${needle}` },
  );
}

function today(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

describe("bnote desktop", () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await $(".app-sidebar").isExisting()) && (await appState()).vaultPath !== null,
      { timeoutMsg: "app never opened the fixture vault" },
    );
    // The frontend writes the vault MRU after opening; this proves the config
    // path really points at the isolated data dir.
    await browser.waitUntil(
      () => {
        if (!fs.existsSync(CONFIG_FILE)) return false;
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as {
          recentVaults?: string[];
        };
        return cfg.recentVaults?.includes(vaultRoot()) ?? false;
      },
      { timeoutMsg: "config.json never recorded the opened vault" },
    );
  });

  it("boots on the isolated vault and renders the on-disk tree", async () => {
    expect((await appState()).vaultPath).toBe(vaultRoot());
    expect(await treePaths()).toEqual(expect.arrayContaining(["Welcome.md", "Notes"]));

    // The nested file is not rendered until its folder is expanded: the tree is
    // loaded lazily through the real read_dir command.
    await $('.tree-row[data-path="Notes"]').click();
    await waitForTreePath("Notes/Second.md");
  });

  it("opens a note and autosaves keystrokes to disk", async () => {
    await openTreeNote("Welcome.md");
    await waitForEditorText("Welcome to bnote");

    await $(".cm-content").click();
    await browser.keys("e2e edit");
    await waitForDiskText("Welcome.md", "e2e edit");

    const state = await appState();
    expect(state.currentFile).toBe(path.join(vaultRoot(), "Welcome.md"));
    expect(state.dirty).toBe(false);
  });

  it("creates a new note through the sidebar action", async () => {
    await openTreeNote("Welcome.md");
    await waitForEditorText("Welcome to bnote");

    await $('button[title="新建笔记"]').click();
    await waitForTreePath("Untitled.md");
    await browser.waitUntil(
      async () => (await appState()).currentFile?.endsWith("/Untitled.md") === true,
      {
        timeoutMsg: "new note was not opened",
      },
    );

    await $(".cm-content").click();
    await browser.keys("created by e2e");
    await waitForDiskText("Untitled.md", "created by e2e");
  });

  it("creates and opens today's daily note from the global shortcut", async () => {
    const day = today();
    const relPath = `Daily/${day}.md`;
    await openTreeNote("Untitled.md");
    await waitForEditorText("created by e2e");

    await browser.keys(["Meta", "Shift", "o"]);
    await browser.waitUntil(
      async () => (await appState()).currentFile === path.join(vaultRoot(), relPath),
      { timeoutMsg: "daily note was not opened" },
    );
    // The tree renders only expanded folders: assert the Daily folder appeared,
    // expand it, then assert the day's file.
    await waitForTreePath("Daily");
    await $('.tree-row[data-path="Daily"]').click();
    await waitForTreePath(relPath);
    expect(fs.readFileSync(noteOnDisk(relPath), "utf8")).toContain(`# ${day}`);
  });

  it("picks up an externally created and edited file through the vault watcher", async () => {
    fs.writeFileSync(noteOnDisk("External.md"), "# External note\n\ncreated outside the app\n");
    await waitForTreePath("External.md");

    await openTreeNote("External.md");
    await waitForEditorText("created outside the app");

    fs.writeFileSync(noteOnDisk("External.md"), "# External note\n\nupdated externally\n");
    await waitForEditorText("updated externally");
  });

  it("opens the command palette, filters, and closes it with Escape", async () => {
    await browser.keys(["Meta", "p"]);
    const input = await $(".switcher-input");
    await input.waitForDisplayed();
    expect((await $$(".switcher-row")).length).toBeGreaterThan(0);

    await browser.keys("zzzz");
    await $(".switcher-empty").waitForDisplayed();

    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await $(".modal-overlay").isExisting()), {
      timeoutMsg: "palette did not close on Escape",
    });
  });
});

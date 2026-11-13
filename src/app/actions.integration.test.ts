import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeVault } from "@/test/fakeVault";
import { getConfigSnapshot, setConfigSnapshot, useAppStore } from "@/state/appStore";
import {
  loadDirChildren,
  newFolder,
  openVault,
  openWikiLink,
  quickAddNote,
  refreshTree,
  reloadSnippetsFromVault,
  renameEntry,
  trashEntry,
  wikiLinkTargetPath,
} from "./actions";

const ROOT = "/fake/vault";

/**
 * The application layer is where domains meet: the vault index, the file
 * actions, the link chain, snippets and config persistence. Unit tests cover
 * each domain; these tests drive the actual orchestration through the fake IPC
 * boundary, including the ordering contracts that a unit test cannot see
 * (mkdir before create, write-before-rename, delete-closes-the-file).
 */

function resetStore(): void {
  setConfigSnapshot({});
  useAppStore.setState({
    vaultPath: null,
    vaultName: "",
    tree: [],
    flatFiles: [],
    flatAssets: [],
    folders: [],
    recentFiles: [],
    currentFile: null,
    dirty: false,
    toast: null,
    modal: null,
    mode: "notes",
    linkBack: [],
    sidebarOpen: true,
    renameRequest: null,
  });
}

async function seedVault(entries: Record<string, string>): Promise<void> {
  fakeVault.seed(entries);
  const info = await fakeVault.api.setVault(ROOT);
  useAppStore.getState().setVault(info);
}

beforeEach(() => {
  resetStore();
});

describe("refreshTree", () => {
  it("fills the index and keeps already expanded directories", async () => {
    await seedVault({
      "a.md": "a",
      "dir/b.md": "b",
      "dir/sub/c.md": "c",
      "img.png": "png",
    });
    // `dir` was expanded before the refresh; its children must be re-read and
    // merged instead of being collapsed back to the lazy null.
    useAppStore.setState({
      tree: [{ name: "dir", relPath: "dir", kind: "dir", children: [] }],
    });

    await refreshTree();

    const state = useAppStore.getState();
    expect(state.flatFiles).toEqual(["a.md", "dir/b.md", "dir/sub/c.md"]);
    expect(state.flatAssets).toEqual(["img.png"]);
    expect(state.folders).toEqual(["dir", "dir/sub"]);
    const dir = state.tree.find((n) => n.relPath === "dir");
    expect(dir?.children?.map((n) => n.name)).toEqual(["sub", "b.md"]);
    expect(dir?.children?.[0].children).toBeNull();
    expect(state.tree.map((n) => n.name)).toEqual(["dir", "a.md", "img.png"]);
  });

  it("a failed index read keeps the previous tree instead of clearing it", async () => {
    await seedVault({ "a.md": "a" });
    await refreshTree();
    const before = useAppStore.getState().tree;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeVault.failNext("listFiles", "READ_FAILED");
    await refreshTree();
    expect(useAppStore.getState().tree).toBe(before);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("loadDirChildren", () => {
  it("merges only the requested directory, preserving other loaded levels", async () => {
    await seedVault({ "dir/a.md": "a", "dir/sub/b.md": "b", "other.md": "o" });
    useAppStore.setState({
      tree: [
        { name: "dir", relPath: "dir", kind: "dir", children: [] },
        { name: "other.md", relPath: "other.md", kind: "file", children: null },
      ],
    });

    await loadDirChildren("dir");

    const dir = useAppStore.getState().tree.find((n) => n.relPath === "dir");
    expect(dir?.children?.map((n) => n.name)).toEqual(["sub", "a.md"]);
    expect(dir?.children?.[0].children).toBeNull();
  });
});

describe("quickAddNote", () => {
  it("creates the target folder, applies the template and opens the note", async () => {
    await seedVault({ "Templates/t.md": "# {{title}}\n{{date}}\n{{unknown}}" });

    await quickAddNote("Inbox/Sub", "Note", "Templates/t.md");

    const state = useAppStore.getState();
    expect(fakeVault.read("Inbox/Sub/Note.md")).toMatch(
      /^# Note\n\d{4}-\d{2}-\d{2}\n\{\{unknown\}\}$/,
    );
    expect(state.currentFile).toBe(`${ROOT}/Inbox/Sub/Note.md`);
    // The backend needs the folder before the file exists. The template write
    // follows the create; no other write belongs to this operation.
    expect(fakeVault.writes.map((w) => w.kind)).toEqual(["ensureDir", "createFile", "write"]);
    expect(state.flatFiles).toContain("Inbox/Sub/Note.md");
  });

  it("dedupes the name like the backend (name 2.md)", async () => {
    await seedVault({ "Inbox/Note.md": "already here" });
    await quickAddNote("Inbox", "Note");
    await quickAddNote("Inbox", "Note");
    expect(fakeVault.read("Inbox/Note 2.md")).toBe("");
    expect(fakeVault.read("Inbox/Note 3.md")).toBe("");
    expect(fakeVault.read("Inbox/Note.md")).toBe("already here");
  });

  it("a missing template still creates the note and tells the user", async () => {
    await seedVault({});
    await quickAddNote("Inbox", "Note", "Templates/missing.md");
    expect(fakeVault.read("Inbox/Note.md")).toBe("");
    expect(useAppStore.getState().toast).toContain("模板读取失败");
  });

  it("does nothing without an open vault or a usable name", async () => {
    await quickAddNote("Inbox", "Note");
    expect(fakeVault.writes).toEqual([]);
    await seedVault({});
    await quickAddNote("Inbox", "   ");
    expect(fakeVault.writes).toEqual([]);
  });
});

describe("newFolder", () => {
  it("requests the inline rename on the directory the backend actually created", async () => {
    await seedVault({ "New Folder/x.md": "x" });
    await newFolder();
    const state = useAppStore.getState();
    expect(state.renameRequest).toBe("New Folder 2");
    expect(state.sidebarOpen).toBe(true);
    expect(fakeVault.dirs.has("New Folder 2")).toBe(true);
  });
});

describe("renameEntry", () => {
  it("keeps the extension when the new name omits it", async () => {
    await seedVault({ "old.md": "text" });
    useAppStore.setState({ currentFile: `${ROOT}/old.md` });

    await renameEntry(`${ROOT}/old.md`, "new", true);

    expect(fakeVault.read("new.md")).toBe("text");
    expect(fakeVault.exists("old.md")).toBe(false);
    expect(useAppStore.getState().currentFile).toBe(`${ROOT}/new.md`);
  });

  it("rewrites the current file path when its parent directory is renamed", async () => {
    await seedVault({ "dir/a.md": "a" });
    useAppStore.setState({ currentFile: `${ROOT}/dir/a.md` });

    await renameEntry(`${ROOT}/dir`, "renamed");

    expect(fakeVault.read("renamed/a.md")).toBe("a");
    expect(useAppStore.getState().currentFile).toBe(`${ROOT}/renamed/a.md`);
  });

  it("reports a refused rename instead of losing the old name", async () => {
    await seedVault({ "a.md": "a", "b.md": "b" });
    await renameEntry(`${ROOT}/a.md`, "b.md", true);
    expect(fakeVault.read("a.md")).toBe("a");
    expect(useAppStore.getState().toast).toContain("重命名失败");
  });
});

describe("trashEntry", () => {
  it("closes the current file when its directory is deleted", async () => {
    await seedVault({ "dir/a.md": "a" });
    useAppStore.setState({ currentFile: `${ROOT}/dir/a.md` });

    await trashEntry(`${ROOT}/dir`);

    expect(fakeVault.exists("dir")).toBe(false);
    expect(useAppStore.getState().currentFile).toBeNull();
    expect(useAppStore.getState().flatFiles).toEqual([]);
  });
});

describe("wikilinks", () => {
  beforeEach(async () => {
    await seedVault({ "a.md": "a", "dir/b.md": "b", "dir2/b.md": "b2" });
    await refreshTree();
  });

  it("resolves a bare name to the first indexed match", () => {
    expect(wikiLinkTargetPath("a")).toBe(`${ROOT}/a.md`);
    expect(wikiLinkTargetPath("b")).toBe(`${ROOT}/dir/b.md`);
    expect(wikiLinkTargetPath("missing")).toBeNull();
  });

  it("pushes the jump chain and opens the target", () => {
    useAppStore.setState({ currentFile: `${ROOT}/a.md` });
    expect(openWikiLink("b", `${ROOT}/a.md`)).toBe(true);
    expect(useAppStore.getState().currentFile).toBe(`${ROOT}/dir/b.md`);
    expect(useAppStore.getState().linkBack).toEqual([
      { from: `${ROOT}/a.md`, to: `${ROOT}/dir/b.md` },
    ]);
  });

  it("a self-link does not reload the document and does not push a hop", () => {
    expect(openWikiLink("a", `${ROOT}/a.md`)).toBe(false);
    expect(useAppStore.getState().linkBack).toEqual([]);
  });

  it("a missing target shows a toast and returns false", () => {
    expect(openWikiLink("missing")).toBe(false);
    expect(useAppStore.getState().toast).toContain("未找到笔记");
  });
});

describe("reloadSnippetsFromVault", () => {
  it("falls back to built-in snippets when the vault has no snippets.js", async () => {
    await seedVault({});
    const outcome = await reloadSnippetsFromVault();
    expect(outcome?.status).toBe("builtin");
  });

  it("an invalid snippets.js is reported as an error and falls back to built-in", async () => {
    await seedVault({ ".bnote/snippets.js": "export default 42" });
    const outcome = await reloadSnippetsFromVault();
    expect(outcome?.status).toBe("error");
  });
});

describe("openVault", () => {
  it("opens the last file of the vault and records the MRU", async () => {
    await seedVault({ "a.md": "hello", "dir/b.md": "b" });
    setConfigSnapshot({
      lastVault: ROOT,
      lastFileByVault: { [ROOT]: `${ROOT}/a.md` },
    });

    const opened = await openVault(ROOT);

    expect(opened).toBe(true);
    const state = useAppStore.getState();
    expect(state.vaultPath).toBe(ROOT);
    expect(state.currentFile).toBe(`${ROOT}/a.md`);
    expect(state.flatFiles).toContain("dir/b.md");
    expect(getConfigSnapshot().lastVault).toBe(ROOT);
    expect(getConfigSnapshot().recentVaults?.[0]).toBe(ROOT);
  });

  it("a bad vault path is reported honestly and leaves the old state alone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeVault.failNext("setVault", "INVALID_VAULT: not a directory");
    const opened = await openVault("/missing");
    expect(opened).toBe(false);
    expect(useAppStore.getState().vaultPath).toBeNull();
    expect(useAppStore.getState().toast).toContain("打开仓库失败");
    error.mockRestore();
  });
});

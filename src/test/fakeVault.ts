import type {
  FileNode,
  PythonInfo,
  PythonLspSyncResult,
  PythonProjectConfig,
  PythonRunStarted,
  PythonUvOutcome,
  SetImeOutcome,
  VaultConfigFile,
  VaultIndex,
  VaultInfo,
} from "@/lib/tauri";

/**
 * In-memory stand-in for the Rust vault commands.
 *
 * The integration project mocks `@/lib/tauri` with this object
 * (`src/test/setup.integration.ts`), so tests can drive several real modules —
 * stores, actions, the daily engine — through the same IPC boundary the app
 * uses, without touching a real vault or a Tauri runtime.
 *
 * It deliberately models the backend's observable rules, not its code:
 * - createFile/createDir dedupe ("name 2.md");
 * - rename refuses an existing target;
 * - paths are confined to the configured vault;
 * - `.bnote` is visible in the tree but excluded from the note index;
 * - `trashPath` removes the entry (the OS trash is not modelled).
 *
 * Every write is recorded in `writes`, so tests can assert ordering contracts
 * (for example "save queued before delete, then delete").
 */

const NOTE_EXTENSIONS = [".md", ".markdown", ".txt"];
const ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
  ".ico",
  ".tif",
  ".tiff",
  ".heic",
  ".pdf",
  ".excalidraw",
  ".excalidraw.md",
];
const INDEX_IGNORED_DIRS = new Set([
  ".git",
  ".bnote",
  ".obsidian",
  ".DS_Store",
  "node_modules",
  ".trash",
]);
const TREE_IGNORED_DIRS = new Set([".git", ".obsidian", ".DS_Store", "node_modules", ".trash"]);
const VAULT_CONFIG_FILES: readonly VaultConfigFile[] = [
  "vimrc",
  "snippets.js",
  "keybindings.json",
  "agent.md",
  "AGENTS.md",
];

export type WriteRecord =
  | { kind: "write"; path: string; contents: string }
  | { kind: "append"; path: string; contents: string }
  | { kind: "createFile"; parent: string; name: string; path: string }
  | { kind: "createDir"; parent: string; name: string; path: string }
  | { kind: "ensureDir"; relPath: string }
  | { kind: "rename"; path: string; newName: string; newPath: string }
  | { kind: "trash"; path: string }
  | { kind: "saveConfig"; config: unknown }
  | { kind: "saveKeybindings"; keybindings: unknown };

interface Failure {
  op: string;
  error: string;
  once: boolean;
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function dirname(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function basename(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}

function isNote(name: string): boolean {
  const lower = name.toLowerCase();
  return NOTE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isAsset(name: string): boolean {
  const lower = name.toLowerCase();
  return ASSET_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function stripExtension(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, i), ext: name.slice(i + 1) };
}

export class FakeVault {
  root = "/fake/vault";
  readonly files = new Map<string, string>();
  /** Directories, vault-relative ("" is the root). */
  readonly dirs = new Set<string>([""]);
  readonly writes: WriteRecord[] = [];
  config: unknown = null;
  keybindings: unknown = null;
  vimrc: string | null = null;
  private failures: Failure[] = [];

  reset(): void {
    this.root = "/fake/vault";
    this.files.clear();
    this.dirs.clear();
    this.dirs.add("");
    this.writes.length = 0;
    this.config = null;
    this.keybindings = null;
    this.vimrc = null;
    this.failures = [];
  }

  /** Seed the vault with vault-relative paths and contents. */
  seed(entries: Record<string, string>): this {
    for (const [rel, text] of Object.entries(entries)) {
      this.put(rel, text);
    }
    return this;
  }

  /** Seed empty directories. */
  seedDirs(...dirs: string[]): this {
    for (const dir of dirs) this.ensureDirSync(dir);
    return this;
  }

  put(rel: string, text: string): void {
    const clean = normalizeRel(rel);
    this.files.set(clean, text);
    this.ensureParents(clean);
  }

  read(rel: string): string | undefined {
    return this.files.get(normalizeRel(rel));
  }

  exists(rel: string): boolean {
    const clean = normalizeRel(rel);
    return this.files.has(clean) || this.dirs.has(clean);
  }

  /** Fail the next call of one operation, then clear the failure. */
  failNext(op: string, error: string): void {
    this.failures.push({ op, error, once: true });
  }

  /** Fail every call of one operation until cleared with `clearFailures`. */
  failAlways(op: string, error: string): void {
    this.failures.push({ op, error, once: false });
  }

  clearFailures(): void {
    this.failures = [];
  }

  private fail(op: string): void {
    const index = this.failures.findIndex((f) => f.op === op);
    if (index < 0) return;
    const failure = this.failures[index];
    if (failure.once) this.failures.splice(index, 1);
    throw new Error(failure.error);
  }

  private ensureParents(rel: string): void {
    const parts = normalizeRel(rel).split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }

  private ensureDirSync(rel: string): void {
    const clean = normalizeRel(rel);
    if (!clean) return;
    this.ensureParents(clean);
    this.dirs.add(clean);
  }

  private abs(rel: string): string {
    const clean = normalizeRel(rel);
    return clean ? `${this.root}/${clean}` : this.root;
  }

  private relFromAbs(path: string): string {
    if (path === this.root) return "";
    if (!path.startsWith(`${this.root}/`)) throw new Error(`FORBIDDEN: ${path}`);
    return path.slice(this.root.length + 1);
  }

  private resolveCallPath(path: string): string {
    return path.startsWith("/") ? this.relFromAbs(path) : normalizeRel(path);
  }

  private childrenOf(rel: string): FileNode[] {
    const prefix = rel ? `${rel}/` : "";
    const nodes = new Map<string, FileNode>();
    for (const dir of this.dirs) {
      if (!dir || dir === rel || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest.includes("/")) continue;
      if (TREE_IGNORED_DIRS.has(rest)) continue;
      nodes.set(rest, { name: rest, relPath: dir, kind: "dir", children: null });
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest.includes("/")) continue;
      if (!isNote(rest) && !isAsset(rest)) continue;
      nodes.set(rest, { name: rest, relPath: file, kind: "file", children: null });
    }
    return [...nodes.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }

  private uniqueSibling(rel: string, name: string): string {
    const parent = dirname(rel);
    let candidate = parent ? `${parent}/${name}` : name;
    const { stem, ext } = stripExtension(name);
    let counter = 2;
    while (this.exists(candidate)) {
      candidate = parent
        ? `${parent}/${stem} ${counter}${ext ? `.${ext}` : ""}`
        : `${stem} ${counter}${ext ? `.${ext}` : ""}`;
      counter += 1;
    }
    return candidate;
  }

  readonly api = {
    setVault: async (path: string): Promise<VaultInfo> => {
      this.fail("setVault");
      this.root = path.replace(/\/+$/, "") || "/";
      this.dirs.add("");
      return { path: this.root, name: basename(this.root) };
    },
    getVault: async (): Promise<VaultInfo | null> => ({
      path: this.root,
      name: basename(this.root),
    }),
    readTree: async (): Promise<FileNode[]> => {
      this.fail("readTree");
      return this.childrenOf("");
    },
    readDir: async (relPath: string): Promise<FileNode[]> => {
      this.fail("readDir");
      return this.childrenOf(normalizeRel(relPath));
    },
    listFiles: async (): Promise<VaultIndex> => {
      this.fail("listFiles");
      const files: string[] = [];
      const dirs: string[] = [];
      const assets: string[] = [];
      for (const file of this.files.keys()) {
        const top = file.split("/")[0];
        if (top === ".bnote" || INDEX_IGNORED_DIRS.has(top)) continue;
        if (isAsset(file)) assets.push(file);
        else if (isNote(file)) files.push(file);
      }
      for (const dir of this.dirs) {
        if (!dir) continue;
        const top = dir.split("/")[0];
        if (INDEX_IGNORED_DIRS.has(top)) continue;
        dirs.push(dir);
      }
      files.sort();
      dirs.sort();
      assets.sort();
      return { files, dirs, assets };
    },
    readFile: async (path: string): Promise<string> => {
      this.fail("readFile");
      const rel = this.resolveCallPath(path);
      const text = this.files.get(rel);
      if (text === undefined) throw new Error(`READ_FAILED: ${path}`);
      return text;
    },
    readFileBase64: async (path: string): Promise<string> => {
      this.fail("readFileBase64");
      const rel = this.resolveCallPath(path);
      const text = this.files.get(rel);
      if (text === undefined) throw new Error(`READ_FAILED: ${path}`);
      return text;
    },
    writeFile: async (path: string, contents: string): Promise<void> => {
      this.fail("writeFile");
      const rel = this.resolveCallPath(path);
      this.put(rel, contents);
      this.writes.push({ kind: "write", path: rel, contents });
    },
    appendFile: async (path: string, contents: string): Promise<void> => {
      this.fail("appendFile");
      const rel = this.resolveCallPath(path);
      this.put(rel, (this.files.get(rel) ?? "") + contents);
      this.writes.push({ kind: "append", path: rel, contents });
    },
    writeFileBase64: async (path: string, contentsBase64: string): Promise<void> => {
      this.fail("writeFileBase64");
      const rel = this.resolveCallPath(path);
      this.put(rel, contentsBase64);
      this.writes.push({ kind: "write", path: rel, contents: contentsBase64 });
    },
    createFile: async (
      parent: string,
      name: string,
    ): Promise<{ path: string; relPath: string }> => {
      this.fail("createFile");
      const cleanParent = normalizeRel(parent);
      this.ensureDirSync(cleanParent);
      const rel = this.uniqueSibling(`${cleanParent ? `${cleanParent}/` : ""}${name}`, name);
      this.put(rel, "");
      this.writes.push({ kind: "createFile", parent: cleanParent, name, path: rel });
      return { path: this.abs(rel), relPath: rel };
    },
    createDir: async (parent: string, name: string): Promise<{ path: string; relPath: string }> => {
      this.fail("createDir");
      const cleanParent = normalizeRel(parent);
      this.ensureDirSync(cleanParent);
      const rel = this.uniqueSibling(`${cleanParent ? `${cleanParent}/` : ""}${name}`, name);
      this.ensureDirSync(rel);
      this.writes.push({ kind: "createDir", parent: cleanParent, name, path: rel });
      return { path: this.abs(rel), relPath: rel };
    },
    ensureDir: async (relPath: string): Promise<void> => {
      this.fail("ensureDir");
      const rel = normalizeRel(relPath);
      this.ensureDirSync(rel);
      this.writes.push({ kind: "ensureDir", relPath: rel });
    },
    renamePath: async (path: string, newName: string): Promise<string> => {
      this.fail("renamePath");
      const rel = this.resolveCallPath(path);
      const targetRel = dirname(rel) ? `${dirname(rel)}/${newName}` : newName;
      if (this.exists(targetRel)) throw new Error(`RENAME_FAILED: ${newName} already exists`);
      if (this.files.has(rel)) {
        const text = this.files.get(rel) ?? "";
        this.files.delete(rel);
        this.put(targetRel, text);
      } else if (this.dirs.has(rel)) {
        const prefix = `${rel}/`;
        for (const file of [...this.files.keys()]) {
          if (!file.startsWith(prefix)) continue;
          const text = this.files.get(file) ?? "";
          this.files.delete(file);
          this.put(`${targetRel}/${file.slice(prefix.length)}`, text);
        }
        for (const dir of [...this.dirs]) {
          if (dir !== rel && !dir.startsWith(prefix)) continue;
          this.dirs.delete(dir);
          this.ensureDirSync(dir === rel ? targetRel : `${targetRel}${dir.slice(rel.length)}`);
        }
      } else {
        throw new Error(`RENAME_FAILED: ${path}`);
      }
      this.writes.push({ kind: "rename", path: rel, newName, newPath: targetRel });
      return this.abs(targetRel);
    },
    trashPath: async (path: string): Promise<void> => {
      this.fail("trashPath");
      const rel = this.resolveCallPath(path);
      if (this.files.has(rel)) {
        this.files.delete(rel);
      } else if (this.dirs.has(rel)) {
        const prefix = `${rel}/`;
        for (const file of [...this.files.keys()])
          if (file.startsWith(prefix)) this.files.delete(file);
        for (const dir of [...this.dirs])
          if (dir === rel || dir.startsWith(prefix)) this.dirs.delete(dir);
      } else {
        throw new Error(`TRASH_FAILED: ${path}`);
      }
      this.writes.push({ kind: "trash", path: rel });
    },
    readVaultFile: async (name: VaultConfigFile): Promise<string | null> => {
      this.fail("readVaultFile");
      if (!VAULT_CONFIG_FILES.includes(name)) throw new Error(`INVALID_NAME: ${name}`);
      return this.files.get(`.bnote/${name}`) ?? null;
    },
    writeVaultFile: async (name: VaultConfigFile, contents: string): Promise<void> => {
      this.fail("writeVaultFile");
      if (!VAULT_CONFIG_FILES.includes(name)) throw new Error(`INVALID_NAME: ${name}`);
      this.put(`.bnote/${name}`, contents);
      this.writes.push({ kind: "write", path: `.bnote/${name}`, contents });
    },
    loadAppConfig: async (): Promise<unknown> => {
      this.fail("loadAppConfig");
      return this.config;
    },
    saveAppConfig: async (config: unknown): Promise<void> => {
      this.fail("saveAppConfig");
      this.config = config;
      this.writes.push({ kind: "saveConfig", config });
    },
    loadKeybindings: async (): Promise<unknown> => {
      this.fail("loadKeybindings");
      return this.keybindings;
    },
    saveKeybindings: async (keybindings: unknown): Promise<void> => {
      this.fail("saveKeybindings");
      this.keybindings = keybindings;
      this.writes.push({ kind: "saveKeybindings", keybindings });
    },
    readVimrc: async (): Promise<string | null> => {
      this.fail("readVimrc");
      return this.vimrc;
    },
    saveVimrc: async (contents: string): Promise<void> => {
      this.fail("saveVimrc");
      this.vimrc = contents;
      this.writes.push({ kind: "write", path: "<app-data>/vimrc", contents });
    },
    listInputSources: async () => [],
    getCurrentInputSource: async () => "",
    setInputSource: async (): Promise<SetImeOutcome> => ({
      switched: false,
      tisMs: 0,
    }),
    pythonRun: async (): Promise<PythonRunStarted> => ({
      runId: 1,
      command: "python3 script.py",
      envKind: "system",
      program: "python3",
      cwd: this.root,
    }),
    pythonRunCancel: async () => true,
    pythonGetInfo: async (): Promise<PythonInfo> => ({
      projectRoot: null,
      projectName: basename(this.root),
      lsp: "off",
      pythonOverride: null,
      tyPath: null,
      venvExists: false,
      hasPyproject: false,
      env: null,
      uvAvailable: false,
      tyAvailable: false,
    }),
    pythonSetProjectConfig: async (_mdPath: string, patch: PythonProjectConfig) => patch,
    pythonLspSync: async (): Promise<PythonLspSyncResult> => ({ enabled: true }),
    pythonLspRequest: async () => null,
    pythonLspClose: async () => {},
    pythonLspStopAll: async () => {},
    pythonUvCreate: async (): Promise<PythonUvOutcome> => ({
      log: "not modelled",
      ranInit: false,
    }),
  };
}

export const fakeVault = new FakeVault();

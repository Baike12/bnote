import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  dirname,
  fileName,
  isJsonPath,
  joinPath,
  relDirname,
  vaultRelPath,
  wikilinkText,
} from "./path";

/**
 * Path rules are shared by the sidebar, quick-add, wikilink insertion and the
 * JSON editor. They are pure strings (POSIX `/`), so the full contract is
 * cheap to lock here.
 */

describe("dirname", () => {
  it("returns the vault-relative directory of an absolute path", () => {
    expect(dirname("/vault/a.md", "/vault")).toBe("");
    expect(dirname("/vault/Notes/a.md", "/vault")).toBe("Notes");
    expect(dirname("/vault/Notes/deep/a.md", "/vault")).toBe("Notes/deep");
  });

  it("keeps the input when it is outside the vault", () => {
    expect(dirname("/other/a.md", "/vault")).toBe("/other");
  });

  it("handles a trailing slash on the vault root", () => {
    expect(dirname("/vault/Notes/a.md", "/vault/")).toBe("Notes");
  });
});

describe("relDirname", () => {
  it("returns the parent of a vault-relative path", () => {
    expect(relDirname("a.md")).toBe("");
    expect(relDirname("Notes/a.md")).toBe("Notes");
    expect(relDirname("Notes/deep/a.md")).toBe("Notes/deep");
  });
});

describe("ancestorDirs", () => {
  it("lists ancestors root-first without the file itself", () => {
    expect(ancestorDirs("a.md")).toEqual([]);
    expect(ancestorDirs("Notes/a.md")).toEqual(["Notes"]);
    expect(ancestorDirs("Notes/deep/a.md")).toEqual(["Notes", "Notes/deep"]);
  });
});

describe("joinPath", () => {
  it("joins without doubling or dropping the separator", () => {
    expect(joinPath("", "a.md")).toBe("a.md");
    expect(joinPath("/vault", "a.md")).toBe("/vault/a.md");
    expect(joinPath("/vault/", "/a.md")).toBe("/vault/a.md");
    expect(joinPath("/vault", "Notes/a.md")).toBe("/vault/Notes/a.md");
  });
});

describe("fileName", () => {
  it("returns the last segment", () => {
    expect(fileName("a.md")).toBe("a.md");
    expect(fileName("Notes/a.md")).toBe("a.md");
    expect(fileName("/vault/Notes/")).toBe("");
  });
});

describe("vaultRelPath", () => {
  it("strips the root and its separator", () => {
    expect(vaultRelPath("/vault", "/vault")).toBe("");
    expect(vaultRelPath("/vault/a.md", "/vault")).toBe("a.md");
    expect(vaultRelPath("/vault/Notes/a.md", "/vault/")).toBe("Notes/a.md");
  });

  it("returns paths outside the vault unchanged", () => {
    expect(vaultRelPath("/other/a.pdf", "/vault")).toBe("/other/a.pdf");
    expect(vaultRelPath("/vault-2/a.md", "/vault")).toBe("/vault-2/a.md");
  });

  it("returns the absolute path when there is no root", () => {
    expect(vaultRelPath("/vault/a.md", "")).toBe("/vault/a.md");
  });
});

describe("wikilinkText", () => {
  it("uses the bare note name when it is unique", () => {
    expect(wikilinkText("Notes/a.md", ["Notes/a.md", "b.md"])).toBe("a");
    expect(wikilinkText("Notes/a.markdown", [])).toBe("a");
  });

  it("uses the relative path when another note shares the name", () => {
    expect(wikilinkText("Notes/a.md", ["Notes/a.md", "Other/a.md"])).toBe("Notes/a");
  });

  it("rejects targets that cannot be written inside [[...]]", () => {
    expect(wikilinkText("a[1].md", [])).toBeNull();
    expect(wikilinkText("a|b.md", [])).toBeNull();
    expect(wikilinkText("a#b.md", [])).toBeNull();
    expect(wikilinkText("a^b.md", [])).toBeNull();
  });
});

describe("isJsonPath", () => {
  it("recognizes .json case-insensitively and rejects everything else", () => {
    expect(isJsonPath("/vault/a.json")).toBe(true);
    expect(isJsonPath("/vault/A.JSON")).toBe(true);
    expect(isJsonPath("/vault/a.md")).toBe(false);
    expect(isJsonPath(null)).toBe(false);
    expect(isJsonPath(undefined)).toBe(false);
  });
});

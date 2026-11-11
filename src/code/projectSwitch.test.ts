import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { projectLabel, switchCandidates } from "./projectSwitch";

describe("the project switcher's list", () => {
  // The open project is not offered again: choosing it would flush the buffers
  // and rescan the repository for no reason.
  it("drops the open project and keeps the open order", () => {
    expect(switchCandidates(["/c", "/a", "/b"], "/a")).toEqual(["/c", "/b"]);
    expect(switchCandidates(["/a"], "/a")).toEqual([]);
    expect(switchCandidates([], "/a")).toEqual([]);
  });

  it("dedupes a repeated path (a hand-edited config may repeat one)", () => {
    expect(switchCandidates(["/a", "/b", "/a", "/b"], "/c")).toEqual(["/a", "/b"]);
  });

  it("names a project by its folder", () => {
    expect(projectLabel("/Users/baike3/CodeRepo/auto-ontology")).toBe("auto-ontology");
    expect(projectLabel("/Users/baike3/CodeRepo/auto-ontology/")).toBe("auto-ontology");
    expect(projectLabel("./repo")).toBe("repo");
    expect(projectLabel("repo")).toBe("repo");
    // Nothing to slice: show the path instead of an empty label.
    expect(projectLabel("/")).toBe("/");
  });
});

describe("the switcher is wired into the code toolbar", () => {
  const pane = readFileSync("src/code/components/CodeProjectPane.tsx", "utf8");

  it("renders the project name before the file tree button", () => {
    const switcherAt = pane.indexOf("<ProjectSwitcher />");
    const treeAt = pane.indexOf("文件树");
    expect(switcherAt).toBeGreaterThan(-1);
    expect(treeAt).toBeGreaterThan(-1);
    expect(switcherAt).toBeLessThan(treeAt);
  });

  it("does not use a native select (the app's dropdowns are a button + popover)", () => {
    // Comments are stripped first: the doc comment explains *why* there is no
    // `<select>`, and that sentence must not fail the check.
    const switcher = readFileSync("src/code/components/ProjectSwitcher.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(switcher).not.toMatch(/<select/);
    expect(switcher).toMatch(/content-title-btn/);
    expect(switcher).toMatch(/study-history-pop/);
  });
});

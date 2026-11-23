import { describe, expect, it } from "vitest";
import { fileIconName, fileIconSrc } from "./fileIcon";

/**
 * The icon-name gate of the file tree: every expectation is the name of an
 * asset under `public/material-icons`, so a name that does not round-trip to a
 * real SVG fails here instead of on screen. The component only paints
 * (components/FileIcon.tsx).
 */
describe("fileIconName", () => {
  it("script languages resolve to their own Material icon", () => {
    expect(fileIconName("main.ts")).toBe("typescript");
    expect(fileIconName("App.tsx")).toBe("react_ts");
    expect(fileIconName("index.mjs")).toBe("javascript");
    expect(fileIconName("tool.py")).toBe("python");
    expect(fileIconName("lib.rs")).toBe("rust");
    expect(fileIconName("server.go")).toBe("go");
    expect(fileIconName("main.c")).toBe("c");
    expect(fileIconName("Main.java")).toBe("java");
  });

  it("an extension the alias table does not know still uses its own icon when the set has one", () => {
    expect(fileIconName("core.zig")).toBe("zig");
  });

  it("config, doc, style, markup, image and script resolve to their type icons", () => {
    expect(fileIconName("package.json")).toBe("json");
    expect(fileIconName("ci.yml")).toBe("yaml");
    expect(fileIconName("Cargo.lock")).toBe("lock");
    expect(fileIconName("README.md")).toBe("readme");
    expect(fileIconName("paper.tex")).toBe("tex");
    expect(fileIconName("site.css")).toBe("css");
    expect(fileIconName("page.html")).toBe("html");
    expect(fileIconName("logo.svg")).toBe("svg");
    expect(fileIconName("photo.JPEG")).toBe("image");
    expect(fileIconName("deploy.sh")).toBe("console");
    expect(fileIconName("report.docx")).toBe("word");
  });

  it("named files win over their extension, including a dotted stem", () => {
    expect(fileIconName("Dockerfile")).toBe("docker");
    expect(fileIconName("Makefile")).toBe("makefile");
    expect(fileIconName(".gitignore")).toBe("git");
    expect(fileIconName(".env.local")).toBe("settings");
    expect(fileIconName(".zshrc")).toBe("console");
    expect(fileIconName("tsconfig.base.json")).toBe("tsconfig");
    expect(fileIconName("vitest.config.ts")).toBe("vitest");
    expect(fileIconName("pnpm-lock.yaml")).toBe("lock");
  });

  it("a name nothing knows falls back to the document icon", () => {
    expect(fileIconName("LICENSE")).toBe("document");
    expect(fileIconName("notes.")).toBe("document");
    expect(fileIconName("")).toBe("document");
  });

  it("the match is case-insensitive", () => {
    expect(fileIconName("MAIN.PY")).toBe("python");
    expect(fileIconName("Config.YAML")).toBe("yaml");
  });

  it("the src is the asset path of the resolved name", () => {
    expect(fileIconSrc("main.ts")).toBe("/material-icons/typescript.svg");
  });
});

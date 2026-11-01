import { describe, expect, it } from "vitest";
import { fileIconKind } from "./fileIcon";

/**
 * 文件树图标的分类门禁:加语言/配置类型时先在这里落一行,
 * 组件只负责画(见 components/FileIcon.tsx)。
 */
describe("fileIconKind", () => {
  it("脚本语言按语言分类", () => {
    expect(fileIconKind("main.ts")).toBe("ts");
    expect(fileIconKind("App.tsx")).toBe("ts");
    expect(fileIconKind("index.mjs")).toBe("js");
    expect(fileIconKind("tool.py")).toBe("py");
    expect(fileIconKind("lib.rs")).toBe("rs");
    expect(fileIconKind("server.go")).toBe("go");
    // 其余编译型/脚本语言归中性 code,不各配一个图标
    expect(fileIconKind("main.c")).toBe("code");
    expect(fileIconKind("Main.java")).toBe("code");
    expect(fileIconKind("Rakefile")).toBe("code");
  });

  it("配置/文档/样式/标记/图片/脚本各归一类", () => {
    expect(fileIconKind("package.json")).toBe("data");
    expect(fileIconKind("ci.yml")).toBe("data");
    expect(fileIconKind("Cargo.lock")).toBe("data");
    expect(fileIconKind("README.md")).toBe("doc");
    expect(fileIconKind("paper.tex")).toBe("doc");
    expect(fileIconKind("site.css")).toBe("style");
    expect(fileIconKind("page.html")).toBe("markup");
    expect(fileIconKind("logo.svg")).toBe("image");
    expect(fileIconKind("photo.JPEG")).toBe("image");
    expect(fileIconKind("deploy.sh")).toBe("shell");
  });

  it("无扩展名/点文件按名字认,认不出就是普通文件", () => {
    expect(fileIconKind("Dockerfile")).toBe("code");
    expect(fileIconKind("Makefile")).toBe("code");
    expect(fileIconKind(".gitignore")).toBe("data");
    expect(fileIconKind(".zshrc")).toBe("shell");
    expect(fileIconKind("LICENSE")).toBe("file");
    expect(fileIconKind("notes.")).toBe("file");
    expect(fileIconKind("")).toBe("file");
  });

  it("大小写不敏感", () => {
    expect(fileIconKind("MAIN.PY")).toBe("py");
    expect(fileIconKind("Config.YAML")).toBe("data");
  });
});

import { describe, expect, it } from "vitest";
import {
  planGoto,
  shortPath,
  unavailableReasonOf,
  type GotoTarget,
} from "./gotoPlan";

const inside = (path: string): GotoTarget => ({ path, external: false });
const outside = (path: string): GotoTarget => ({ path, external: true });

describe("planGoto", () => {
  it("jumps to the single in-project location", () => {
    const plan = planGoto([inside("cs336_basics/model.py")]);
    expect(plan).toEqual({ kind: "jump", target: inside("cs336_basics/model.py") });
  });

  it("prefers the in-project location when the server lists a stub first", () => {
    // ty answers a type definition with typeshed before the real source.
    const plan = planGoto([
      outside("/Users/me/.cache/ty/vendored/typeshed/stdlib/types.pyi"),
      inside("cs336_basics/data6.py"),
    ]);
    expect(plan.kind).toBe("jump");
    expect(plan.kind === "jump" && plan.target.path).toBe("cs336_basics/data6.py");
  });

  it("reports an external-only answer instead of pretending there is no location", () => {
    const plan = planGoto([outside("/Users/me/.cache/ty/vendored/typeshed/stdlib/builtins.pyi")]);
    expect(plan.kind).toBe("outside");
    expect(plan.kind === "outside" && plan.target.path).toContain("builtins.pyi");
  });

  it("has nothing to do for an empty answer", () => {
    expect(planGoto([])).toEqual({ kind: "none" });
  });
});

describe("shortPath", () => {
  it("keeps short paths untouched", () => {
    expect(shortPath("cs336_basics/data6.py")).toBe("cs336_basics/data6.py");
  });

  it("keeps only the tail of a long absolute path", () => {
    expect(shortPath("/Users/me/.cache/ty/vendored/typeshed/stdlib/builtins.pyi")).toBe(
      "…/typeshed/stdlib/builtins.pyi",
    );
  });

  it("ignores trailing and repeated separators", () => {
    expect(shortPath("/a/b/c/", 2)).toBe("…/b/c");
  });
});

describe("unavailableReasonOf", () => {
  it("recognizes a server that was never started", () => {
    expect(unavailableReasonOf("LSP_NOT_RUNNING: python 语言服务器没有启动")).toBe(
      "not-running",
    );
  });

  it("recognizes a server that died or timed out", () => {
    expect(unavailableReasonOf("LSP_UNREACHABLE: LSP_TIMEOUT: textDocument/definition")).toBe(
      "unreachable",
    );
  });

  it("does not treat other failures as a missing server", () => {
    // An empty answer and an unrelated error must keep their own meaning: the
    // server was asked and said "nothing here".
    expect(unavailableReasonOf("")).toBeNull();
    expect(unavailableReasonOf("FORBIDDEN_METHOD: textDocument/foo")).toBeNull();
  });
});

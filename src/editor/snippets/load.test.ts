import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { builtinSnippets, findSnippet, snippetStore } from "./engine";
import type { RawSnippet } from "./default-snippets";
import {
  SnippetLoader,
  applySnippetSource,
  applySnippetsEnabled,
  currentUserSnippets,
  normalizeSnippetExport,
} from "./load";

/**
 * The gate for the snippet loading: the loading semantics of the vault's
 * snippets.js plus the source-ownership invariant.
 * Background: in the packaged app the blob dynamic import used to be blocked
 * by the CSP and fell back silently (the user changed a snippet and nothing
 * happened), and applySettingsToEditor would reset the source back to the
 * built-in ones — both have a gate of their own.
 */

const USER: RawSnippet[] = [{ trigger: "uq", replacement: "USER$0", options: "A" }];
const USER_SRC = "export default [{ trigger: 'uq', replacement: 'USER$0', options: 'A' }]";
const USER_SRC_V2 = "export default [{ trigger: 'uq2', replacement: 'USER2$0', options: 'A' }]";

/** The user snippets really take effect on the editor side = findSnippet
 *  expands "uq" into "USER". */
function expandsUser(doc = "xuq"): string | undefined {
  return findSnippet(EditorState.create({ doc }), doc.length, doc.slice(-1), {
    auto: true,
    visualText: null,
  })?.replacement.text;
}

/** A countable fake importer: the content cache of loader.load must block a
 *  repeated import. */
function fakeImporter() {
  const calls: string[] = [];
  return {
    calls,
    importer: async (src: string) => {
      calls.push(src);
      if (src === USER_SRC) return USER;
      if (src === USER_SRC_V2) return [{ trigger: "uq2", replacement: "USER2$0", options: "A" }];
      throw new Error(`无法编译的片段源: ${src}`);
    },
  };
}

beforeEach(() => {
  applySnippetSource(null, true);
});

describe("SnippetLoader: loading semantics", () => {
  it("user snippets take effect right after loading (findSnippet reads snippetStore live on every keystroke)", async () => {
    const { importer } = fakeImporter();
    const loader = new SnippetLoader(importer);
    const outcome = await loader.load(USER_SRC, true);
    expect(outcome).toEqual({ status: "user", count: 1 });
    expect(expandsUser()).toBe("USER");
    expect(currentUserSnippets()).toBe(USER);
  });

  it("an empty file (null) falls back to the built-in snippets", async () => {
    const loader = new SnippetLoader(fakeImporter().importer);
    const outcome = await loader.load(null, true);
    expect(outcome.status).toBe("builtin");
    expect(outcome.count).toBe(builtinSnippets.list.length);
    expect(expandsUser()).toBeUndefined();
    expect(currentUserSnippets()).toBeNull();
  });

  it("a failed import falls back to the built-in snippets and hands the error to the caller, keeping none of the previous user snippets", async () => {
    const loader = new SnippetLoader(fakeImporter().importer);
    await loader.load(USER_SRC, true);
    const outcome = await loader.load("broken source", true);
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("无法编译的片段源");
    expect(expandsUser()).toBeUndefined();
    expect(currentUserSnippets()).toBeNull();
  });

  it("a wrong export shape is an explicit error, not a silent 0 snippets", () => {
    expect(() => normalizeSnippetExport({ default: { nope: true } })).toThrow(
      /必须 default 导出片段数组/,
    );
    expect(normalizeSnippetExport({ default: USER })).toEqual(USER);
    expect(normalizeSnippetExport(USER)).toEqual(USER);
  });
});

describe("a function-type replacement goes through the loading chain", () => {
  /** The same shape as the iden entry in the vault's .bnote/snippets.js: the
   *  return value is filed as is and only the tab stops are parsed. */
  const IDEN: RawSnippet = {
    trigger: /iden(\d)/,
    replacement: (match) => {
      const n = Number((match as RegExpExecArray)[1]);
      const rows: string[] = [];
      for (let j = 0; j < n; j++) {
        rows.push(Array.from({ length: n }, (_, i) => (i === j ? "1" : "0")).join(" & "));
      }
      return `\\begin{pmatrix}\n${rows.join(String.raw` \\` + "\n")}\n\\end{pmatrix}`;
    },
    options: "mA",
  };

  it("a function from the vault file is carried over as is and its return value skips the escaping layer (the matrix row separator is two backslashes)", async () => {
    const loader = new SnippetLoader(async () => [IDEN]);
    const outcome = await loader.load("export default [/* iden */]", true);
    expect(outcome).toEqual({ status: "user", count: 1 });

    const doc = "$iden2$";
    const out =
      findSnippet(EditorState.create({ doc }), 6, "2", { auto: true, visualText: null })
        ?.replacement.text ?? "";
    // The assertion deliberately avoids a backslash literal: counting the
    // levels of escaping is too easy to get wrong, so compare code points.
    const BS = String.fromCharCode(92); // One backslash
    const lines = out.split("\n");
    expect(lines).toHaveLength(4); // \begin / first line / second line / \end
    expect(lines[1].endsWith(BS + BS)).toBe(true); // The row separator is LaTeX's two backslashes
    expect([...out].filter((c) => c === BS)).toHaveLength(4); // 1(\begin) + one row separator(2) + 1(\end)

    // 3×3 (the size of iden3 in the user's configuration): two row separators
    const out3 =
      findSnippet(EditorState.create({ doc: "$iden3$" }), 6, "3", { auto: true, visualText: null })
        ?.replacement.text ?? "";
    const lines3 = out3.split("\n");
    expect(lines3).toHaveLength(5);
    expect(lines3[1].endsWith(BS + BS)).toBe(true);
    expect(lines3[2].endsWith(BS + BS)).toBe(true);
    expect(lines3[3].endsWith(BS + BS)).toBe(false);
    expect([...out3].filter((c) => c === BS)).toHaveLength(6);
  });
});

describe("SnippetLoader: content cache", () => {
  it("the same content is not imported twice (every vault event triggers a reload, so the recompile must be blocked)", async () => {
    const { calls, importer } = fakeImporter();
    const loader = new SnippetLoader(importer);
    await loader.load(USER_SRC, true);
    await loader.load(USER_SRC, true);
    expect(calls).toHaveLength(1);
    expect(expandsUser()).toBe("USER");
  });

  it("the same content with only the toggle flipped is not re-imported either, and the toggle takes effect immediately", async () => {
    const { calls, importer } = fakeImporter();
    const loader = new SnippetLoader(importer);
    await loader.load(USER_SRC, true);
    await loader.load(USER_SRC, false);
    expect(calls).toHaveLength(1);
    expect(snippetStore.enabled).toBe(false);
    await loader.load(USER_SRC, true);
    expect(calls).toHaveLength(1);
    expect(snippetStore.enabled).toBe(true);
    expect(expandsUser()).toBe("USER");
  });

  it("changed content is re-imported and the new snippet takes effect", async () => {
    const { calls, importer } = fakeImporter();
    const loader = new SnippetLoader(importer);
    await loader.load(USER_SRC, true);
    const outcome = await loader.load(USER_SRC_V2, true);
    expect(calls).toHaveLength(2);
    expect(outcome).toEqual({ status: "user", count: 1 });
    expect(expandsUser("xuq2")).toBe("USER2");
  });
});

describe("source ownership: applySnippetsEnabled only flips the toggle and never touches the source", () => {
  it("applying settings (opening a file and changing a setting both go through it) does not clear the loaded user snippets", async () => {
    const loader = new SnippetLoader(fakeImporter().importer);
    await loader.load(USER_SRC, true);
    applySnippetsEnabled(false);
    expect(snippetStore.enabled).toBe(false);
    expect(currentUserSnippets()).toBe(USER);
    applySnippetsEnabled(true);
    expect(expandsUser()).toBe("USER");
  });
});

describe("wiring gate: the settings application in actions.ts must not touch the source again", () => {
  // ?raw fetches the source text: the correctness of the wiring cannot be
  // tested through actions.ts's runtime dependencies (the app-level
  // dependency graph does not fit a DOM-less test), so a text gate locks this
  // shape that really broke in production.
  const modules = import.meta.glob<string>("../../app/actions.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const actions = modules["../../app/actions.ts"] ?? "";

  it("applySettingsToEditor goes through applySnippetsEnabled (the settings channel) and reloadSnippets(null,…) never appears again", () => {
    expect(actions).not.toBe("");
    expect(actions).toMatch(/applySnippetsEnabled\(settings\.snippets\)/);
    // Resetting the source used to knock the vault snippets back to the
    // built-in ones on every file open — this call shape must never come
    // back.
    expect(actions).not.toMatch(/reloadSnippets\(null/);
  });
});

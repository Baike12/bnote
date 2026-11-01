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

describe("SnippetLoader:装载语义", () => {
  it("用户片段装载后立即生效(findSnippet 当 keystroke 实时读 snippetStore)", async () => {
    const { importer } = fakeImporter();
    const loader = new SnippetLoader(importer);
    const outcome = await loader.load(USER_SRC, true);
    expect(outcome).toEqual({ status: "user", count: 1 });
    expect(expandsUser()).toBe("USER");
    expect(currentUserSnippets()).toBe(USER);
  });

  it("空文件(null)回退内置", async () => {
    const loader = new SnippetLoader(fakeImporter().importer);
    const outcome = await loader.load(null, true);
    expect(outcome.status).toBe("builtin");
    expect(outcome.count).toBe(builtinSnippets.list.length);
    expect(expandsUser()).toBeUndefined();
    expect(currentUserSnippets()).toBeNull();
  });

  it("导入失败回退内置并把错误带给调用方,不留上一次的用户片段", async () => {
    const loader = new SnippetLoader(fakeImporter().importer);
    await loader.load(USER_SRC, true);
    const outcome = await loader.load("broken source", true);
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("无法编译的片段源");
    expect(expandsUser()).toBeUndefined();
    expect(currentUserSnippets()).toBeNull();
  });

  it("导出形状不对是显式错误,不是静默 0 条", () => {
    expect(() => normalizeSnippetExport({ default: { nope: true } })).toThrow(
      /必须 default 导出片段数组/,
    );
    expect(normalizeSnippetExport({ default: USER })).toEqual(USER);
    expect(normalizeSnippetExport(USER)).toEqual(USER);
  });
});

describe("函数型 replacement 过装载链路", () => {
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

  it("仓库文件里的函数被原样带进来,且返回值不过转义层(矩阵行分隔是两个反斜杠)", async () => {
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

describe("SnippetLoader:内容缓存", () => {
  it("同内容不重复导入(仓库事件每次都触发 reload,重编译必须被拦掉)", async () => {
    const { calls, importer } = fakeImporter();
    const loader = new SnippetLoader(importer);
    await loader.load(USER_SRC, true);
    await loader.load(USER_SRC, true);
    expect(calls).toHaveLength(1);
    expect(expandsUser()).toBe("USER");
  });

  it("同内容只翻开关也不重新导入,且开关立即生效", async () => {
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

  it("内容变化重新导入,新片段生效", async () => {
    const { calls, importer } = fakeImporter();
    const loader = new SnippetLoader(importer);
    await loader.load(USER_SRC, true);
    const outcome = await loader.load(USER_SRC_V2, true);
    expect(calls).toHaveLength(2);
    expect(outcome).toEqual({ status: "user", count: 1 });
    expect(expandsUser("xuq2")).toBe("USER2");
  });
});

describe("来源所有权:applySnippetsEnabled 只翻开关不动来源", () => {
  it("设置应用(打开文件/改设置都会走)不清空已装载的用户片段", async () => {
    const loader = new SnippetLoader(fakeImporter().importer);
    await loader.load(USER_SRC, true);
    applySnippetsEnabled(false);
    expect(snippetStore.enabled).toBe(false);
    expect(currentUserSnippets()).toBe(USER);
    applySnippetsEnabled(true);
    expect(expandsUser()).toBe("USER");
  });
});

describe("接线门禁:actions.ts 的设置应用不许再碰来源", () => {
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

  it("applySettingsToEditor 走 applySnippetsEnabled(设置通道),不再出现 reloadSnippets(null,…)", () => {
    expect(actions).not.toBe("");
    expect(actions).toMatch(/applySnippetsEnabled\(settings\.snippets\)/);
    // Resetting the source used to knock the vault snippets back to the
    // built-in ones on every file open — this call shape must never come
    // back.
    expect(actions).not.toMatch(/reloadSnippets\(null/);
  });
});

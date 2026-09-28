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
 * 片段装载门禁：仓库 snippets.js 的装载语义 + 来源所有权不变量。
 * 背景：打包 app 里 blob 动态导入曾被 CSP 拦掉且静默回退（用户改片段毫无
 * 反应），applySettingsToEditor 又会把来源重置回内置——两者都有对应门禁。
 */

const USER: RawSnippet[] = [{ trigger: "uq", replacement: "USER$0", options: "A" }];
const USER_SRC = "export default [{ trigger: 'uq', replacement: 'USER$0', options: 'A' }]";
const USER_SRC_V2 = "export default [{ trigger: 'uq2', replacement: 'USER2$0', options: 'A' }]";

/** 用户片段真的在编辑器侧生效 = findSnippet 把 "uq" 展开成 "USER"。 */
function expandsUser(doc = "xuq"): string | undefined {
  return findSnippet(EditorState.create({ doc }), doc.length, doc.slice(-1), {
    auto: true,
    visualText: null,
  })?.replacement.text;
}

/** 可计数的假导入器：loader.load 的内容缓存必须拦住重复导入。 */
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
  /** 与仓库 .bnote/snippets.js 里那条 iden 同形:返回值直接入档,只解析制表位。 */
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
    // 断言刻意不写反斜杠字面量:数转义层数太容易错,直接用码点比较。
    const BS = String.fromCharCode(92); // 一个反斜杠
    const lines = out.split("\n");
    expect(lines).toHaveLength(4); // \begin / 第一行 / 第二行 / \end
    expect(lines[1].endsWith(BS + BS)).toBe(true); // 行分隔是 LaTeX 的两个反斜杠
    expect([...out].filter((c) => c === BS)).toHaveLength(4); // 1(\begin) + 一处行分隔(2) + 1(\end)

    // 3×3(用户配置里 iden3 的规模):两处行分隔
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
  // ?raw 拿源码文本：接线的正确性在 actions.ts 的运行时依赖里测不到(App 级
  // 依赖图进不了无 DOM 测试)，用文本门禁锁住这个曾经真实翻车的形态。
  const modules = import.meta.glob<string>("../../app/actions.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const actions = modules["../../app/actions.ts"] ?? "";

  it("applySettingsToEditor 走 applySnippetsEnabled(设置通道),不再出现 reloadSnippets(null,…)", () => {
    expect(actions).not.toBe("");
    expect(actions).toMatch(/applySnippetsEnabled\(settings\.snippets\)/);
    // 来源重置曾让每次打开文件都把仓库片段打回内置——这个调用形态必须绝迹
    expect(actions).not.toMatch(/reloadSnippets\(null/);
  });
});

import { describe, expect, it } from "vitest";
import { nextProblemTarget, type ProblemTarget } from "./problems";

/**
 * F8 / ⇧F8 的根因门禁。
 *
 * 旧实现的游标是「当前文件的第 0 条诊断」,不是光标位置:同一文件连按 F8
 * 永远回到第 0 条 → 实际表现是在两个文件之间来回跳。这里把「以光标为游标、
 * 组内按位置排、跨文件绕回」这三条规则钉死。
 */

const at = (path: string, line: number, character = 0): ProblemTarget => ({
  path,
  position: { line, character },
});

const problems = [
  at("a.ts", 5),
  at("a.ts", 1),
  at("a.ts", 9),
  at("b.ts", 2),
  at("b.ts", 7),
  at("c.ts", 4),
];

describe("下一个 / 上一个问题", () => {
  it("没有诊断时不跳", () => {
    expect(nextProblemTarget([], { path: "a.ts", position: { line: 0, character: 0 } }, 1)).toBeNull();
  });

  it("同一文件里按位置向下取,乱序的诊断先排好", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "a.ts", position: { line: 0, character: 0 } },
      1,
    );
    expect(hit).toEqual(at("a.ts", 1));
  });

  it("光标停在某条诊断上时跳过它,去下一条", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "a.ts", position: { line: 5, character: 0 } },
      1,
    );
    expect(hit).toEqual(at("a.ts", 9));
  });

  it("本文件到底了跨到下一个文件的第一条", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "a.ts", position: { line: 9, character: 0 } },
      1,
    );
    expect(hit).toEqual(at("b.ts", 2));
  });

  it("最后一个文件到底了绕回第一个文件(循环)", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "c.ts", position: { line: 9, character: 0 } },
      1,
    );
    expect(hit).toEqual(at("a.ts", 1));
  });

  it("单文件也要能循环:最后一条之后回到第一条", () => {
    const one = [at("a.ts", 1), at("a.ts", 3)];
    const hit = nextProblemTarget(one, { path: "a.ts", position: { line: 9, character: 0 } }, 1);
    expect(hit).toEqual(at("a.ts", 1));
  });

  it("向上镜像:跳到光标之前最近的一条", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "b.ts", position: { line: 5, character: 0 } },
      -1,
    );
    expect(hit).toEqual(at("b.ts", 2));
  });

  it("向上到底:跨到上一个文件的最后一条", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "b.ts", position: { line: 0, character: 0 } },
      -1,
    );
    expect(hit).toEqual(at("a.ts", 9));
  });

  it("当前文件没有诊断:向下从整个列表第一条开始,向上从最后一条开始", () => {
    expect(nextProblemTarget(problems, { path: "z.ts", position: { line: 0, character: 0 } }, 1)).toEqual(
      at("a.ts", 1),
    );
    expect(nextProblemTarget(problems, { path: "z.ts", position: { line: 0, character: 0 } }, -1)).toEqual(
      at("c.ts", 4),
    );
  });

  it("没有光标位置(没有编辑器)时给当前文件的头 / 尾", () => {
    expect(nextProblemTarget(problems, { path: "b.ts", position: null }, 1)).toEqual(at("b.ts", 2));
    expect(nextProblemTarget(problems, { path: "b.ts", position: null }, -1)).toEqual(at("b.ts", 7));
  });

  it("同一行不同列按列比较", () => {
    const cols = [at("a.ts", 3, 0), at("a.ts", 3, 8)];
    const hit = nextProblemTarget(cols, { path: "a.ts", position: { line: 3, character: 4 } }, 1);
    expect(hit).toEqual(at("a.ts", 3, 8));
  });
});

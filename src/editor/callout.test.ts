import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { fenceStateScan } from "./context";
import { scanMath } from "./mathScan";
import { calloutRegions, computeCalloutRegions } from "./callout";

/** 纯行扫描入口:围栏状态与公式区域按同一份文档现算。 */
function scan(text: string) {
  const state = EditorState.create({ doc: text });
  const doc = state.doc;
  return computeCalloutRegions(doc, fenceStateScan(doc), scanMath(doc));
}

const regionOf = (text: string) => {
  const regions = scan(text);
  expect(regions).toHaveLength(1);
  return regions[0];
};

describe("callout 区域扫描", () => {
  it("无标题块:裸 ::: 开合,范围含两行边界", () => {
    const r = regionOf(":::\n内容行\n:::");
    expect(r.openLine).toBe(1);
    expect(r.closeLine).toBe(3);
    expect(r.title).toBe("");
    expect(r.depth).toBe(0);
    expect(r.closed).toBe(true);
    expect(r.from).toBe(0);
    expect(r.to).toBe(":::\n内容行\n:::".length);
  });

  it("带标题:冒号后的文字 trim 成标题", () => {
    const r = regionOf(":::  注意事项  \n内容\n:::");
    expect(r.title).toBe("注意事项");
  });

  it("块外裸 ::: 开无标题块,块内裸 ::: 关最内层", () => {
    const regions = scan(":::\n甲\n:::\n乙\n:::\n丙");
    expect(regions).toHaveLength(2);
    expect(regions[0].openLine).toBe(1);
    expect(regions[0].closeLine).toBe(3);
    expect(regions[1].openLine).toBe(5);
    expect(regions[1].closed).toBe(false); // 最后一个 ::: 开块未闭合
  });

  it("嵌套:带文字的标记必开,裸 ::: 关内层;输出按 from 升序(外层在前)", () => {
    const regions = scan("::: 外\n::: 内\n甲\n:::\n:::");
    expect(regions).toHaveLength(2);
    expect(regions[0].openLine).toBe(1);
    expect(regions[0].closeLine).toBe(5);
    expect(regions[0].depth).toBe(0);
    expect(regions[1].openLine).toBe(2);
    expect(regions[1].closeLine).toBe(4);
    expect(regions[1].depth).toBe(1);
    expect(regions[1].title).toBe("内");
  });

  it("代码围栏内的 ::: 忽略:块不会被围栏里的标记提前关闭", () => {
    const r = regionOf(":::\n```\n:::\n```\n:::");
    expect(r.openLine).toBe(1);
    expect(r.closeLine).toBe(5);
  });

  it("公式块内的 ::: 忽略:$$ 配对优先", () => {
    expect(scan("$$\n:::\n$$")).toHaveLength(0);
    // 公式块之后正文里的 ::: 照常生效
    const r = regionOf("$$\n:::\n$$\n:::\n内容\n:::");
    expect(r.openLine).toBe(4);
  });

  it("未闭合:延伸到文末", () => {
    const r = regionOf(":::\n甲\n乙");
    expect(r.closed).toBe(false);
    expect(r.closeLine).toBe(3);
  });

  it("只认栏 0:缩进的 ::: 不是标记(栏 0 的裸 ::: 另开一块)", () => {
    const r = regionOf("  :::\n甲\n:::");
    expect(r.openLine).toBe(3);
    expect(r.closed).toBe(false);
  });

  it("四个及以上冒号同 :::;行中段的 ::: 不是标记", () => {
    const r = regionOf("::::\n甲\n::::");
    expect(r.openLine).toBe(1);
    expect(r.closeLine).toBe(3);
    expect(scan("文字 ::: 文字")).toHaveLength(0);
  });

  it("标题里的行内公式不影响开块(跳过判定只看 display 区域)", () => {
    const r = regionOf("::: 命题 $P \\Rightarrow Q$\n甲\n:::");
    expect(r.title).toBe("命题 $P \\Rightarrow Q$");
  });

  it("块内公式块照常配对,callout 覆盖完整块", () => {
    const r = regionOf(":::\n$$\nx\n$$\n:::");
    expect(r.openLine).toBe(1);
    expect(r.closeLine).toBe(5);
  });

  it("空行分隔的多个块各自独立", () => {
    const regions = scan("::: 甲\n一\n:::\n\n::: 乙\n二\n:::");
    expect(regions).toHaveLength(2);
    expect(regions[0].title).toBe("甲");
    expect(regions[1].title).toBe("乙");
  });
});

describe("calloutRegions 备忘录", () => {
  it("同一份文档两次调用共享同一数组(装饰热路径零重扫)", () => {
    const state = EditorState.create({ doc: ":::\n甲\n:::" });
    expect(calloutRegions(state)).toBe(calloutRegions(state));
  });
});

import { describe, expect, it } from "vitest";
import { LinkStore, type DailyLink } from "./links";

const link = (patch: Partial<DailyLink>): DailyLink => ({
  id: "l1",
  kind: "copied",
  day: "2026-09-23",
  srcPath: "/vault/proj/a.md",
  dailyPath: "/vault/Daily/2026-09-23.md",
  text: "任务甲",
  srcLine: 3,
  dailyLine: 3,
  ...patch,
});

describe("LinkStore 序列化往返", () => {
  it("upsert → toJSON → fromJSON 保留全部字段", () => {
    const s = new LinkStore();
    s.upsert(link({ id: "l1" }));
    s.upsert(link({ id: "l2", kind: "recorded", text: "任务乙" }));
    const back = LinkStore.fromJSON(s.toJSON());
    expect(back.all().length).toBe(2);
    expect(back.getById("l2")).toMatchObject({ kind: "recorded", text: "任务乙", srcLine: 3 });
  });

  it("null / 损坏 JSON / 错误版本 都得到空库", () => {
    expect(LinkStore.fromJSON(null).all()).toEqual([]);
    expect(LinkStore.fromJSON("{broken").all()).toEqual([]);
    expect(LinkStore.fromJSON(JSON.stringify({ version: 99, links: [] })).all()).toEqual([]);
  });
});

describe("forFile / findByText", () => {
  const s = new LinkStore();
  s.upsert(link({ id: "a" }));
  s.upsert(link({ id: "b", srcPath: "/vault/proj/b.md", text: "任务乙" }));
  s.upsert(link({ id: "c", srcPath: "/vault/proj/c.md", dailyPath: "/vault/Daily/2026-09-22.md", text: "昨天的" }));

  it("forFile 命中源侧或日记侧", () => {
    expect(s.forFile("/vault/proj/a.md").map((l) => l.id)).toEqual(["a"]);
    expect(s.forFile("/vault/Daily/2026-09-23.md").map((l) => l.id).sort()).toEqual(["a", "b"]);
    expect(s.forFile("/vault/none.md")).toEqual([]);
  });

  it("findByText 限文件参与、按行号提示就近", () => {
    expect(s.findByText("/vault/proj/a.md", "任务甲", 10)?.id).toBe("a");
    expect(s.findByText("/vault/Daily/2026-09-23.md", "任务乙", 5)?.id).toBe("b");
    expect(s.findByText("/vault/proj/b.md", "任务甲", 3)).toBe(null); // 文件不参与
    expect(s.findByText("/vault/proj/a.md", "不存在", 3)).toBe(null);
  });

  it("update / remove", () => {
    s.update("a", { srcLine: 9, text: "改名了" });
    expect(s.getById("a")).toMatchObject({ srcLine: 9, text: "改名了" });
    s.remove("a");
    expect(s.getById("a")).toBe(null);
  });
});

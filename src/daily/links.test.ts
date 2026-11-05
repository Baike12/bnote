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

describe("LinkStore serialization round trip", () => {
  it("upsert → toJSON → fromJSON keeps every field", () => {
    const s = new LinkStore();
    s.upsert(link({ id: "l1" }));
    s.upsert(link({ id: "l2", kind: "recorded", text: "任务乙" }));
    const back = LinkStore.fromJSON(s.toJSON());
    expect(back.all().length).toBe(2);
    expect(back.getById("l2")).toMatchObject({ kind: "recorded", text: "任务乙", srcLine: 3 });
  });

  it("null / broken JSON / wrong version all give an empty store", () => {
    expect(LinkStore.fromJSON(null).all()).toEqual([]);
    expect(LinkStore.fromJSON("{broken").all()).toEqual([]);
    expect(LinkStore.fromJSON(JSON.stringify({ version: 99, links: [] })).all()).toEqual([]);
  });
});

describe("forFile / findByText", () => {
  const s = new LinkStore();
  s.upsert(link({ id: "a" }));
  s.upsert(link({ id: "b", srcPath: "/vault/proj/b.md", text: "任务乙" }));
  s.upsert(
    link({
      id: "c",
      srcPath: "/vault/proj/c.md",
      dailyPath: "/vault/Daily/2026-09-22.md",
      text: "昨天的",
    }),
  );

  it("forFile matches on the source side or the daily note side", () => {
    expect(s.forFile("/vault/proj/a.md").map((l) => l.id)).toEqual(["a"]);
    expect(
      s
        .forFile("/vault/Daily/2026-09-23.md")
        .map((l) => l.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(s.forFile("/vault/none.md")).toEqual([]);
  });

  it("findByText restricts to the files that take part and uses the line hint to pick the nearest", () => {
    expect(s.findByText("/vault/proj/a.md", "任务甲", 10)?.id).toBe("a");
    expect(s.findByText("/vault/Daily/2026-09-23.md", "任务乙", 5)?.id).toBe("b");
    expect(s.findByText("/vault/proj/b.md", "任务甲", 3)).toBe(null); // the file does not take part
    expect(s.findByText("/vault/proj/a.md", "不存在", 3)).toBe(null);
  });

  it("update / remove", () => {
    s.update("a", { srcLine: 9, text: "改名了" });
    expect(s.getById("a")).toMatchObject({ srcLine: 9, text: "改名了" });
    s.remove("a");
    expect(s.getById("a")).toBe(null);
  });
});

import { describe, expect, it } from "vitest";
import {
  historyFromTranscript,
  parseTranscript,
  serializeTranscript,
  sessionTitleFromLines,
  type TranscriptLine,
} from "./transcript";

/**
 * 会话记录门禁:行格式、容错解析、以及「记录 → 模型历史」的还原契约。
 * 恢复会话时后端拿到的历史必须与当初一致——用户消息在前、助手回复一次
 * 一轮、出错的一轮不进历史。
 */
describe("transcript 行格式", () => {
  it("序列化 = 一行一条 JSON,解析可往返", () => {
    const lines: TranscriptLine[] = [
      { type: "user", at: 1, text: "你好" },
      {
        type: "assistant",
        at: 2,
        text: "你好!",
        thinking: "思考",
        thinkSeconds: 3,
        tools: [],
      },
    ];
    const raw = serializeTranscript(lines);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(parseTranscript(raw)).toEqual([
      { type: "user", at: 1, text: "你好", images: undefined },
      { type: "assistant", at: 2, text: "你好!", thinking: "思考", thinkSeconds: 3, tools: [], error: undefined },
    ]);
  });

  it("坏行/空文件逐条丢弃,不影响其它条目", () => {
    expect(parseTranscript(null)).toEqual([]);
    expect(parseTranscript("")).toEqual([]);
    const raw = '{"type":"user","at":1,"text":"a"}\nnot json\n{"type":"wat"}\n\n';
    expect(parseTranscript(raw).map((l) => l.type)).toEqual(["user"]);
  });

  it("图片字段必须是 {mediaType,data}", () => {
    const raw = JSON.stringify({
      type: "user",
      at: 1,
      text: "",
      images: [{ mediaType: "image/png", data: "AAA" }, { mediaType: 1 }],
    });
    const [line] = parseTranscript(raw);
    expect(line.type).toBe("user");
    expect(line.type === "user" ? line.images : []).toEqual([
      { mediaType: "image/png", data: "AAA" },
    ]);
  });
});

describe("historyFromTranscript", () => {
  it("用户文本 + 图片按后端的顺序还原", () => {
    const history = historyFromTranscript([
      {
        type: "user",
        at: 1,
        text: "看图",
        images: [{ mediaType: "image/png", data: "AAA" }],
      },
    ]);
    expect(history).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", media_type: "image/png", data: "AAA" },
        ],
      },
    ]);
  });

  it("纯图片消息不塞空文本块", () => {
    const history = historyFromTranscript([
      { type: "user", at: 1, text: "", images: [{ mediaType: "image/jpeg", data: "B" }] },
    ]);
    expect(history[0].content).toEqual([{ type: "image", media_type: "image/jpeg", data: "B" }]);
  });

  it("出错的一轮不还原(后端在 provider 报错前没有 push 助手消息)", () => {
    const history = historyFromTranscript([
      { type: "user", at: 1, text: "问" },
      { type: "assistant", at: 2, text: "", error: "网络错误" },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
  });

  it("多轮对话保持一问一答的顺序", () => {
    const history = historyFromTranscript([
      { type: "user", at: 1, text: "Q1" },
      { type: "assistant", at: 2, text: "A1" },
      { type: "user", at: 3, text: "Q2" },
      { type: "assistant", at: 4, text: "A2" },
    ]);
    expect(history.map((i) => i.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[1].content).toEqual([{ type: "text", text: "A1" }]);
  });

  it("工具调用:tool_use 进助手消息、tool_result 进紧随的 user 消息", () => {
    const history = historyFromTranscript([
      { type: "user", at: 1, text: "读文件" },
      {
        type: "assistant",
        at: 2,
        text: "我看一下",
        tools: [{ id: "t1", name: "read", input: { p: "a" }, output: "内容", ok: true }],
      },
    ]);
    expect(history[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "我看一下" },
        { type: "tool_use", id: "t1", name: "read", input: { p: "a" } },
      ],
    });
    expect(history[2]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "内容", is_error: false }],
    });
  });

  it("中止的工具补一条 is_error 结果,避免 tool_use 落单", () => {
    const history = historyFromTranscript([
      { type: "user", at: 1, text: "q" },
      {
        type: "assistant",
        at: 2,
        text: "",
        tools: [{ id: "t1", name: "x", input: {} }],
      },
    ]);
    expect(history[2]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "已中止", is_error: true }],
    });
  });
});

describe("sessionTitleFromLines", () => {
  it("取第一条非空用户消息并压成单行", () => {
    expect(
      sessionTitleFromLines([
        { type: "assistant", at: 0, text: "先说话" },
        { type: "user", at: 1, text: "  第一行\n第二行  " },
      ]),
    ).toBe("第一行 第二行");
  });

  it("没有用户消息时退回助手首句,再退回占位", () => {
    expect(sessionTitleFromLines([{ type: "assistant", at: 0, text: "回答" }])).toBe("回答");
    expect(sessionTitleFromLines([])).toBe("(空会话)");
  });
});

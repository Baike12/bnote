import { describe, expect, it } from "vitest";
import {
  buildSessionMeta,
  historyFromTranscript,
  parseTranscript,
  serializeTranscript,
  sessionMetaFromRaw,
  sessionTitleFromLines,
  transcriptTitle,
  turnLines,
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

  it("transcriptTitle 空白压平、按字符截断、空串返回空", () => {
    expect(transcriptTitle("  a\n\n b  ")).toBe("a b");
    expect(Array.from(transcriptTitle("字符".repeat(40), 10))).toHaveLength(10);
    expect(transcriptTitle("   ")).toBe("");
  });
});

describe("会话元数据行(标题 + 模型配置快照)", () => {
  const model = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.example.com",
    maxTokens: 8192,
    contextWindow: 200_000,
  };

  it("元数据行不参与对话解析与模型历史还原", () => {
    const raw = serializeTranscript([
      buildSessionMeta({ at: 1, title: "会话标题", model }),
      { type: "user", at: 2, text: "问题" },
      { type: "assistant", at: 3, text: "回答" },
    ]);
    const lines = parseTranscript(raw);
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant"]);
    expect(historyFromTranscript(lines).map((i) => i.role)).toEqual(["user", "assistant"]);
  });

  it("从原文取回标题与模型快照(恢复时会话按自己的配置继续)", () => {
    const raw = serializeTranscript([
      buildSessionMeta({ at: 1, title: "会话标题", model }),
      { type: "user", at: 2, text: "问题" },
    ]);
    expect(sessionMetaFromRaw(raw)).toEqual({
      type: "meta",
      at: 1,
      title: "会话标题",
      model,
    });
  });

  it("坏行/缺字段/没有 meta 时容错:返回 null 或丢弃不合法的模型配置", () => {
    expect(sessionMetaFromRaw(null)).toBeNull();
    expect(sessionMetaFromRaw('{"type":"user","at":1,"text":"a"}\n')).toBeNull();
    const raw = '{"type":"meta","at":1,"title":"  ","model":{"provider":"x"}}\n';
    expect(sessionMetaFromRaw(raw)).toEqual({
      type: "meta",
      at: 1,
      title: undefined,
      model: undefined,
    });
  });

  it("序列化保持一行一条:meta 永远是第一行且不夹带换行", () => {
    const raw = serializeTranscript([
      buildSessionMeta({ at: 1, title: "多行\n标题", model }),
      { type: "user", at: 2, text: "q" },
    ]);
    const first = raw.split("\n")[0];
    expect(JSON.parse(first).type).toBe("meta");
    expect(JSON.parse(first).title).toBe("多行\n标题");
  });

  it("turnLines:第一轮带 meta(标题=首条用户消息,含模型快照),之后不再重复", () => {
    const assistant = { type: "assistant" as const, at: 3, text: "回答" };
    const first = turnLines({
      user: { type: "user", at: 2, text: " 第一句话 \n 继续 " },
      assistant,
      first: true,
      model,
    });
    expect(first).toHaveLength(3);
    expect(first[0]).toEqual({
      type: "meta",
      at: 2,
      title: "第一句话 继续",
      model,
    });

    const later = turnLines({ user: null, assistant, first: false, model });
    expect(later).toEqual([assistant]);
  });

  it("turnLines:纯图片首条消息退到助手首句当标题", () => {
    const [meta] = turnLines({
      user: { type: "user", at: 2, text: "", images: [{ mediaType: "image/png", data: "A" }] },
      assistant: { type: "assistant", at: 3, text: "图中是矩阵乘法" },
      first: true,
      model: null,
    });
    expect(meta).toEqual({ type: "meta", at: 2, title: "图中是矩阵乘法" });
  });
});

import { describe, expect, it } from "vitest";
import {
  assistantRoundLine,
  buildSessionMeta,
  historyFromTranscript,
  parseTranscript,
  serializeTranscript,
  sessionMetaFromRaw,
  sessionTitleFromLines,
  transcriptTitle,
  userWriteLines,
  type TranscriptLine,
} from "./transcript";

/**
 * Gate for the session transcript: the line format, the fault-tolerant
 * parsing, and the "record -> model history" rebuild contract.
 * The history the backend gets when restoring a session must match what it
 * was originally — user messages first, one assistant reply per turn, and a
 * turn that errored never enters the history.
 */
describe("the transcript line format", () => {
  it("serialization = one JSON per line, parsing round-trips", () => {
    const lines: TranscriptLine[] = [
      { type: "user", at: 1, text: "你好" },
      {
        type: "assistant",
        at: 2,
        text: "你好!",
        thinking: "思考",
        thinkSeconds: 3,
        turnMs: 4500,
        tools: [],
      },
    ];
    const raw = serializeTranscript(lines);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(parseTranscript(raw)).toEqual([
      { type: "user", at: 1, text: "你好", images: undefined },
      {
        type: "assistant",
        at: 2,
        text: "你好!",
        thinking: "思考",
        thinkSeconds: 3,
        turnMs: 4500,
        tools: [],
        error: undefined,
      },
    ]);
  });

  it("bad lines and empty files are dropped one by one, the other entries are unaffected", () => {
    expect(parseTranscript(null)).toEqual([]);
    expect(parseTranscript("")).toEqual([]);
    const raw = '{"type":"user","at":1,"text":"a"}\nnot json\n{"type":"wat"}\n\n';
    expect(parseTranscript(raw).map((l) => l.type)).toEqual(["user"]);
  });

  it("the image field must be {mediaType,data}", () => {
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
  it("user text + images are restored in the backend order", () => {
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

  it("an image-only message gets no empty text block", () => {
    const history = historyFromTranscript([
      { type: "user", at: 1, text: "", images: [{ mediaType: "image/jpeg", data: "B" }] },
    ]);
    expect(history[0].content).toEqual([{ type: "image", media_type: "image/jpeg", data: "B" }]);
  });

  it("a turn that errored is not restored (the backend pushes no assistant message before the provider fails)", () => {
    const history = historyFromTranscript([
      { type: "user", at: 1, text: "问" },
      { type: "assistant", at: 2, text: "", error: "网络错误" },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
  });

  it("a multi-turn conversation keeps the one-question-one-answer order", () => {
    const history = historyFromTranscript([
      { type: "user", at: 1, text: "Q1" },
      { type: "assistant", at: 2, text: "A1" },
      { type: "user", at: 3, text: "Q2" },
      { type: "assistant", at: 4, text: "A2" },
    ]);
    expect(history.map((i) => i.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[1].content).toEqual([{ type: "text", text: "A1" }]);
  });

  it("tool calls: tool_use goes into the assistant message, tool_result into the immediately following user message", () => {
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

  it("an aborted tool gets an is_error result so that no tool_use is left unpaired", () => {
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
  it("it takes the first non-empty user message and squeezes it into a single line", () => {
    expect(
      sessionTitleFromLines([
        { type: "assistant", at: 0, text: "先说话" },
        { type: "user", at: 1, text: "  第一行\n第二行  " },
      ]),
    ).toBe("第一行 第二行");
  });

  it("without a user message it falls back to the first assistant sentence, then to the placeholder", () => {
    expect(sessionTitleFromLines([{ type: "assistant", at: 0, text: "回答" }])).toBe("回答");
    expect(sessionTitleFromLines([])).toBe("(空会话)");
  });

  it("transcriptTitle flattens the whitespace, truncates by character and returns an empty string for empty input", () => {
    expect(transcriptTitle("  a\n\n b  ")).toBe("a b");
    expect(Array.from(transcriptTitle("字符".repeat(40), 10))).toHaveLength(10);
    expect(transcriptTitle("   ")).toBe("");
  });
});

describe("the session metadata line (title + model config snapshot)", () => {
  const model = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.example.com",
    maxTokens: 8192,
    contextWindow: 200_000,
  };

  it("the metadata line takes part in neither the conversation parsing nor the model history rebuild", () => {
    const raw = serializeTranscript([
      buildSessionMeta({ at: 1, title: "会话标题", model }),
      { type: "user", at: 2, text: "问题" },
      { type: "assistant", at: 3, text: "回答" },
    ]);
    const lines = parseTranscript(raw);
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant"]);
    expect(historyFromTranscript(lines).map((i) => i.role)).toEqual(["user", "assistant"]);
  });

  it("the title and the model snapshot are read back from the raw text (a restored session continues with its own config)", () => {
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

  it("it is fault tolerant for a bad line, missing fields or no meta: it returns null or drops the invalid model config", () => {
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

  it("the serialization keeps one entry per line: meta is always the first line and carries no newline", () => {
    const raw = serializeTranscript([
      buildSessionMeta({ at: 1, title: "多行\n标题", model }),
      { type: "user", at: 2, text: "q" },
    ]);
    const first = raw.split("\n")[0];
    expect(JSON.parse(first).type).toBe("meta");
    expect(JSON.parse(first).title).toBe("多行\n标题");
  });

  it("userWriteLines: the first write carries meta (title = the user message, including the model snapshot), it is not repeated afterwards", () => {
    const first = userWriteLines({
      user: { type: "user", at: 2, text: " 第一句话 \n 继续 " },
      first: true,
      model,
    });
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual({
      type: "meta",
      at: 2,
      title: "第一句话 继续",
      model,
    });
    expect(first[1]).toEqual({ type: "user", at: 2, text: " 第一句话 \n 继续 " });

    const later = userWriteLines({
      user: { type: "user", at: 9, text: "第二条" },
      first: false,
      model,
    });
    expect(later).toEqual([{ type: "user", at: 9, text: "第二条" }]);
  });

  it("assistantRoundLine: carries thinking + signature + tools, omits empty optionals, and round-trips through parse", () => {
    const line = assistantRoundLine({
      at: 7,
      text: "我来查一下。",
      thinking: "先想一下",
      thinkingSignature: "sig1",
      tools: [{ id: "t1", name: "Read", input: { path: "a.ts" }, output: "ok", ok: true }],
      turnMs: 1200,
    });
    expect(line.thinkingSignature).toBe("sig1");
    expect(line.turnMs).toBe(1200);
    const raw = serializeTranscript([line]);
    const parsed = parseTranscript(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe("assistant");
    expect(parsed[0].text).toBe("我来查一下。");
    if (parsed[0].type === "assistant") {
      expect(parsed[0].thinking).toBe("先想一下");
      expect(parsed[0].thinkingSignature).toBe("sig1");
      expect(parsed[0].tools).toEqual(line.tools);
      expect(parsed[0].turnMs).toBe(1200);
    }

    const minimal = assistantRoundLine({ at: 8, text: "完毕", tools: [] });
    expect(minimal.thinking).toBeUndefined();
    expect(minimal.thinkingSignature).toBeUndefined();
    expect(minimal.turnMs).toBeUndefined();
    expect(minimal.error).toBeUndefined();
  });

  it("the meta of an auxiliary session carries the parent session file id, the source summary and the prefix count", () => {
    const meta = buildSessionMeta({
      at: 5,
      title: "↳ 父会话的提问",
      model,
      parent: "s1700000000000-0",
      basedOn: "父会话的提问",
      forkAt: 4,
    });
    expect(meta).toEqual({
      type: "meta",
      at: 5,
      title: "↳ 父会话的提问",
      model,
      parent: "s1700000000000-0",
      basedOn: "父会话的提问",
      forkAt: 4,
    });
    // Write to disk and read back: the parent/child relation is the only source for the restart restore and must round-trip unchanged.
    const raw = serializeTranscript([meta, { type: "user", at: 6, text: "子会话的问题" }]);
    expect(sessionMetaFromRaw(raw)).toEqual(meta);
  });

  it("the meta of the main session carries no parent/child fields (the default means the main session)", () => {
    const meta = buildSessionMeta({ at: 1, title: "主会话", model });
    expect(meta.parent).toBeUndefined();
    expect(meta.basedOn).toBeUndefined();
    expect(meta.forkAt).toBeUndefined();
  });

  it("the title source marker round-trips: a session whose title was generated by the LLM is not generated again on restore", () => {
    const raw =
      '{"type":"meta","at":1,"title":"特征值","titleSource":"llm"}\n' +
      '{"type":"user","at":2,"text":"q"}\n';
    expect(sessionMetaFromRaw(raw)?.titleSource).toBe("llm");
    // A dirty value (hand edit / a future version) is treated as "not generated" and never as llm.
    const dirty = '{"type":"meta","at":1,"title":"x","titleSource":"model-v2"}\n';
    expect(sessionMetaFromRaw(dirty)?.titleSource).toBeUndefined();
  });

  it("a bad forkAt (negative/fractional/string) is dropped and does not affect the restore", () => {
    expect(sessionMetaFromRaw('{"type":"meta","at":1,"forkAt":-2}\n')?.forkAt).toBeUndefined();
    expect(sessionMetaFromRaw('{"type":"meta","at":1,"forkAt":1.5}\n')?.forkAt).toBeUndefined();
    expect(sessionMetaFromRaw('{"type":"meta","at":1,"forkAt":"3"}\n')?.forkAt).toBeUndefined();
    expect(sessionMetaFromRaw('{"type":"meta","at":1,"forkAt":0}\n')?.forkAt).toBe(0);
  });
});

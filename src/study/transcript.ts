import type { AgentChatItem, AgentContentBlock, SessionModelConfig } from "@/lib/tauri";
import type { AgentImage } from "./agentImages";

export type { SessionModelConfig } from "@/lib/tauri";

/**
 * Agent 会话记录:一份会话一个 JSONL 文件(照 Claude Code 的 transcript
 * 形状:`<会话>.jsonl` 一行一条消息),落在材料的 `sessions/` 目录下。
 *
 * 每一行要么是一条用户消息,要么是**一整轮**助手回复(文本 + 思考 + 工具
 * 调用 + 错误),所以一轮只追加一次、不随流式增量重写文件。整个文件的
 * 第一行是元数据行(标题 + 模型配置快照,见 `TranscriptMetaLine`)。用
 * `at` 记时间戳;会话标题从元数据行取,排序由 mtime 推出,不需要额外索引。
 *
 * 行结构是「展示用」的,模型侧历史由 `historyFromTranscript` 还原。学习
 * 助手不注册工具(纯问答,见后端 session.rs 的 tool_defs),因此这里的
 * 还原与后端真实历史一致;将来恢复工具时再引入逐轮的 tool 分组。
 */
export interface StoredTool {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
}

export interface TranscriptUserLine {
  type: "user";
  at: number;
  text: string;
  images?: AgentImage[];
}

export interface TranscriptAssistantLine {
  type: "assistant";
  at: number;
  text: string;
  thinking?: string;
  thinkSeconds?: number | null;
  tools?: StoredTool[];
  error?: string;
}

export type TranscriptLine = TranscriptUserLine | TranscriptAssistantLine;

/**
 * 会话级元数据(模型配置快照 + 标题),作为记录文件的**第一行**。
 *
 * 会话一旦开始就用当时保存的模型配置跑到底:之后改了设置(哪怕只改上下文
 * 长度),这条会话恢复时仍按自己的快照继续,不会被新配置悄悄换掉模型。
 *
 * 单独成行还有第二个作用:首条用户消息可能带着几 MB 的 base64 截图,列表
 * 侧只读文件头部一小段;元数据行很小,永远能完整读到,标题不再依赖那条
 * 巨型消息行。
 */
export interface TranscriptMetaLine {
  type: "meta";
  at: number;
  /** 首条用户消息(单行、截断);没有就留空,由展示侧兜底。 */
  title?: string;
  model?: SessionModelConfig;
  /**
   * 分叉来源会话的记录文件 id(主会话没有这一项)。重启恢复靠它把辅助
   * 会话挂回主会话——只存内存里的 convKey 活不过一次重启。
   */
  parent?: string;
  /** 辅助会话的来源消息摘要(头部辅助条与切换列表的第二行)。 */
  basedOn?: string;
  /**
   * 分叉时复制过来的前缀条数:`entries[forkAt]` 才是这条会话自己的第一条
   * 消息(生成自己的标题时要从这里起算,不能拿父会话的提问顶替)。
   */
  forkAt?: number;
  /** 标题来源:llm = 模型生成过;缺省按首条消息截断(旧记录同此)。 */
  titleSource?: "llm" | "first-message";
}

/** 会话记录里可能出现的一行(元数据行不参与对话还原)。 */
export type TranscriptRecord = TranscriptLine | TranscriptMetaLine;

function isImage(value: unknown): value is AgentImage {
  if (!value || typeof value !== "object") return false;
  const img = value as Partial<AgentImage>;
  return typeof img.mediaType === "string" && typeof img.data === "string";
}

function tools(value: unknown): StoredTool[] {
  if (!Array.isArray(value)) return [];
  const out: StoredTool[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const t = item as Partial<StoredTool>;
    if (typeof t.id !== "string" || typeof t.name !== "string") continue;
    out.push({
      id: t.id,
      name: t.name,
      input: t.input,
      output: typeof t.output === "string" ? t.output : undefined,
      ok: typeof t.ok === "boolean" ? t.ok : undefined,
    });
  }
  return out;
}

/** 一行 JSON + 换行;调用方按批传给 `appendFile`,一次追加多行也安全。 */
export function serializeTranscript(lines: TranscriptRecord[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length > 0 ? "\n" : "");
}

function isModelConfig(value: unknown): value is SessionModelConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SessionModelConfig>;
  return (
    typeof v.provider === "string" &&
    typeof v.model === "string" &&
    typeof v.baseUrl === "string" &&
    typeof v.maxTokens === "number" &&
    typeof v.contextWindow === "number"
  );
}

/**
 * 从记录原文里取会话元数据(第一处 meta 行)。
 *
 * meta 行是会话创建时写下的,故意放在最前面:它很小,列表侧只读文件头也
 * 能完整拿到;标题与模型配置都不依赖后面那条可能带大图的用户消息。
 */
export function sessionMetaFromRaw(raw: string | null): TranscriptMetaLine | null {
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const v = parsed as Record<string, unknown>;
    if (v.type !== "meta") continue;
    return {
      type: "meta",
      at: typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0,
      title: typeof v.title === "string" && v.title.trim() ? v.title : undefined,
      model: isModelConfig(v.model) ? v.model : undefined,
      parent: typeof v.parent === "string" && v.parent ? v.parent : undefined,
      basedOn: typeof v.basedOn === "string" && v.basedOn ? v.basedOn : undefined,
      forkAt:
        typeof v.forkAt === "number" && Number.isInteger(v.forkAt) && v.forkAt >= 0
          ? v.forkAt
          : undefined,
      titleSource:
        v.titleSource === "llm" || v.titleSource === "first-message"
          ? v.titleSource
          : undefined,
    };
  }
  return null;
}

/** meta 行:标题取首条用户消息(与列表侧同一规则),模型配置由调用方给。 */
export function buildSessionMeta(input: {
  at: number;
  title: string;
  model: SessionModelConfig | null;
  /** 分叉:来源会话的文件 id(主会话不传)。 */
  parent?: string | null;
  basedOn?: string;
  forkAt?: number;
}): TranscriptMetaLine {
  const meta: TranscriptMetaLine = { type: "meta", at: input.at, title: input.title };
  if (input.model) meta.model = input.model;
  if (input.parent) meta.parent = input.parent;
  if (input.basedOn) meta.basedOn = input.basedOn;
  if (input.forkAt) meta.forkAt = input.forkAt;
  return meta;
}

/**
 * 一轮落盘要追加的行。
 *
 * 第一轮(会话的第一次写盘)最前面插元数据行:标题 + 模型配置快照。它必须
 * 在文件第一行——列表侧只读文件头部;**首条用户消息可能带着几 MB 的
 * base64 截图,整行远超头部窗口**,标题不能依赖那一行还能被完整解析。
 * 模型快照也靠它:之后改设置,这条会话恢复时仍按自己的配置继续。
 */
export function turnLines(input: {
  /** 这一轮的用户消息;发送失败时它根本没进来,传 null。 */
  user: TranscriptUserLine | null;
  assistant: TranscriptAssistantLine;
  /** 是否第一轮(还没写过元数据行)。 */
  first: boolean;
  model: SessionModelConfig | null;
}): TranscriptRecord[] {
  const lines: TranscriptLine[] = [];
  if (input.user) lines.push(input.user);
  lines.push(input.assistant);
  if (!input.first) return lines;
  const title = input.user?.text.trim()
    ? transcriptTitle(input.user.text)
    : transcriptTitle(input.assistant.text);
  const meta = buildSessionMeta({
    at: input.user?.at ?? input.assistant.at,
    title,
    model: input.model,
  });
  return [meta, ...lines];
}

/** 容错解析:坏行逐条丢弃(手工编辑/写盘中断都不该让整段历史打不开)。 */
export function parseTranscript(raw: string | null): TranscriptLine[] {
  if (!raw) return [];
  const out: TranscriptLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const v = parsed as Record<string, unknown>;
    const at = typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0;
    if (v.type === "user") {
      out.push({
        type: "user",
        at,
        text: typeof v.text === "string" ? v.text : "",
        images: Array.isArray(v.images) ? v.images.filter(isImage) : undefined,
      });
    } else if (v.type === "assistant") {
      out.push({
        type: "assistant",
        at,
        text: typeof v.text === "string" ? v.text : "",
        thinking: typeof v.thinking === "string" ? v.thinking : "",
        thinkSeconds:
          typeof v.thinkSeconds === "number" && Number.isFinite(v.thinkSeconds)
            ? v.thinkSeconds
            : null,
        tools: tools(v.tools),
        error: typeof v.error === "string" && v.error ? v.error : undefined,
      });
    }
  }
  return out;
}

/**
 * 展示用记录 → 模型侧历史。
 *
 * - 用户行:文本 + 图片,与后端 `ChatItem::user_message` 同序。
 * - 助手行:文本 + 每个工具调用的 `tool_use`;工具的 `tool_result` 按后端
 *   run_loop 的写法放进紧随其后的一条 user 消息。
 * - 出错的一轮:后端在 provider 返回错误前不会 push 助手消息,所以不还原
 *   (否则模型会看到一条根本不存在于历史的半截回复)。
 */
export function historyFromTranscript(lines: TranscriptLine[]): AgentChatItem[] {
  const out: AgentChatItem[] = [];
  for (const line of lines) {
    if (line.type === "user") {
      const content: AgentContentBlock[] = [];
      if (line.text) content.push({ type: "text", text: line.text });
      for (const img of line.images ?? []) {
        content.push({ type: "image", media_type: img.mediaType, data: img.data });
      }
      if (content.length > 0) out.push({ type: "message", role: "user", content });
      continue;
    }
    if (line.error) continue;
    const content: AgentContentBlock[] = [];
    if (line.text) content.push({ type: "text", text: line.text });
    for (const tool of line.tools ?? []) {
      content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input ?? {} });
    }
    if (content.length > 0) out.push({ type: "message", role: "assistant", content });
    const results: AgentContentBlock[] = (line.tools ?? []).map((tool) => ({
      type: "tool_result",
      tool_use_id: tool.id,
      content: tool.output ?? "已中止",
      is_error: tool.ok !== true,
    }));
    if (results.length > 0) out.push({ type: "message", role: "user", content: results });
  }
  return out;
}

/** 标题规则:空白压成单行、按字符截断;空文本返回空串(调用方决定兜底)。 */
export function transcriptTitle(text: string, limit = 60): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact ? Array.from(compact).slice(0, limit).join("") : "";
}

/** 会话标题:第一条非空用户消息,单行、截断;没有就问号兜底。 */
export function sessionTitleFromLines(lines: TranscriptLine[], limit = 60): string {
  for (const line of lines) {
    if (line.type !== "user") continue;
    const text = transcriptTitle(line.text, limit);
    if (text) return text;
  }
  const first = lines.find((l) => l.type === "assistant" && l.text.trim());
  if (first && first.type === "assistant") {
    return transcriptTitle(first.text, limit);
  }
  return "(空会话)";
}

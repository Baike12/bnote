import type { AgentChatItem, AgentContentBlock } from "@/lib/tauri";
import type { AgentImage } from "./agentImages";

/**
 * Agent 会话记录:一份会话一个 JSONL 文件(照 Claude Code 的 transcript
 * 形状:`<会话>.jsonl` 一行一条消息),落在材料的 `sessions/` 目录下。
 *
 * 每一行要么是一条用户消息,要么是**一整轮**助手回复(文本 + 思考 + 工具
 * 调用 + 错误),所以一轮只追加一次、不随流式增量重写文件。用 `at` 记
 * 时间戳;会话标题/排序由文件首行与 mtime 推出,不需要额外索引。
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
export function serializeTranscript(lines: TranscriptLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length > 0 ? "\n" : "");
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

/** 会话标题:第一条非空用户消息,单行、截断;没有就问号兜底。 */
export function sessionTitleFromLines(lines: TranscriptLine[], limit = 60): string {
  for (const line of lines) {
    if (line.type !== "user") continue;
    const text = line.text.replace(/\s+/g, " ").trim();
    if (text) return Array.from(text).slice(0, limit).join("");
  }
  const first = lines.find((l) => l.type === "assistant" && l.text.trim());
  if (first && first.type === "assistant") {
    return Array.from(first.text.replace(/\s+/g, " ").trim()).slice(0, limit).join("");
  }
  return "(空会话)";
}

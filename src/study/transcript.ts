import type { AgentChatItem, AgentContentBlock, SessionModelConfig } from "@/lib/tauri";
import type { AgentImage } from "./agentImages";

export type { SessionModelConfig } from "@/lib/tauri";

/**
 * Agent session transcripts: one JSONL file per session (following Claude
 * Code's transcript shape: `<session>.jsonl` with one message per line),
 * stored in the material's `sessions/` directory.
 *
 * Each line is either one user message or a **whole turn** of the assistant's
 * reply (text + thinking + tool calls + error), so a turn is appended once and
 * the file is never rewritten while the stream is still coming in. The first
 * line of the file is the metadata line (title + model config snapshot, see
 * `TranscriptMetaLine`). Timestamps use `at`; the session title comes from the
 * metadata line and the ordering is derived from the mtime, so no extra index
 * is needed.
 *
 * The line structure is for display; the model-side history is rebuilt by
 * `historyFromTranscript`. The study assistant registers no tools (plain
 * Q&A, see the backend's session.rs tool_defs), so the rebuild matches the
 * real backend history; per-turn tool grouping only comes back if tools are
 * restored later.
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
 * Session-level metadata (model config snapshot + title), stored as the
 * **first line** of the transcript file.
 *
 * Once a session has started it runs to the end with the model config that
 * was saved at that moment: changing a setting later (even just the context
 * length) does not swap the model out from under it — on restore the session
 * continues with its own snapshot.
 *
 * Being a line of its own has a second purpose: the first user message may
 * carry several MB of base64 screenshots and the list side only reads a small
 * window at the head of the file; the metadata line is tiny and always read
 * completely, so the title no longer depends on that huge message line.
 */
export interface TranscriptMetaLine {
  type: "meta";
  at: number;
  /** The first user message (single line, truncated); empty when there is none, the display side falls back. */
  title?: string;
  model?: SessionModelConfig;
  /**
   * The transcript file id of the session this one was forked from (the main
   * session has no such field). The restart restore relies on it to hang the
   * auxiliary session back under the main one — a convKey kept only in memory
   * does not survive a restart.
   */
  parent?: string;
  /** A summary of the source message of an auxiliary session (the auxiliary bar in the header and the second line of the switcher list). */
  basedOn?: string;
  /**
   * The number of entries copied over when forking: `entries[forkAt]` is the
   * first message this session owns (generating its own title has to start
   * there, the parent's question must not stand in for it).
   */
  forkAt?: number;
  /** Where the title comes from: llm = the model generated one; by default the first message, truncated (old records do the same). */
  titleSource?: "llm" | "first-message";
}

/** A line that can appear in a session transcript (the metadata line does not take part in the conversation rebuild). */
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

/** One line of JSON plus a newline; the caller passes them in batches to `appendFile`, appending several lines at once is safe. */
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
 * Read the session metadata out of the raw transcript (the first meta line).
 *
 * The meta line is written when the session is created and deliberately sits
 * first: it is small, so the list side gets it completely even though it only
 * reads the head of the file; neither the title nor the model config depends
 * on the later user message that may carry a large image.
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

/** meta line: the title comes from the first user message (the same rule as the list side), the model config is given by the caller. */
export function buildSessionMeta(input: {
  at: number;
  title: string;
  model: SessionModelConfig | null;
  /** Fork: the file id of the source session (not passed for the main session). */
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
 * The lines a turn appends to the transcript.
 *
 * The first turn (the session's first write) puts the metadata line in front:
 * title + model config snapshot. It has to be the first line of the file —
 * the list side only reads the head of the file, and **the first user message
 * may carry several MB of base64 screenshots, so the whole line is far beyond
 * the head window**; the title cannot depend on that line still parsing
 * completely. The model snapshot relies on it too: after a setting change the
 * session still continues with its own config on restore.
 */
export function turnLines(input: {
  /** The user message of this turn; it never arrived when sending failed, pass null then. */
  user: TranscriptUserLine | null;
  assistant: TranscriptAssistantLine;
  /** Whether this is the first turn (no metadata line written yet). */
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

/** Fault-tolerant parsing: bad lines are dropped one by one (a manual edit or an interrupted write must not make the whole history unopenable). */
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
 * Display-oriented records -> the model-side history.
 *
 * - User line: text + images, in the same order as the backend's
 *   `ChatItem::user_message`.
 * - Assistant line: text plus a `tool_use` per tool call; the tools'
 *   `tool_result` goes into a user message right after, the way the backend's
 *   run_loop writes it.
 * - A turn that errored: the backend pushes no assistant message before the
 *   provider returns an error, so nothing is rebuilt here (otherwise the
 *   model would see a half reply that never existed in the history).
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

/** Title rule: collapse whitespace into a single line, truncate by character; empty text returns an empty string (the caller decides the fallback). */
export function transcriptTitle(text: string, limit = 60): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact ? Array.from(compact).slice(0, limit).join("") : "";
}

/** Session title: the first non-empty user message, single line and truncated; a question mark is the fallback. */
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

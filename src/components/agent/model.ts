/**
 * The panel's in-memory session model.
 *
 * These are the shapes the panel renders and the pure conversions between
 * them and the transcript lines on disk. They live outside the panel so the
 * restore/fork logic can be read (and tested) without the component tree.
 */

import type {
  AgentImage,
  AgentTodoItem,
  SavedSessionMeta,
  SessionModelConfig,
  StudyContent,
} from "@/lib/tauri";
import type { SessionNode } from "@/study/sessionTree";
import type { TranscriptLine } from "@/study/transcript";
import type { AgentUsage } from "@/study/agentUsage";

export interface ToolRecord {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  /** The screenshots the tool returns to the model with the result (a rendered preview for instance); they are only displayed. */
  images?: AgentImage[];
}

export interface Turn {
  /** Streaming text buffer for the current assistant reply. */
  text: string;
  /** The streamed thinking process (plain text; it does not enter the session history, it is only displayed). */
  thinking: string;
  /** Timestamp of the first thinking delta (used for the timer). */
  thinkingStart: number | null;
  /** How long the thinking took (in seconds, computed and frozen when the turn ends). */
  thinkSeconds: number | null;
  /** When the first event of the turn arrived (the "已工作 N 秒" duration starts here). */
  startedAt: number | null;
  /** The wall-clock duration of the whole turn, frozen when it ends. */
  turnMs: number | null;
  tools: ToolRecord[];
  error?: string;
}

export interface ChatEntry {
  role: "user" | "assistant" | "notice";
  text: string;
  /** The timestamp written into the session record. */
  at: number;
  /** The screenshots and images attached to a user message (display only; on the model side the backend session history is the truth). */
  images?: AgentImage[];
  turn?: Turn;
  /**
   * The number of entries of the backend session history "up to and including
   * this one". user = the previous one + 1; assistant = the authoritative
   * count the backend reports with the turn_end / error events (see
   * agentFork.ts). null = still unknown (it errored and no count could be
   * obtained).
   */
  items: number | null;
}

/** One session inside the panel: the main session, or an auxiliary session forked from some message. */
export interface Conv {
  key: string;
  sessionId: string | null;
  entries: ChatEntry[];
  label: string;
  /** The session this one was forked from; null for the main session. */
  parent: string | null;
  /** The summary of an auxiliary session (the first line of the source message). */
  basedOn: string;
  /**
   * The number of copied prefix entries at the time of the fork:
   * `entries[forkAt]` is the first message that belongs to this session
   * itself. The title has to use it, the question of the parent session
   * must not stand in for it.
   */
  forkAt: number;
  /** Where the title comes from: llm = the model generated it (it is not generated again after a restart). */
  titleSource: "llm" | "first-message";
  /**
   * A session level error (start failed / send failed). It is displayed
   * persistently at the top of the conversation (following ZCode's
   * ChatErrorBanner) until the user retries or closes it, instead of only a
   * toast that disappears after a few seconds: most of the "sending got no
   * answer" cases the user sees are exactly such failures swallowed by a
   * toast.
   */
  error?: string;
  /** Where the error came from, it decides what the "retry" button does. */
  errorKind?: "start" | "send";
  /** The todo tool's latest list (rendered above the composer; transient). */
  todos: AgentTodoItem[];
  /** The MCP connection failures the backend reported at startup (an empty array = everything is fine). */
  mcpErrors: string[];
  /**
   * The session record file (`<material dir>/sessions/<id>.jsonl`). null =
   * there is no id yet (just started / the start failed) or the browser
   * cannot write to disk.
   */
  transcriptPath: string | null;
  /** The session id in the file name (the history drawer highlights the current entry with it). */
  sessionFileId: string | null;
  /** The transcript lives in the agent home (`~/.bnote`) instead of the vault (coding sessions). */
  transcriptHome?: boolean;
  /** The model config snapshot of this session at the moment it started: later setting changes do not affect it, and the restore continues with it. */
  model: SessionModelConfig | null;
  /** The token usage of the last model request (the context usage = input + output). */
  usage: AgentUsage | null;
}

/** Identity of the material a session is pinned to (url re-open = same key). */
export function studyContentKey(content: StudyContent | null): string {
  if (!content) return "none";
  if (content.kind === "pdf") return `pdf:${content.path}`;
  return `url:${content.url}`;
}

/** A list entry turned into the node used to resolve the family (missing fields mean the main session / an empty prefix). */
export function toSessionNode(meta: SavedSessionMeta): SessionNode {
  return {
    id: meta.id,
    title: meta.title,
    parent: meta.parent ?? null,
    basedOn: meta.basedOn ?? "",
    forkAt: meta.forkAt ?? 0,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

export function findConvBySession(convs: Conv[], sessionId: string): Conv | undefined {
  return convs.find((c) => c.sessionId === sessionId);
}

let convSeq = 0;
export function nextConvKey(): string {
  convSeq += 1;
  return `c${convSeq}`;
}

/** A session record line turned into a UI message (used when a session is restored). */
export function entryFromLine(line: TranscriptLine): ChatEntry {
  if (line.type === "user") {
    return {
      role: "user",
      text: line.text,
      at: line.at,
      items: null,
      images: line.images,
    };
  }
  return {
    role: "assistant",
    text: line.text,
    at: line.at,
    items: null,
    turn: {
      text: line.text,
      thinking: line.thinking ?? "",
      thinkingStart: null,
      thinkSeconds: line.thinkSeconds ?? null,
      startedAt: null,
      turnMs: line.turnMs ?? null,
      tools: line.tools ?? [],
      error: line.error,
    },
  };
}

/** A UI message turned into a session record line (when forking, the prefix of the parent session is written into the new file). */
export function entriesToLines(entries: ChatEntry[]): TranscriptLine[] {
  // Notice entries are display-only status lines, never transcript content.
  return entries
    .filter((e) => e.role !== "notice")
    .map((e): TranscriptLine =>
      e.role === "user"
        ? { type: "user", at: e.at, text: e.text, images: e.images }
        : {
            type: "assistant",
            at: e.at,
            text: e.text,
            thinking: e.turn?.thinking ?? "",
            thinkSeconds: e.turn?.thinkSeconds ?? null,
            // The key only exists when a real duration was measured: an absent
            // field keeps the line format lean (the same rule as `images`).
            ...(e.turn?.turnMs != null ? { turnMs: e.turn.turnMs } : {}),
            tools: e.turn?.tools ?? [],
            error: e.turn?.error,
          },
    );
}

export function cloneEntry(e: ChatEntry): ChatEntry {
  return {
    ...e,
    images: e.images?.map((img) => ({ ...img })),
    turn: e.turn ? { ...e.turn, tools: e.turn.tools.map((t) => ({ ...t })) } : undefined,
  };
}

/** The time in the history session list: today shows hours and minutes, older entries show month and day. */
export function formatSessionTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Size the composer to its content: two lines at rest (the CSS min-height),
 * up to twelve visible lines (the cap is in CSS, which then scrolls).
 *
 * `auto` first, then the content height: without the reset the element keeps
 * its previous height and `scrollHeight` cannot shrink after a deletion.
 */
export function fitInputHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** The summary line: the last line of non-empty text (the same logic as ZCode's resolveReasoningStreamingSummary). */
export function thinkingSummaryLine(thinking: string): string {
  const lines = thinking.replace(/\r\n?/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines[i]?.trim() ?? "";
    if (text) return text;
  }
  return "";
}

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
  ModelSelection,
  SavedSessionMeta,
  SessionModelConfig,
  StudyContent,
} from "@/lib/tauri";
import type { SessionNode } from "@/study/sessionTree";
import type { TranscriptLine } from "@/study/transcript";
import type { AgentUsage } from "@/study/agentUsage";
import type { SubagentRun } from "@/components/agent/subagents";

export interface ToolRecord {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  /** The screenshots the tool returns to the model with the result (a rendered preview for instance); they are only displayed. */
  images?: AgentImage[];
}

/**
 * One thinking block's seal. `end` is the offset in `Turn.thinking` where the
 * block stopped streaming: the boundary the panel needs to keep two blocks of
 * one round apart, and what the record checks before claiming a signature.
 */
export interface ThinkingSeal {
  end: number;
  signature: string;
}

/**
 * One row of a turn, in stream order.
 *
 * A thinking row references a range of `Turn.thinking` instead of copying the
 * text: the transcript flush and the seals both slice that one buffer, so a
 * second copy of the text could disagree with it mid-stream. An assistant
 * text row does the same against `Turn.text` — the model writes prose between
 * tool calls, and that prose belongs where it arrived, not glued to the end of
 * the turn.
 */
export type TurnStep =
  | {
      kind: "thinking";
      /** Range in `Turn.thinking` holding this block's text. */
      start: number;
      end: number;
      /** When the block's first delta arrived; null on a restored record (its duration is already sealed). */
      startedAt: number | null;
      /** Seconds the block took; null while the block is still streaming. */
      seconds: number | null;
    }
  | { kind: "text"; start: number; end: number }
  | { kind: "tool"; id: string };

export interface Turn {
  /** Streaming text buffer for the whole turn; the `text` steps index into it. */
  text: string;
  /** The streamed thinking process. Displayed in the panel and replayed into the model history (the MiniMax contract requires the thinking blocks back each round). */
  thinking: string;
  /** Seals of the thinking blocks closed so far, in stream order. */
  thinkingSeals: ThinkingSeal[];
  /**
   * The turn's rows in arrival order: thinking blocks, assistant text and tool
   * calls interleaved the way the provider streamed them (round one's thinking,
   * its text, its tool calls, round two's thinking, …). A restored record
   * rebuilds them from its per-round lines. Single writer: the panel's event
   * handler.
   */
  steps: TurnStep[];
  /** When the first event of the turn arrived (the "已工作 N 秒" duration starts here). */
  startedAt: number | null;
  /** The wall-clock duration of the whole turn, frozen when it ends. */
  turnMs: number | null;
  tools: ToolRecord[];
  /**
   * Why the turn ended, as the backend reported it (`aborted` when the user
   * pressed stop). Only the live turn carries it: a restored record has no
   * such marker, and the row reads its stored error instead.
   */
  stopReason: string | null;
  error?: string;
  // --- incremental transcript markers (single writer: the panel) ---
  /** How much of `text` is already on disk; the next flush writes the tail. */
  persistedTextLen: number;
  /** How much of `thinking` is already on disk. */
  persistedThinkLen: number;
  /** How many of `thinkingSeals` are already on disk. */
  persistedSealCount: number;
  /** How many of `tools` are already on disk (rounds flush in tool order). */
  persistedToolCount: number;
}

/**
 * The signature a record line may claim for the thinking text ending at
 * `end`. A record stores a round's thinking as ONE block, so a signature is
 * only honest when exactly one seal closes exactly there: with two
 * interleaved blocks (or a text still streaming) the seal covers only part of
 * the text, and replaying it would send the provider a seal that does not
 * match. MiniMax accepts the empty signature; a false one is the risk.
 */
export function thinkingSealFor(seals: ThinkingSeal[], end: number): string | undefined {
  if (seals.length !== 1) return undefined;
  return seals[0].signature && seals[0].end === end ? seals[0].signature : undefined;
}

/** An empty turn. `startedAt` starts the "已工作 N 秒" clock. */
export function newTurn(startedAt: number | null): Turn {
  return {
    text: "",
    thinking: "",
    thinkingSeals: [],
    steps: [],
    startedAt,
    turnMs: null,
    tools: [],
    stopReason: null,
    persistedTextLen: 0,
    persistedThinkLen: 0,
    persistedSealCount: 0,
    persistedToolCount: 0,
  };
}

/** A turn that carries only an error (the backend produced nothing before failing). */
export function errorTurn(message: string): Turn {
  return { ...newTurn(null), error: message };
}

/**
 * Appends a thinking delta: it extends the open block, or opens a new one when
 * the previous block is closed or a tool call ran in between. The open block is
 * the only one whose range may grow, so the last row is the only row that can
 * be the model's live thought.
 */
export function appendThinking(turn: Turn, text: string, at: number): void {
  const last = turn.steps[turn.steps.length - 1];
  const start = turn.thinking.length;
  turn.thinking += text;
  if (last && last.kind === "thinking" && last.seconds === null) {
    last.end = turn.thinking.length;
    return;
  }
  turn.steps.push({
    kind: "thinking",
    start,
    end: turn.thinking.length,
    startedAt: at,
    seconds: null,
  });
}

/**
 * Closes the open thinking block and freezes its duration: a seal, the first
 * text delta (the model moved on to writing), a tool call, or the turn's end.
 * Closing is idempotent so every one of those events can call it.
 */
export function closeThinking(turn: Turn, at: number): void {
  const last = turn.steps[turn.steps.length - 1];
  if (!last || last.kind !== "thinking" || last.seconds !== null) return;
  const startedAt = last.startedAt ?? at;
  last.seconds = Math.max(1, Math.round((at - startedAt) / 1000));
}

/** A tool call takes its place in the timeline; it closes the thinking block before it. */
export function pushToolStep(turn: Turn, id: string, at: number): void {
  closeThinking(turn, at);
  turn.steps.push({ kind: "tool", id });
}

/**
 * Appends an assistant text delta: it extends the open text row, or opens a
 * new one after whatever came before it (a tool call, a thinking block). The
 * text closes the thinking block in front of it — the same rule as
 * `pushToolStep`, so a row never spans two provider phases.
 */
export function appendText(turn: Turn, text: string, at: number): void {
  closeThinking(turn, at);
  const last = turn.steps[turn.steps.length - 1];
  const start = turn.text.length;
  turn.text += text;
  if (last && last.kind === "text") {
    last.end = turn.text.length;
    return;
  }
  turn.steps.push({ kind: "text", start, end: turn.text.length });
}

/**
 * The final text of the turn — the answer the panel shows outside the work
 * section — as a range of `Turn.text`; null when the turn ends on work.
 *
 * Only a **trailing** text row is the answer. Prose followed by more tools is
 * narration of the work, and it stays inside the section at its position: the
 * panel used to render one flattened buffer below the section, which pushed
 * every mid-turn sentence to the end of the reply (observed).
 */
export function answerRange(turn: Turn): { start: number; end: number } | null {
  const last = turn.steps[turn.steps.length - 1];
  if (!last || last.kind !== "text") return null;
  return { start: last.start, end: last.end };
}

/**
 * The duration of the thinking block that starts at `start` — the block a
 * transcript flush is about to write (the flush slices `thinking` from the
 * previous write's end, and a block never spans two rounds).
 */
export function thinkingSecondsAt(turn: Turn, start: number): number | null {
  for (const step of turn.steps) {
    if (step.kind === "thinking" && step.start === start) return step.seconds;
  }
  return null;
}

/** The seconds a record line of this turn should claim: the turn's one thinking block (restored turns have exactly one until they stream again). */
export function storedThinkSeconds(turn: Turn): number | null {
  for (const step of turn.steps) {
    if (step.kind === "thinking") return step.seconds;
  }
  return null;
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
  /**
   * The catalog selection this session runs on. It is the picker's single
   * source: switching the model mid-session replaces it (and `model` with the
   * new snapshot), and a not-yet-started session carries the choice the next
   * start uses.
   */
  selection?: ModelSelection | null;
  /** The token usage of the last model request (the context usage = input + output). */
  usage: AgentUsage | null;
  /**
   * Subagent runs this conversation dispatched (oldest first), for the
   * overview strip. Absent = none: a restored session does not replay the
   * agents of a past run (their transcripts stay on disk under
   * `<session>/subagents/`).
   */
  agents?: SubagentRun[];
  /**
   * Set on a conv that *is* a subagent's live transcript: the run it belongs
   * to. Its `sessionId` is the child session id, so the child's own events
   * route here through the regular session lookup.
   */
  agent?: SubagentRun;
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
  const thinking = line.thinking ?? "";
  const tools = line.tools ?? [];
  // The record line is one provider round: its thinking came first, then the
  // prose the model wrote before its tool calls, then the calls themselves
  // (the writer flushes a round's text together with that round's tools), so
  // the restored rows need no other ordering source.
  const steps: TurnStep[] = [];
  if (thinking) {
    steps.push({
      kind: "thinking",
      start: 0,
      end: thinking.length,
      startedAt: null,
      seconds: line.thinkSeconds ?? null,
    });
  }
  if (line.text) steps.push({ kind: "text", start: 0, end: line.text.length });
  for (const tool of tools) steps.push({ kind: "tool", id: tool.id });
  return {
    role: "assistant",
    text: line.text,
    at: line.at,
    items: null,
    turn: {
      text: line.text,
      thinking,
      // A stored signature seals the whole stored thinking text (that is the
      // only shape the writer emits), so it comes back as one closed block.
      thinkingSeals: line.thinkingSignature
        ? [{ end: thinking.length, signature: line.thinkingSignature }]
        : [],
      steps,
      startedAt: null,
      turnMs: line.turnMs ?? null,
      tools,
      // The record does not store why a turn ended, and an interrupted turn
      // is indistinguishable from a finished one on disk: claiming "aborted"
      // here would lie about every restored reply.
      stopReason: null,
      error: line.error,
      // A restored turn never streams again: its record is complete on disk.
      persistedTextLen: line.text.length,
      persistedThinkLen: thinking.length,
      persistedSealCount: line.thinkingSignature ? 1 : 0,
      persistedToolCount: tools.length,
    },
  };
}

/** A UI message turned into a session record line (when forking, the prefix of the parent session is written into the new file). */
export function entriesToLines(entries: ChatEntry[]): TranscriptLine[] {
  // Notice entries are display-only status lines, never transcript content.
  return entries
    .filter((e) => e.role !== "notice")
    .map((e): TranscriptLine => {
      if (e.role === "user") return { type: "user", at: e.at, text: e.text, images: e.images };
      const thinkingSignature = e.turn
        ? thinkingSealFor(e.turn.thinkingSeals, e.turn.thinking.length)
        : undefined;
      return {
        type: "assistant",
        at: e.at,
        text: e.text,
        thinking: e.turn?.thinking ?? "",
        ...(thinkingSignature ? { thinkingSignature } : {}),
        thinkSeconds: e.turn ? storedThinkSeconds(e.turn) : null,
        // The key only exists when a real duration was measured: an absent
        // field keeps the line format lean (the same rule as `images`).
        ...(e.turn?.turnMs != null ? { turnMs: e.turn.turnMs } : {}),
        tools: e.turn?.tools ?? [],
        error: e.turn?.error,
      };
    });
}

export function cloneEntry(e: ChatEntry): ChatEntry {
  return {
    ...e,
    images: e.images?.map((img) => ({ ...img })),
    turn: e.turn
      ? {
          ...e.turn,
          tools: e.turn.tools.map((t) => ({ ...t })),
          thinkingSeals: e.turn.thinkingSeals.map((s) => ({ ...s })),
          steps: e.turn.steps.map((s) => ({ ...s })),
        }
      : undefined,
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

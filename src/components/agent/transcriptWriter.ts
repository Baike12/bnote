/**
 * The session record writer: every append to one conv's transcript goes
 * through this module, in queue order.
 *
 * Two files' worth of state used to live beside the panel for this: the append
 * chain (two concurrent IPC writes to one file can land out of order — and a
 * title rewrite racing an append silently drops the line) and the "metadata
 * line already written" flag. Both are private bookkeeping of the writer, so
 * they live here; the panel only tells it where a conv's record is.
 */

import type { SessionModelConfig } from "@/lib/tauri";
import { transcriptIO } from "@/study/transcriptIO";
import {
  assistantRoundLine,
  serializeTranscript,
  userWriteLines,
  type TranscriptUserLine,
} from "@/study/transcript";
import { thinkingSealFor, thinkingSecondsAt, type Turn } from "@/components/agent/model";

export interface TranscriptWriterDeps {
  /** Where this conv's record file is (null while there is none yet). */
  pathOf(convKey: string): string | undefined;
  /** Whether the record lives in the agent home (`~/.bnote`) instead of the vault. */
  homeOf(convKey: string): boolean;
  /** The model config snapshot of the session (written into the metadata line). */
  modelOf(convKey: string): SessionModelConfig | null;
  /** The saved-session list changed (the history drawer reads it). */
  refreshSessions(): void;
}

export interface TranscriptWriter {
  /**
   * Queue a mutation of one record. Appends are fire-and-forget for the UI,
   * but every mutation of a file chains through here, so the file order is the
   * mutation order (single writer per record).
   */
  enqueue(convKey: string, op: () => Promise<unknown>, warn: string): void;
  /** Append the user message the moment the backend accepted the send. */
  persistUserLine(convKey: string, user: TranscriptUserLine): void;
  /** Flush the turn's finished tail (one line per provider round). */
  persistTurn(convKey: string, turn: Turn, pathOverride?: string, force?: boolean): void;
  /**
   * Append the model a session switched to. The record stays append-only; a
   * restore takes the last such line, so the session continues on the model it
   * ended on.
   */
  persistModelLine(convKey: string, model: SessionModelConfig): void;
  /** Start path: the metadata line is (or a restored record already has it) on disk. */
  markMetaWritten(convKey: string, written: boolean): void;
}

export function createTranscriptWriter(deps: TranscriptWriterDeps): TranscriptWriter {
  /** convKey -> the tail of that record's mutation chain. */
  const chains = new Map<string, Promise<void>>();
  /** convKey -> whether the metadata line (title + model snapshot) is already on disk. */
  const metaWritten = new Map<string, boolean>();

  function enqueue(convKey: string, op: () => Promise<unknown>, warn: string): void {
    const prev = chains.get(convKey) ?? Promise.resolve();
    const next = prev
      .then(op)
      .then(() => void deps.refreshSessions())
      .catch((e) => console.warn(warn, e));
    chains.set(convKey, next);
  }

  function append(convKey: string, path: string, data: string): void {
    enqueue(
      convKey,
      () => transcriptIO(deps.homeOf(convKey)).append(path, data),
      "[agent] failed to write the session record",
    );
  }

  function markMetaWritten(convKey: string, written: boolean): void {
    metaWritten.set(convKey, written);
  }

  function persistUserLine(convKey: string, user: TranscriptUserLine): void {
    const path = deps.pathOf(convKey);
    if (!path) return;
    const firstWrite = !metaWritten.get(convKey);
    if (firstWrite) markMetaWritten(convKey, true);
    const lines = userWriteLines({ user, first: firstWrite, model: deps.modelOf(convKey) });
    append(convKey, path, serializeTranscript(lines));
  }

  function persistTurn(convKey: string, turn: Turn, pathOverride?: string, force = true): void {
    const path = pathOverride ?? deps.pathOf(convKey);
    if (!path) return;
    if (!force) {
      // Only a finished previous round closes here: a flush on a stream delta
      // with no complete pending batch would cut the current round mid-stream
      // (and fragment one round into several lines).
      const pending = turn.tools.slice(turn.persistedToolCount);
      if (pending.length === 0 || pending.some((t) => t.output === undefined)) return;
    }
    const startTool = turn.persistedToolCount;
    const startThink = turn.persistedThinkLen;
    const tools = turn.tools.slice(startTool);
    const text = turn.text.slice(turn.persistedTextLen);
    const thinking = turn.thinking.slice(startThink);
    const fresh = tools.length > 0 || text.length > 0 || thinking.length > 0 || turn.error;
    if (!fresh) return;
    // The seal(s) that closed with this slice. A flush happens before the next
    // round appends anything, so `turn.thinking.length` is exactly where this
    // round's text ends.
    const thinkingSignature = thinkingSealFor(
      turn.thinkingSeals.slice(turn.persistedSealCount),
      turn.thinking.length,
    );
    turn.persistedToolCount = turn.tools.length;
    turn.persistedTextLen = turn.text.length;
    turn.persistedThinkLen = turn.thinking.length;
    turn.persistedSealCount = turn.thinkingSeals.length;
    const firstWrite = !metaWritten.get(convKey);
    if (firstWrite) markMetaWritten(convKey, true);
    const line = assistantRoundLine({
      at: Date.now(),
      text,
      thinking: thinking || undefined,
      thinkingSignature,
      // The flushed slice is exactly one thinking block: its own duration goes
      // into the line, so a restored round shows the real "持续了 N 秒".
      thinkSeconds: thinking ? thinkingSecondsAt(turn, startThink) : null,
      turnMs: turn.turnMs,
      tools,
      error: turn.error,
    });
    append(convKey, path, serializeTranscript([line]));
  }

  function persistModelLine(convKey: string, model: SessionModelConfig): void {
    const path = deps.pathOf(convKey);
    if (!path) return;
    append(convKey, path, serializeTranscript([{ type: "model", at: Date.now(), model }]));
  }

  return { enqueue, persistUserLine, persistTurn, persistModelLine, markMetaWritten };
}

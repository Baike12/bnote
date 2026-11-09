/**
 * The agent stream reducer: one backend event in, the conversation's entries
 * and its record line out.
 *
 * The panel owns the state (convs, the live turns, the busy flag); this module
 * owns the rules for what an event does to them. It is the single writer of
 * `Turn` (through the pure helpers in `model.ts`) and it decides when a round
 * closes, which is what keeps the interleaved work rows and the per-round
 * record lines in agreement.
 */

import type { AgentEvent } from "@/lib/tauri";
import type { ApprovalRequest } from "@/components/agent/ApprovalCard";
import { parseQuestions, type PendingQuestion } from "@/components/agent/QuestionCard";
import {
  appendThinking,
  closeThinking,
  errorTurn,
  findConvBySession,
  newTurn,
  pushToolStep,
  type ChatEntry,
  type Conv,
  type Turn,
} from "@/components/agent/model";

export interface StreamContext {
  /** The conversations as they are now (a switched-away session still finds its owner). */
  convs(): Conv[];
  /** convKey -> the live turn (streaming only). */
  turns: Map<string, Turn>;
  /** sessionId -> the conv and record the closing events of a switched-away session must still be written to. */
  sessionIndex: Map<string, { convKey: string; path: string | null; home: boolean }>;
  patchConvs(patch: (prev: Conv[]) => Conv[]): void;
  updateConv(key: string, patch: (c: Conv) => Conv): void;
  /** The single record writer (`transcriptWriter`). */
  persistTurn(convKey: string, turn: Turn, pathOverride?: string, force?: boolean): void;
  /** The session stopped generating (turn_end / error). */
  clearBusy(sessionId: string): void;
  setApproval(approval: ApprovalRequest | null): void;
  setPendingQuestion(question: PendingQuestion | null): void;
  setPlanActive(active: boolean): void;
  /** A whole turn finished successfully: the caller may name the session now. */
  onTurnClosed?(convKey: string): void;
  /** The event was handled: let the on-screen transcript follow (scroll). */
  afterEvent(convKey: string): void;
}

export function createStreamHandler(
  ctx: StreamContext,
): (sessionId: string, event: AgentEvent) => void {
  function ensureTurn(convKey: string): Turn {
    let turn = ctx.turns.get(convKey);
    if (!turn) {
      turn = newTurn(Date.now());
      ctx.turns.set(convKey, turn);
    }
    return turn;
  }

  /** Replace the streaming draft in place (a second append put every reply twice). */
  function writeEntries(convKey: string, turn: Turn, finalize: boolean, items: number | null) {
    ctx.patchConvs((prev) =>
      prev.map((c) => {
        if (c.key !== convKey) return c;
        const entries = c.entries.slice();
        const draft: ChatEntry = {
          role: "assistant",
          text: turn.text,
          at: Date.now(),
          turn,
          items,
        };
        const last = entries[entries.length - 1];
        if (last && last.role === "assistant" && last.turn === turn) {
          entries[entries.length - 1] = finalize ? { ...draft } : draft;
        } else {
          entries.push(draft);
        }
        return { ...c, entries };
      }),
    );
  }

  /** The turn's end: freeze the clock, hand the draft over and write its tail. */
  function commitTurn(convKey: string, items: number | null) {
    const turn = ctx.turns.get(convKey);
    if (!turn) return;
    // A block still open when the turn ends gets its duration frozen here; the
    // row keeps showing the measured seconds instead of "正在思考" forever.
    closeThinking(turn, Date.now());
    if (turn.turnMs == null && turn.startedAt != null) {
      turn.turnMs = Date.now() - turn.startedAt;
    }
    ctx.turns.delete(convKey);
    writeEntries(convKey, turn, true, items);
    ctx.persistTurn(convKey, turn);
  }

  return function handleAgentEvent(sessionId: string, event: AgentEvent): void {
    const conv = findConvBySession(ctx.convs(), sessionId);
    if (!conv) {
      // The session is no longer in the list (a new material / the old sessions
      // are void after a restart): the streaming deltas are dropped harmlessly,
      // but the **terminating event must clear the busy flag** — otherwise the
      // panel stays on "generating" forever and the next send is silently
      // swallowed by the busy ref. What this round already produced is still
      // written into its own session record: the user only switched away from
      // the material, the answer must not be lost.
      if (event.type === "turn_end" || event.type === "error") {
        const entry = ctx.sessionIndex.get(sessionId);
        if (entry) {
          const turn = ctx.turns.get(entry.convKey);
          if (turn) {
            if (event.type === "error") turn.error = event.message;
            closeThinking(turn, Date.now());
            if (turn.turnMs == null && turn.startedAt != null) {
              turn.turnMs = Date.now() - turn.startedAt;
            }
            ctx.turns.delete(entry.convKey);
            ctx.persistTurn(entry.convKey, turn, entry.path ?? undefined);
          }
          ctx.sessionIndex.delete(sessionId);
        }
        ctx.clearBusy(sessionId);
      }
      return;
    }
    switch (event.type) {
      case "thinking_delta": {
        const turn = ensureTurn(conv.key);
        // A delta after a finished tool batch opens the next provider round:
        // what came before is complete, write it before the tail grows.
        ctx.persistTurn(conv.key, turn, undefined, false);
        appendThinking(turn, event.text, Date.now());
        writeEntries(conv.key, turn, false, null);
        break;
      }
      case "thinking_block_end": {
        // The seal is only stored, never shown: it rides on the record line so
        // a restored session replays the thinking block exactly as received.
        const turn = ctx.turns.get(conv.key);
        if (turn) {
          turn.thinkingSeals.push({ end: turn.thinking.length, signature: event.signature });
          closeThinking(turn, Date.now());
        }
        break;
      }
      case "text_delta": {
        const turn = ensureTurn(conv.key);
        ctx.persistTurn(conv.key, turn, undefined, false);
        // The model moved from thinking to writing: the block's duration is
        // now known, and a further thinking delta opens a new row.
        closeThinking(turn, Date.now());
        turn.text += event.text;
        writeEntries(conv.key, turn, false, null);
        break;
      }
      case "tool_start": {
        const turn = ensureTurn(conv.key);
        // The new call belongs to the next assistant message: the previous
        // round's outputs are all in (the backend runs a batch to completion
        // before the next stream round) — flush it.
        ctx.persistTurn(conv.key, turn, undefined, false);
        turn.tools = [...turn.tools, { id: event.id, name: event.name, input: event.input }];
        pushToolStep(turn, event.id, Date.now());
        writeEntries(conv.key, turn, false, null);
        break;
      }
      case "tool_end": {
        const turn = ctx.turns.get(conv.key);
        if (!turn) break;
        turn.tools = turn.tools.map((t) =>
          t.id === event.id
            ? { ...t, output: event.output, ok: event.ok, images: event.images }
            : t,
        );
        writeEntries(conv.key, turn, false, null);
        break;
      }
      case "usage": {
        ctx.updateConv(conv.key, (c) => ({
          ...c,
          usage: { input: event.input, output: event.output, cacheRead: event.cacheRead },
        }));
        break;
      }
      case "notice": {
        // A dim status line (compaction / subagent / background task). It is
        // display-only: it never reaches the transcript and a restore drops it.
        ctx.updateConv(conv.key, (c) => ({
          ...c,
          entries: [
            ...c.entries,
            { role: "notice", text: event.text, at: Date.now(), items: null },
          ],
        }));
        break;
      }
      case "todos": {
        ctx.updateConv(conv.key, (c) => ({ ...c, todos: event.todos }));
        break;
      }
      case "permission_request": {
        ctx.setApproval({
          sessionId,
          id: event.id,
          tool: event.tool,
          input: event.input,
        });
        break;
      }
      case "question": {
        ctx.setPendingQuestion({
          sessionId,
          id: event.id,
          questions: parseQuestions(event.questions),
        });
        break;
      }
      case "plan_mode": {
        ctx.setPlanActive(event.enabled);
        ctx.updateConv(conv.key, (c) => ({
          ...c,
          entries: [
            ...c.entries,
            {
              role: "notice",
              text: event.enabled
                ? "已进入计划模式:先只读调研,计划批准后才改文件"
                : "计划已批准,恢复编辑",
              at: Date.now(),
              items: null,
            },
          ],
        }));
        break;
      }
      case "tasks": {
        // The v2 task list has no dedicated panel: the tool cards already show
        // every change, and the list itself lives in the model's context.
        break;
      }
      case "turn_end": {
        // The reason is what the user needs to read: a turn they stopped must
        // not be labelled as one that finished.
        const ended = ctx.turns.get(conv.key);
        if (ended) ended.stopReason = event.reason;
        commitTurn(conv.key, event.items);
        ctx.onTurnClosed?.(conv.key);
        ctx.clearBusy(sessionId);
        break;
      }
      case "error": {
        const turn = ctx.turns.get(conv.key);
        if (turn) {
          turn.error = event.message;
          commitTurn(conv.key, event.items);
        } else {
          const failed = errorTurn(event.message);
          ctx.updateConv(conv.key, (c) => ({
            ...c,
            entries: [
              ...c.entries,
              {
                role: "assistant",
                text: "",
                at: Date.now(),
                items: event.items > 0 ? event.items : null,
                turn: failed,
              },
            ],
          }));
          ctx.persistTurn(conv.key, failed);
        }
        ctx.clearBusy(sessionId);
        break;
      }
    }
    ctx.afterEvent(conv.key);
  };
}

import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { AgentTodoItem } from "@/lib/tauri";
import type { CodeProjectRef } from "@/state/appStore";
import { HtmlPreview } from "@/components/agent/HtmlPreview";
import { splitAgentMarkdown } from "@/study/agentMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  canonicalToolName,
  stripAgentTrailer,
  toolSummary,
  workDurationLabel,
} from "./toolSummary";
import { answerRange, type ChatEntry, type ToolRecord, type Turn, type TurnStep } from "./model";

/** The empty state: what this session is for, by mode. */
export function AgentWelcome({
  mode,
  creativeMode,
  codeProject,
}: {
  mode: "notes" | "study" | "code" | "projects";
  creativeMode: boolean;
  codeProject: CodeProjectRef | null;
}) {
  return (
    <div className="agent-welcome">
      <div className="agent-welcome-icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
        </svg>
      </div>
      <p className="agent-welcome-title">
        {mode === "code"
          ? codeProject
            ? "编码模式:我直接读写当前代码仓库并运行命令"
            : "先在中栏打开一个代码项目"
          : creativeMode
            ? "创作模式:生成 HTML 会在中栏实时预览"
            : "问我关于当前 PDF / 网页的问题"}
      </p>
      <p className="agent-hint">
        {mode === "code"
          ? codeProject
            ? "输入 / 调用命令与技能、@ 引用项目文件;悬停消息点「⤷」可分叉"
            : "项目目录就是我的工作区,会话记录存放在 ~/.bnote"
          : creativeMode
            ? "输入 / 调用技能、@ 引用仓库文件;满意后点中栏的「发布」推到 bblog"
            : "悬停任意消息点「⤷」,可以从那里分叉一条辅助会话"}
      </p>
    </div>
  );
}

/**
 * One tool call, ZCode's ToolSummaryRow: a single line — category word (a
 * shimmer sweep while running, never a spinner: dozens of cards update per
 * turn and rotating loaders would keep re-rendering), the primary text, the
 * Edit +N/−N counts, the failure word only when it failed — and the raw IO
 * collapsed inside.
 */
function ToolCard({ tool }: { tool: ToolRecord }) {
  const running = tool.ok === undefined;
  const summary = toolSummary(tool.name, tool.input, running);
  // An Agent's output is model-addressed (it carries the agent id for a later
  // SendMessage); the card is read by the user, so the id line is dropped.
  const output =
    tool.output !== undefined && canonicalToolName(tool.name) === "Agent"
      ? stripAgentTrailer(tool.output)
      : tool.output;
  return (
    <details
      className="agent-tool"
      data-status={running ? "running" : tool.ok === false ? "fail" : "ok"}
    >
      <summary>
        <span className={`agent-tool-kind${running ? " is-running" : ""}`}>{summary.kind}</span>
        {summary.primary && <span className="agent-tool-primary">{summary.primary}</span>}
        {summary.diff && (
          <span className="agent-tool-diff">
            <span className="is-added">+{summary.diff.added}</span>
            <span className="is-removed">−{summary.diff.removed}</span>
          </span>
        )}
        {tool.ok === false && <span className="agent-tool-fail">失败</span>}
        <svg
          className="agent-tool-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </summary>
      <pre className="agent-tool-io">
        {JSON.stringify(tool.input, null, 2)}
        {output !== undefined && `\n→ ${output}`}
      </pre>
      {tool.images && tool.images.length > 0 && (
        <div className="agent-msg-images">
          {tool.images.map((img, j) => (
            <img
              key={j}
              className="agent-msg-image"
              src={`data:${img.mediaType};base64,${img.data}`}
              alt="工具返回的截图"
            />
          ))}
        </div>
      )}
    </details>
  );
}

/**
 * The work rows in the order the provider streamed them: each thinking block
 * and each piece of assistant prose sits between the tool calls that ran
 * before and after it, so the section reads like the turn actually went
 * (thinking → text → tools → thinking → …) instead of one thought pinned above
 * every tool row. The open block — the last thinking row, still without a
 * duration — is the only one drawn as streaming.
 */
function TurnSteps({
  turn,
  steps,
  streaming,
}: {
  turn: Turn;
  steps: TurnStep[];
  streaming: boolean;
}) {
  const tools = new Map(turn.tools.map((tool) => [tool.id, tool]));
  return (
    <>
      {steps.map((step, i) => {
        if (step.kind === "thinking") {
          return (
            <ThinkingBlock
              key={i}
              thinking={turn.thinking.slice(step.start, step.end)}
              streaming={streaming && step.seconds === null}
              seconds={step.seconds}
            />
          );
        }
        if (step.kind === "text") {
          return <AssistantText key={i} text={turn.text.slice(step.start, step.end)} />;
        }
        const tool = tools.get(step.id);
        return tool ? <ToolCard key={i} tool={tool} /> : null;
      })}
    </>
  );
}

/** One assistant prose row: the same renderer as a reply body, wherever it sits in the turn. */
const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  // The parse (and KaTeX for every formula) is pure per text: without this it
  // re-runs for every row on every panel render — each composer keystroke, an
  // agent/content swap, a settings patch.
  const blocks = useMemo(() => splitAgentMarkdown(text), [text]);
  return (
    <div className="agent-md">
      {blocks.map((block, bi) =>
        block.kind === "html" ? (
          <HtmlPreview key={bi} code={block.code} />
        ) : (
          <div key={bi} dangerouslySetInnerHTML={{ __html: block.html }} />
        ),
      )}
    </div>
  );
});

/**
 * The collapsible around a turn's working process (ZCode's
 * ConversationWorkSegmentFlow): thinking, prose and tool cards live inside in
 * stream order, the final markdown stays outside and is always visible. While
 * the turn streams it is open ("工作中", ticking); when the turn ends it
 * auto-collapses to "已工作 N 秒" unless the user opened it by hand — their
 * choice wins, the same rule as ThinkingBlock. A turn that failed, that the
 * user stopped, or that ends on work instead of an answer stays open: the
 * intermediate rows are all there is to read.
 */
function TurnWork({
  entry,
  streaming,
  answer,
  children,
}: {
  entry: ChatEntry;
  streaming: boolean;
  /** Whether the turn ends on an answer drawn outside this section (nothing is lost when it collapses). */
  answer: boolean;
  children: ReactNode;
}) {
  const turn = entry.turn;
  const hasWork = Boolean(turn && (turn.tools.length > 0 || turn.thinking));
  const interactedRef = useRef(false);
  const [open, setOpen] = useState(streaming);
  const [now, setNow] = useState(() => Date.now());

  // The tick only runs while a live turn is collapsed-irrelevant (streaming):
  // one second of interval for at most the last turn, instead of one per card.
  useEffect(() => {
    if (!streaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  // Streaming → done edge: collapse once (ZCode's assistantHistoryDefaultOpen
  // flip). A turn that failed, was stopped, or left no answer outside stays
  // open — the work rows are all there is to read.
  useEffect(() => {
    if (!streaming && !interactedRef.current) {
      setOpen(Boolean(turn?.error) || turn?.stopReason === "aborted" || !answer);
    }
  }, [streaming, turn?.error, turn?.stopReason, answer]);

  if (!turn || !hasWork) return <>{children}</>;
  const liveMs = streaming && turn.startedAt != null ? now - turn.startedAt : (turn.turnMs ?? null);
  return (
    <details
      className={`agent-turn-work${streaming ? " is-streaming" : ""}`}
      open={open}
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        // Opening anything inside (a tool, the thinking) is the user inspecting
        // the work: their choice keeps the section open when the turn ends.
        if (next) interactedRef.current = true;
        // React dispatches a descendant's toggle to ancestor onToggle handlers
        // too; only this details' own toggle may write its open state, or
        // collapsing one tool would collapse the whole section (one writer).
        if (e.target !== e.currentTarget) return;
        setOpen(next);
      }}
    >
      <summary>
        <span className={`agent-turn-work-label${streaming ? " is-running" : ""}`}>
          {streaming
            ? "工作中"
            : turn.stopReason === "aborted"
              ? "已停止"
              : turn.error
                ? "已出错"
                : "已工作"}
          {(liveMs != null || turn.turnMs != null) && ` · ${workDurationLabel(liveMs)}`}
        </span>
        <svg
          className="agent-tool-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </summary>
      <div className="agent-turn-work-body">{children}</div>
    </details>
  );
}

/**
 * One entry row; `streaming` marks the live assistant reply (caret + thinking).
 *
 * Memoized: the panel re-renders on every composer keystroke and on every
 * agent/content swap, and re-walking the whole transcript there (markdown
 * parse, KaTeX, image rows) is wasted work — only the row whose entry changed
 * has anything new to draw. `onFork` therefore takes the index instead of a
 * freshly built closure, so its identity stays put.
 */
const EntryRow = memo(function EntryRow({
  entry,
  index,
  streaming,
  forkable,
  onFork,
}: {
  entry: ChatEntry;
  index: number;
  streaming: boolean;
  forkable: boolean;
  onFork: (index: number) => void;
}) {
  const turn = entry.turn;
  // The turn's trailing text is the answer and is drawn outside the work
  // section; everything before it is the process and keeps its stream order
  // inside. A turn that ends on work has no answer row at all (its prose stays
  // where it was written).
  const answer = turn ? answerRange(turn) : null;
  const processSteps = turn ? (answer ? turn.steps.slice(0, -1) : turn.steps) : [];
  const answerText = !turn ? entry.text : answer ? turn.text.slice(answer.start, answer.end) : "";
  return (
    <div className={`agent-msg-row${entry.role === "user" ? " is-user" : ""}`}>
      {entry.role === "notice" ? (
        <div className="agent-notice">{entry.text}</div>
      ) : entry.role === "user" ? (
        <div className="agent-msg agent-msg-user">
          {entry.images && entry.images.length > 0 && (
            <div className="agent-msg-images">
              {entry.images.map((img, j) => (
                <img
                  key={j}
                  className="agent-msg-image"
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt="随消息发送的图片"
                />
              ))}
            </div>
          )}
          {entry.text}
        </div>
      ) : (
        <div className="agent-msg agent-msg-assistant">
          <TurnWork entry={entry} streaming={streaming} answer={answerText !== ""}>
            {turn && <TurnSteps turn={turn} steps={processSteps} streaming={streaming} />}
            {turn?.error && <div className="agent-error">{turn.error}</div>}
          </TurnWork>
          {/* The answer row: the turn's trailing text. A turn that ends on
              tools has no such row — its prose stays inside the section, in
              position (an empty container would render as a blank bubble, so
              nothing is drawn when there is no text). */}
          {answerText && <AssistantText text={answerText} />}
          {streaming && <span className="agent-caret" aria-hidden="true" />}
        </div>
      )}
      {forkable && (
        <button
          className="agent-fork"
          title="基于这条消息开启辅助会话"
          onClick={() => onFork(index)}
        >
          ⤷
        </button>
      )}
    </div>
  );
});

/**
 * The scrolling conversation body: the welcome state when there is nothing
 * yet, otherwise the entries. Only the last assistant entry can be the live
 * one (the panel's `busy` session and this entry being last).
 */
export function AgentTranscript({
  scrollRef,
  entries,
  busy,
  welcome,
  onFork,
  allowFork = true,
}: {
  scrollRef: Ref<HTMLDivElement>;
  entries: ChatEntry[];
  busy: boolean;
  welcome: ReactNode;
  onFork: (index: number) => void;
  /** A subagent's transcript is read-only: no fork handles (its session is not the app's to fork). */
  allowFork?: boolean;
}) {
  // The shade lives in a sibling overlay, not inside the scroller: an absolute
  // child of a scroll container would scroll away with the content. It is the
  // same "already read" veil as the PDF pane (.pdf-read-shade), fixed to the
  // top half of the visible column.
  return (
    <div className="agent-transcript-wrap">
      <div className="agent-scroll" ref={scrollRef}>
        {entries.length === 0
          ? welcome
          : entries.map((entry, i) => (
              <EntryRow
                key={i}
                entry={entry}
                index={i}
                streaming={i === entries.length - 1 && busy && entry.role === "assistant"}
                forkable={allowFork && !busy}
                onFork={onFork}
              />
            ))}
      </div>
      <div className="agent-read-guide" aria-hidden="true">
        <div className="agent-read-shade" />
      </div>
    </div>
  );
}

/** The todo tool's latest list, above the composer. */
export function AgentTodos({ todos }: { todos: AgentTodoItem[] }) {
  if (todos.length === 0) return null;
  return (
    <div className="agent-todos" aria-label="任务清单">
      {todos.map((t) => (
        <div key={t.content} className={`agent-todo is-${t.status}`}>
          <span className="agent-todo-mark" aria-hidden="true">
            {t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}
          </span>
          <span className="agent-todo-text">
            {t.status === "in_progress" ? t.active_form : t.content}
          </span>
        </div>
      ))}
    </div>
  );
}
